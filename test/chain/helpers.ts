/**
 * helpers.ts — shared harness for the on-chain e2e suite.
 *
 * The rule this suite exists to enforce: assertions read authoritative on-chain
 * state, never an API response body. Balances come from a read-only simulation
 * of the token contract's `balance()`, and escrow state comes from the
 * contract's own `get_escrow`. If the backend lied about a payout, these tests
 * would still catch it.
 *
 * Amounts are handled in stroops (i128, 7 decimals) end to end. Converting to
 * floats for comparison is how you turn an exact 95/5 assertion into a flaky
 * one, so `expect` always compares BigInt stroop values.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Address,
  Asset,
  Contract,
  Keypair,
  Operation,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import {
  LOCAL_NETWORK_PASSPHRASE,
  PLATFORM_FEE_BPS,
  STROOPS_PER_UNIT,
  TRUSTLINE_LIMIT,
  USDC_CODE,
  endpoints,
  env as readEnv,
} from '../../scripts/devnet/lib/config.ts';
import { assertDevnetTarget } from '../../scripts/devnet/lib/guard.ts';
import {
  accountMap,
  precomputeContractId,
  type DevnetAccount,
  type DevnetRole,
} from '../../scripts/devnet/lib/accounts.ts';
import {
  type ChainContext,
  CONTRACT_ERROR,
  classicBalance,
  contractErrorCode,
  fundAccount,
  hasTrustline,
  prepareSoroban,
  simulateCall,
  submitClassic,
  submitPrepared,
  submitSoroban,
} from '../../scripts/devnet/lib/chain.ts';
import { probeHorizon } from '../../scripts/devnet/lib/health.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const MAX_BASIS_POINTS = 10_000n;

export interface Harness {
  ctx: ChainContext;
  accounts: Record<DevnetRole, DevnetAccount>;
  contractId: string;
  usdc: Asset;
  usdcSac: string;
}

let cached: Harness | null = null;

/**
 * Resolves the devnet the suite runs against. Reads `devnet.accounts.json` when
 * it exists (the provisioner's own record) and otherwise recomputes everything
 * deterministically — so the suite works both right after `npm run devnet` and
 * on a machine where only the container is up.
 */
export async function harness(): Promise<Harness> {
  if (cached) {
    return cached;
  }
  const overrides = readEnv();
  const urls = endpoints(overrides.port, overrides.host);
  const ctx: ChainContext = {
    horizonUrl: urls.horizon,
    rpcUrl: urls.rpc,
    friendbotUrl: urls.friendbot,
    passphrase: LOCAL_NETWORK_PASSPHRASE,
  };
  // The chain suite signs transactions, so it gets the same guard as the
  // provisioner. A test run must never be able to touch a public network either.
  assertDevnetTarget({ passphrase: ctx.passphrase, ...urls });

  const horizon = await probeHorizon(ctx.horizonUrl).catch(() => null);
  if (!horizon) {
    throw new Error(
      `No devnet responding at ${ctx.horizonUrl}. Start one first:\n  npm run devnet`,
    );
  }
  if (horizon.passphrase !== LOCAL_NETWORK_PASSPHRASE) {
    throw new Error(
      `The network at ${ctx.horizonUrl} reports "${horizon.passphrase}", not the local devnet.`,
    );
  }

  const accounts = accountMap();
  const contractId = precomputeContractId(accounts.admin.publicKey, LOCAL_NETWORK_PASSPHRASE);
  const usdc = new Asset(USDC_CODE, accounts.issuer.publicKey);

  // Sanity-check that the devnet was actually provisioned, with a message that
  // names the fix rather than failing later on a cryptic contract error.
  const fee = await simulateCall(
    ctx,
    accounts.admin.publicKey,
    contractId,
    'get_default_fee',
  ).catch(() => null);
  if (fee === null) {
    throw new Error(
      `Escrow contract ${contractId} is not deployed on this devnet. Run:\n  npm run devnet`,
    );
  }
  if (Number(fee) !== PLATFORM_FEE_BPS) {
    throw new Error(`Expected ${PLATFORM_FEE_BPS} bps on-chain, found ${String(fee)}.`);
  }

  cached = { ctx, accounts, contractId, usdc, usdcSac: usdc.contractId(ctx.passphrase) };
  return cached;
}

/** Reads a devnet.accounts.json field, when the file is present. */
export async function readAccountsFile(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(REPO_ROOT, 'devnet.accounts.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ── Amounts ──────────────────────────────────────────────────────────────────

export const toStroops = (whole: number): bigint => BigInt(Math.round(whole * STROOPS_PER_UNIT));
export const fromStroops = (stroops: bigint): number => Number(stroops) / STROOPS_PER_UNIT;

/**
 * The split the contract computes, reimplemented here so the test asserts an
 * independently-derived expectation rather than echoing the contract back at
 * itself. Mirrors release_one() in contracts/hazina-escrow/src/lib.rs, including
 * the 1-stroop floor for dust amounts.
 */
export function expectedSplit(
  amount: bigint,
  feeBps: number = PLATFORM_FEE_BPS,
): { sellerCut: bigint; platformCut: bigint } {
  const calculated = (amount * BigInt(feeBps)) / MAX_BASIS_POINTS;
  const platformCut = calculated === 0n && amount > 0n && feeBps > 0 ? 1n : calculated;
  return { sellerCut: amount - platformCut, platformCut };
}

// ── On-chain reads ───────────────────────────────────────────────────────────

/**
 * Token balance in stroops, read from the SAC via read-only simulation.
 * This is the authoritative number — the same one the contract sees.
 */
export async function tokenBalance(
  h: Harness,
  holder: string,
  tokenAddress: string = h.usdcSac,
): Promise<bigint> {
  const raw = await simulateCall(
    h.ctx,
    h.accounts.admin.publicKey,
    tokenAddress,
    'balance',
    Address.fromString(holder).toScVal(),
  );
  return BigInt(raw as string | number | bigint);
}

/**
 * Token balance, treating "this account has no trustline" as zero.
 *
 * The Stellar Asset Contract does NOT return 0 for an account with no trustline
 * to the asset — `balance()` traps with "trustline entry is missing for account".
 * That is correct behaviour (no trustline is not the same as a zero balance), but
 * it means a test that wants to assert "this account received nothing" has to
 * handle the trap rather than read a number.
 *
 * Matched on the host's message rather than the error code: the code is the
 * SAC's own enum, unrelated to HazinaEscrowError's numbering.
 */
export async function tokenBalanceOrZero(
  h: Harness,
  holder: string,
  tokenAddress: string = h.usdcSac,
): Promise<bigint> {
  try {
    return await tokenBalance(h, holder, tokenAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('trustline entry is missing')) {
      return 0n;
    }
    throw err;
  }
}

export interface EscrowRecord {
  escrow_id: bigint;
  dataset_id: string;
  buyer: string;
  seller: string;
  amount: bigint;
  token: string;
  deadline: bigint;
  buyer_confirmed: boolean;
  platform_fee_bps: number;
  released: boolean;
  refunded: boolean;
  disputed: boolean;
}

export async function getEscrow(h: Harness, escrowId: bigint): Promise<EscrowRecord> {
  return (await simulateCall(
    h.ctx,
    h.accounts.admin.publicKey,
    h.contractId,
    'get_escrow',
    nativeToScVal(escrowId, { type: 'u64' }),
  )) as EscrowRecord;
}

export async function escrowCount(h: Harness): Promise<bigint> {
  const raw = await simulateCall(
    h.ctx,
    h.accounts.admin.publicKey,
    h.contractId,
    'get_escrow_count',
  );
  return BigInt(raw as string | number | bigint);
}

// ── Escrow lifecycle ─────────────────────────────────────────────────────────

export interface LockOptions {
  buyer?: DevnetRole;
  seller?: DevnetRole;
  amount: bigint;
  datasetId: string;
  expirySeconds?: number;
}

function lockOperation(h: Harness, opts: Required<LockOptions>): xdr.Operation {
  return new Contract(h.contractId).call(
    'lock',
    Address.fromString(h.accounts[opts.buyer].publicKey).toScVal(),
    Address.fromString(h.accounts[opts.seller].publicKey).toScVal(),
    Address.fromString(h.usdcSac).toScVal(),
    nativeToScVal(opts.amount, { type: 'i128' }),
    nativeToScVal(opts.datasetId, { type: 'string' }),
    nativeToScVal(BigInt(opts.expirySeconds), { type: 'u64' }),
  );
}

function withDefaults(opts: LockOptions): Required<LockOptions> {
  return {
    buyer: opts.buyer ?? 'buyer',
    seller: opts.seller ?? 'seller',
    amount: opts.amount,
    datasetId: opts.datasetId,
    expirySeconds: opts.expirySeconds ?? 3_600,
  };
}

/** Buyer locks funds. Returns the new escrow id. */
export async function lock(h: Harness, opts: LockOptions): Promise<bigint> {
  const full = withDefaults(opts);
  const result = await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts[full.buyer].secret),
    lockOperation(h, full),
  );
  return BigInt(result.native as string | number | bigint);
}

/** Builds a signed lock transaction without submitting it — for replay tests. */
export async function prepareLock(h: Harness, opts: LockOptions) {
  const full = withDefaults(opts);
  return prepareSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts[full.buyer].secret),
    lockOperation(h, full),
  );
}

export const submitSigned = submitPrepared;

/** Buyer confirms delivery, which is what unblocks release. */
export async function confirmDelivery(
  h: Harness,
  escrowId: bigint,
  buyer: DevnetRole = 'buyer',
): Promise<void> {
  await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts[buyer].secret),
    new Contract(h.contractId).call(
      'confirm_delivery',
      nativeToScVal(escrowId, { type: 'u64' }),
      Address.fromString(h.accounts[buyer].publicKey).toScVal(),
    ),
  );
}

/** Admin releases: 95% to seller, 5% to treasury. */
export async function release(h: Harness, escrowId: bigint): Promise<void> {
  await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts.admin.secret),
    new Contract(h.contractId).call(
      'release',
      Address.fromString(h.accounts.admin.publicKey).toScVal(),
      nativeToScVal(escrowId, { type: 'u64' }),
    ),
  );
}

/** Admin refunds: 100% back to the buyer. */
export async function refund(h: Harness, escrowId: bigint): Promise<void> {
  await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts.admin.secret),
    new Contract(h.contractId).call(
      'refund',
      Address.fromString(h.accounts.admin.publicKey).toScVal(),
      nativeToScVal(escrowId, { type: 'u64' }),
    ),
  );
}

export async function raiseDispute(
  h: Harness,
  escrowId: bigint,
  evidence = 'devnet-evidence',
): Promise<void> {
  const evidenceHash = new Uint8Array(32);
  Buffer.from(evidence).copy(Buffer.from(evidenceHash.buffer), 0, 0, Math.min(32, evidence.length));
  await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts.buyer.secret),
    new Contract(h.contractId).call(
      'raise_dispute',
      Address.fromString(h.accounts.buyer.publicKey).toScVal(),
      nativeToScVal(escrowId, { type: 'u64' }),
      xdr.ScVal.scvBytes(Buffer.from(evidenceHash)),
    ),
  );
}

export async function resolveDispute(
  h: Harness,
  escrowId: bigint,
  favourBuyer: boolean,
): Promise<void> {
  await submitSoroban(
    h.ctx,
    Keypair.fromSecret(h.accounts.arbitrator.secret),
    new Contract(h.contractId).call(
      'resolve_dispute',
      Address.fromString(h.accounts.arbitrator.publicKey).toScVal(),
      nativeToScVal(escrowId, { type: 'u64' }),
      xdr.ScVal.scvBool(favourBuyer),
    ),
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Tops the buyer up so a test never fails because an earlier test spent the
 * balance. Idempotent and cheap: the issuer can mint freely.
 */
export async function ensureBuyerFunded(h: Harness, minimumWhole: number): Promise<void> {
  const current = await classicBalance(h.ctx, h.accounts.buyer.publicKey, h.usdc);
  if (current >= minimumWhole) {
    return;
  }
  await submitClassic(h.ctx, Keypair.fromSecret(h.accounts.issuer.secret), [
    Operation.payment({
      destination: h.accounts.buyer.publicKey,
      asset: h.usdc,
      amount: String(minimumWhole - current + 1_000),
    }),
  ]);
}

/**
 * Creates a fresh funded account with no USDC trustline.
 *
 * Deliberately RANDOM, not derived from a fixed seed like the provisioned
 * roster. A test that adds a trustline to this account has permanently changed
 * it, so a deterministic address would come back already-trusted on the second
 * run and the test would silently stop exercising the no-trustline path. (That
 * is not hypothetical — it is exactly how the first version of this helper
 * failed.) Devnet accounts are free and the ledger is thrown away on reset, so
 * a new account per run costs nothing.
 *
 * The provisioned `sellerNoTrustline` fixture stays untouched for tests that
 * only need to OBSERVE a trustline-less account.
 */
export async function freshAccountWithoutTrustline(h: Harness, label: string): Promise<Keypair> {
  const { randomBytes } = await import('node:crypto');
  const kp = Keypair.fromRawEd25519Seed(
    (await import('node:crypto'))
      .createHash('sha256')
      .update(`hazina-devnet:ephemeral:${label}:`)
      .update(randomBytes(16))
      .digest(),
  );
  await fundAccount(h.ctx, kp.publicKey());
  return kp;
}

/** Adds a USDC trustline to an arbitrary keypair. */
export async function addTrustline(h: Harness, kp: Keypair): Promise<void> {
  if (await hasTrustline(h.ctx, kp.publicKey(), h.usdc)) {
    return;
  }
  await submitClassic(h.ctx, kp, [
    Operation.changeTrust({ asset: h.usdc, limit: String(TRUSTLINE_LIMIT) }),
  ]);
}

export { CONTRACT_ERROR, contractErrorCode, classicBalance, hasTrustline };
