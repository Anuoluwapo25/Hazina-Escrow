/**
 * SEP-10 (Sign in with Stellar) service.
 *
 * The only module that touches the Stellar SDK for web-auth. Every SDK call
 * happens inside a function (never at module load), so importing this module is
 * safe even in test suites that mock `@stellar/stellar-sdk` down to `{ StrKey }`
 * — those tests never reach the SEP-10 code path, so `Keypair`/`TransactionBuilder`
 * are simply never dereferenced.
 */

import crypto from 'crypto';
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk';
import { HORIZON_URL, getNetworkPassphrase } from '../lib/stellar.config';
import {
  getConfiguredWebAuthDomain,
  getFallbackAuthDomain,
  getSep10ChallengeTtlSeconds,
  getSep10JwtTtlSeconds,
  getWebAuthJwtSecret,
  getWebAuthSigningSecret,
  validateHomeDomain,
} from './sep10.config';
import { mintSep10Jwt } from './sep10.jwt';
import type { Sep10NonceStore } from './nonce.store';

export class Sep10Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'Sep10Error';
  }
}

export interface SignerSummary {
  threshold: number;
  signers: Array<{ key: string; weight: number }>;
}

/** Resolves the current authorized signer set for an account (multisig support). */
export type SignerResolver = (accountId: string) => Promise<SignerSummary>;

/** The web-auth signing keypair, derived lazily so missing secrets fail at use time. */
export function getWebAuthServerKeypair(): Keypair {
  return Keypair.fromSecret(getWebAuthSigningSecret());
}

export function getWebAuthServerPublicKey(): string {
  return getWebAuthServerKeypair().publicKey();
}

/**
 * Network passphrase used for the challenge transaction. Honors an explicit
 * STELLAR_NETWORK_PASSPHRASE override (e.g. a custom network) and otherwise
 * follows the configured STELLAR_NETWORK.
 */
export function getSep10NetworkPassphrase(): string {
  const override = (process.env.STELLAR_NETWORK_PASSPHRASE ?? '').trim();
  return override || getNetworkPassphrase();
}

/**
 * The domain this server issues challenges for. Prefers the configured
 * WEB_AUTH_DOMAIN, falls back to the host of PUBLIC_BASE_URL, then to the
 * incoming request host, then to a fixed last-resort fallback.
 */
export function resolveWebAuthDomain(requestHost?: string): string {
  const configured = getConfiguredWebAuthDomain();
  if (configured) return configured;
  if (requestHost) {
    const hostname = (requestHost.split(':')[0] ?? '').trim().toLowerCase();
    if (hostname) return hostname;
  }
  return getFallbackAuthDomain();
}

export function isValidClientAccount(accountId: string): boolean {
  if (accountId.startsWith('M')) return StrKey.isValidMed25519PublicKey(accountId);
  return StrKey.isValidEd25519PublicKey(accountId);
}

/** Normalizes a client account to its underlying G… ed25519 address (muxed M… → G…). */
export function toEd25519PublicKey(accountId: string): string {
  if (accountId.startsWith('M')) {
    // decodeMed25519PublicKey returns a 40-byte buffer: 32-byte ed25519 key + 8-byte id.
    const decoded = StrKey.decodeMed25519PublicKey(accountId);
    return StrKey.encodeEd25519PublicKey(decoded.subarray(0, 32));
  }
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Sep10Error(`Invalid Stellar account "${accountId}"`, 400);
  }
  return accountId;
}

function resolveHomeDomain(supplied: string | undefined, requestHost?: string): string {
  const effective = resolveWebAuthDomain(requestHost);
  if (supplied !== undefined && supplied !== '') {
    if (!validateHomeDomain(supplied)) {
      throw new Sep10Error(`Invalid home domain "${supplied}"`, 400);
    }
    const normalized = supplied.toLowerCase();
    if (normalized !== effective) {
      throw new Sep10Error(
        `Home domain "${normalized}" does not match this server's domain "${effective}"`,
        400,
      );
    }
    return normalized;
  }
  return effective;
}

export interface CreatedChallenge {
  transaction: string;
  nonce: string;
  homeDomain: string;
  expiresAtSec: number;
}

export async function createChallenge(input: {
  clientAccountId: string;
  homeDomain?: string;
  requestHost?: string;
  nowMs?: number;
  store: Sep10NonceStore;
}): Promise<CreatedChallenge> {
  const nowMs = input.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  if (!isValidClientAccount(input.clientAccountId)) {
    throw new Sep10Error(`Invalid client account "${input.clientAccountId}"`, 400);
  }

  const homeDomain = resolveHomeDomain(input.homeDomain, input.requestHost);
  const webAuthDomain = resolveWebAuthDomain(input.requestHost);
  const serverKp = getWebAuthServerKeypair();
  const nonce = crypto.randomBytes(48).toString('base64');
  const ttl = getSep10ChallengeTtlSeconds();

  const account = new Account(serverKp.publicKey(), '-1');
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getSep10NetworkPassphrase(),
    timebounds: { minTime: nowSec, maxTime: nowSec + ttl },
  })
    .addOperation(
      Operation.manageData({
        name: `${homeDomain} auth`,
        value: nonce,
        source: input.clientAccountId,
      }),
    )
    .addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: webAuthDomain,
        source: serverKp.publicKey(),
      }),
    );

  const transaction = builder.build();
  transaction.sign(serverKp);
  const xdr = transaction.toEnvelope().toXDR('base64').toString();

  await input.store.createNonce({
    nonce,
    clientAccount: toEd25519PublicKey(input.clientAccountId),
    homeDomain,
    expiresAt: nowSec + ttl,
    now: nowSec,
  });

  return { transaction: xdr, nonce, homeDomain, expiresAtSec: nowSec + ttl };
}

export interface VerifiedChallenge {
  clientAccountId: string;
  matchedHomeDomain: string;
  nonce: string;
}

/**
 * Verifies a signed challenge end to end:
 * 1. readChallengeTx validates structure, server signature, home domain, web
 *    auth domain, nonce shape (48-byte base64), and SDK timebounds (5-min grace).
 * 2. A strict timebounds check (no grace) rejects challenges presented before
 *    `minTime` or after `maxTime` even within the SDK's grace window.
 * 3. The signer set is resolved (Horizon by default, injectable for tests) and
 *    verifyChallengeTxThreshold confirms the client's signatures meet it.
 * 4. The nonce is redeemed atomically (single-use, bound to account + domain).
 */
export async function verifySignedChallenge(input: {
  signedTransaction: string;
  homeDomain: string;
  requestHost?: string;
  nowMs?: number;
  store: Sep10NonceStore;
  resolveSigners?: SignerResolver;
}): Promise<VerifiedChallenge> {
  const nowMs = input.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const serverPub = getWebAuthServerPublicKey();
  const passphrase = getSep10NetworkPassphrase();
  const webAuthDomain = resolveWebAuthDomain(input.requestHost);

  if (!validateHomeDomain(input.homeDomain)) {
    throw new Sep10Error(`Invalid home domain "${input.homeDomain}"`, 400);
  }

  let details;
  try {
    details = WebAuth.readChallengeTx(
      input.signedTransaction,
      serverPub,
      passphrase,
      input.homeDomain,
      webAuthDomain,
    );
  } catch (err) {
    throw new Sep10Error(
      `Invalid challenge: ${err instanceof Error ? err.message : 'could not parse'}`,
      400,
    );
  }

  const timeBounds = details.tx.timeBounds;
  if (timeBounds) {
    const minTime = Number.parseInt(timeBounds.minTime, 10);
    const maxTime = Number.parseInt(timeBounds.maxTime, 10);
    if (Number.isFinite(minTime) && nowSec < minTime) {
      throw new Sep10Error('Invalid challenge: transaction is not yet valid', 400);
    }
    if (Number.isFinite(maxTime) && nowSec > maxTime) {
      throw new Sep10Error('Invalid challenge: transaction has expired', 400);
    }
  }

  const clientAccountId = details.clientAccountID;
  const ownerAccount = toEd25519PublicKey(clientAccountId);
  // readChallengeTx guarantees operations[0] is the home-domain ManageData op.
  const firstOp = details.tx.operations[0] as Operation.ManageData | undefined;
  const nonce = firstOp?.value?.toString() ?? '';

  const resolver = input.resolveSigners ?? resolveSignersFromHorizon;
  let signerResult: SignerSummary;
  try {
    signerResult = await resolver(ownerAccount);
  } catch (err) {
    throw new Sep10Error(
      `Failed to resolve signers for account: ${err instanceof Error ? err.message : 'unknown error'}`,
      500,
    );
  }
  const { threshold, signers } = signerResult;
  if (!signers || signers.length === 0 || !Number.isInteger(threshold) || threshold < 1) {
    throw new Sep10Error('Invalid challenge: account has no verifiable signers', 400);
  }

  try {
    WebAuth.verifyChallengeTxThreshold(
      input.signedTransaction,
      serverPub,
      passphrase,
      threshold,
      // The SDK expects Horizon's signer records ({key, weight, type}); our
      // resolver contract only needs {key, weight}, which is what verification reads.
      signers as unknown as Parameters<typeof WebAuth.verifyChallengeTxThreshold>[4],
      input.homeDomain,
      webAuthDomain,
    );
  } catch (err) {
    throw new Sep10Error(
      `Invalid challenge: ${err instanceof Error ? err.message : 'signature verification failed'}`,
      400,
    );
  }

  const redeemed = await input.store.redeemNonce(nonce, ownerAccount, input.homeDomain, nowSec);
  if (!redeemed) {
    throw new Sep10Error(
      'Invalid challenge: nonce was already redeemed, expired, or belongs to another account',
      401,
    );
  }

  return { clientAccountId, matchedHomeDomain: details.matchedHomeDomain, nonce };
}

export function issueSellerJwt(input: {
  clientAccountId: string;
  homeDomain: string;
  jti?: string;
  nowSec?: number;
}): string {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  return mintSep10Jwt(
    {
      sub: input.clientAccountId,
      iss: input.homeDomain,
      sellerWallet: toEd25519PublicKey(input.clientAccountId),
      jti: input.jti ?? crypto.randomBytes(16).toString('hex'),
      ttlSeconds: getSep10JwtTtlSeconds(),
      nowSec,
    },
    getWebAuthJwtSecret(),
  );
}

/**
 * Default signer resolver: reads the account's authorized signers and medium
 * threshold from Horizon. An unfunded/unknown account (404) is treated as a
 * single master-key signer with weight 1 and threshold 1, which matches the
 * reality that only the account's own keypair could have signed.
 */
export const resolveSignersFromHorizon: SignerResolver = async accountId => {
  const response = await fetch(`${HORIZON_URL.replace(/\/$/, '')}/accounts/${accountId}`);
  if (response.status === 404) {
    return { threshold: 1, signers: [{ key: accountId, weight: 1 }] };
  }
  if (!response.ok) {
    throw new Error(`Horizon responded ${response.status}`);
  }
  const record = (await response.json()) as {
    thresholds?: { med_threshold?: number };
    signers?: Array<{ key: string; weight: number }>;
  };
  return {
    threshold: record.thresholds?.med_threshold ?? 1,
    signers: record.signers ?? [{ key: accountId, weight: 1 }],
  };
};
