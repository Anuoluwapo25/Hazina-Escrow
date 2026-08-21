import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { createSep10NonceStore, type Sep10NonceStore } from './nonce.store';
import { sep10NoncesSqlite } from '../db/schema';
import {
  createChallenge,
  issueSellerJwt,
  resolveSignersFromHorizon,
  Sep10Error,
  toEd25519PublicKey,
  verifySignedChallenge,
} from './sep10.service';
import { verifySep10Jwt } from './sep10.jwt';

const NOW_MS = 1_700_000_000_000;
const DOMAIN = 'hazina.example.com';

const SERVER_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x77));
const CLIENT_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa1));
const CLIENT2_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa2));
const CLIENT_G = CLIENT_KP.publicKey();

/** Builds an M… muxed address wrapping the client key with a fixed 64-bit id. */
function makeMuxedClient(id: number): string {
  const payload = Buffer.alloc(40);
  CLIENT_KP.rawPublicKey().copy(payload, 0);
  payload.writeBigUInt64BE(BigInt(id), 32);
  return StrKey.encodeMed25519PublicKey(payload);
}
const MUXED_CLIENT = makeMuxedClient(1234);

const SECRET = SERVER_KP.secret();
const JWT_SECRET = 'web-auth-jwt-secret';

function makeStore(): Sep10NonceStore {
  const sqlite = new Database(':memory:');
  const db = drizzleSqlite(sqlite, { schema: { sep10Nonces: sep10NoncesSqlite } });
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  return createSep10NonceStore(db);
}

function singleSignerResolver(account: string) {
  return vi.fn(async () => ({
    threshold: 1,
    signers: [{ key: account, weight: 1 }],
  }));
}

function signXdr(xdr: string, keypairs: Keypair[], passphrase: string): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  for (const kp of keypairs) tx.sign(kp);
  return tx.toEnvelope().toXDR('base64').toString();
}

describe('sep10.service', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'WEB_AUTH_SIGNING_KEY',
      'WEB_AUTH_JWT_SECRET',
      'WEB_AUTH_DOMAIN',
      'PUBLIC_BASE_URL',
      'STELLAR_NETWORK',
      'STELLAR_NETWORK_PASSPHRASE',
      'SEP10_CHALLENGE_TTL_SECONDS',
      'SEP10_JWT_TTL_SECONDS',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.WEB_AUTH_SIGNING_KEY = SECRET;
    process.env.WEB_AUTH_JWT_SECRET = JWT_SECRET;
    process.env.WEB_AUTH_DOMAIN = DOMAIN;
    process.env.STELLAR_NETWORK = 'testnet';
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value ?? '';
    }
    vi.restoreAllMocks();
  });

  const PASS = 'Test SDF Network ; September 2015';

  describe('createChallenge', () => {
    it('issues a SEP-10 challenge bound to the client and stores its nonce', async () => {
      const store = makeStore();
      const result = await createChallenge({
        clientAccountId: CLIENT_G,
        store,
        nowMs: NOW_MS,
      });

      expect(result.homeDomain).toBe(DOMAIN);
      expect(Buffer.from(result.nonce, 'base64')).toHaveLength(48);
      expect(result.expiresAtSec).toBe(1_700_000_300);

      // The challenge parses and carries the expected structure.
      const tx = TransactionBuilder.fromXDR(
        result.transaction,
        PASS,
      ) as import('@stellar/stellar-sdk').Transaction;
      expect(tx.source).toBe(SERVER_KP.publicKey());
      expect(Number.parseInt(tx.sequence, 10)).toBe(0);
      const [homeOp, webAuthOp] = tx.operations as [
        import('@stellar/stellar-sdk').Operation.ManageData,
        import('@stellar/stellar-sdk').Operation.ManageData,
      ];
      expect(homeOp.name).toBe(`${DOMAIN} auth`);
      expect(homeOp.source).toBe(CLIENT_G);
      expect(homeOp.value?.toString()).toBe(result.nonce);
      expect(webAuthOp.name).toBe('web_auth_domain');
      expect(webAuthOp.value?.toString()).toBe(DOMAIN);

      // The nonce is recorded, single-use, bound to the client + domain.
      expect(await store.redeemNonce(result.nonce, CLIENT_G, DOMAIN, result.expiresAtSec - 1)).toBe(
        true,
      );
      expect(await store.redeemNonce(result.nonce, CLIENT_G, DOMAIN, result.expiresAtSec - 1)).toBe(
        false,
      );
    });

    it('rejects an invalid client account', async () => {
      const store = makeStore();
      await expect(
        createChallenge({ clientAccountId: 'not-an-account', store, nowMs: NOW_MS }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a home domain that differs from the server domain', async () => {
      const store = makeStore();
      await expect(
        createChallenge({
          clientAccountId: CLIENT_G,
          homeDomain: 'evil.example.com',
          store,
          nowMs: NOW_MS,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('accepts a matching supplied home domain', async () => {
      const store = makeStore();
      const result = await createChallenge({
        clientAccountId: CLIENT_G,
        homeDomain: DOMAIN.toUpperCase(),
        store,
        nowMs: NOW_MS,
      });
      expect(result.homeDomain).toBe(DOMAIN);
    });

    it('stores a muxed account as its underlying G-address', async () => {
      const store = makeStore();
      const result = await createChallenge({
        clientAccountId: MUXED_CLIENT,
        store,
        nowMs: NOW_MS,
      });
      // Bound to the underlying G-address so a real signing key matches.
      expect(await store.redeemNonce(result.nonce, CLIENT_G, DOMAIN, result.expiresAtSec - 1)).toBe(
        true,
      );
    });
  });

  describe('verifySignedChallenge', () => {
    it('verifies a legitimately signed challenge and redeems the nonce', async () => {
      const store = makeStore();
      const resolver = singleSignerResolver(CLIENT_G);
      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      const result = await verifySignedChallenge({
        signedTransaction: signed,
        homeDomain: DOMAIN,
        store,
        nowMs: NOW_MS,
        resolveSigners: resolver,
      });

      expect(result.clientAccountId).toBe(CLIENT_G);
      expect(result.matchedHomeDomain).toBe(DOMAIN);
      expect(result.nonce).toBe(issued.nonce);

      // Single-use: replaying the same signed challenge is rejected.
      await expect(
        verifySignedChallenge({
          signedTransaction: signed,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS + 1000,
          resolveSigners: resolver,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a challenge signed by the wrong account', async () => {
      const store = makeStore();
      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signedByOther = signXdr(issued.transaction, [CLIENT2_KP], PASS);

      await expect(
        verifySignedChallenge({
          signedTransaction: signedByOther,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS,
          resolveSigners: singleSignerResolver(CLIENT_G),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a challenge presented after its maxTime (strict, no grace)', async () => {
      const store = makeStore();
      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      // +400s: beyond maxTime (now+300) but still inside the SDK's 5-min grace —
      // our strict check must reject it.
      await expect(
        verifySignedChallenge({
          signedTransaction: signed,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS + 400_000,
          resolveSigners: singleSignerResolver(CLIENT_G),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a valid SEP-10 challenge that our server never issued', async () => {
      const store = makeStore();
      // Built with the official SDK client, using its own nonce (never stored).
      const foreign = WebAuth.buildChallengeTx(SERVER_KP, CLIENT_G, DOMAIN, 300, PASS, DOMAIN);
      const signed = signXdr(foreign, [CLIENT_KP], PASS);

      await expect(
        verifySignedChallenge({
          signedTransaction: signed,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS,
          resolveSigners: singleSignerResolver(CLIENT_G),
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a tampered signed challenge', async () => {
      const store = makeStore();
      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      // Corrupt the trailing signature bytes while keeping valid base64/XDR —
      // the server signature no longer matches the transaction hash.
      const raw = Buffer.from(signed, 'base64');
      raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
      const tampered = raw.toString('base64');

      await expect(
        verifySignedChallenge({
          signedTransaction: tampered,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS,
          resolveSigners: singleSignerResolver(CLIENT_G),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('verifies a multisig challenge whose combined weight meets the threshold', async () => {
      const store = makeStore();
      const resolver = vi.fn(async () => ({
        threshold: 3,
        signers: [
          { key: CLIENT_G, weight: 2 },
          { key: CLIENT2_KP.publicKey(), weight: 2 },
        ],
      }));

      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP, CLIENT2_KP], PASS);

      const result = await verifySignedChallenge({
        signedTransaction: signed,
        homeDomain: DOMAIN,
        store,
        nowMs: NOW_MS,
        resolveSigners: resolver,
      });
      expect(result.clientAccountId).toBe(CLIENT_G);
    });

    it('rejects a multisig challenge that misses the threshold', async () => {
      const store = makeStore();
      const resolver = vi.fn(async () => ({
        threshold: 3,
        signers: [
          { key: CLIENT_G, weight: 2 },
          { key: CLIENT2_KP.publicKey(), weight: 2 },
        ],
      }));

      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      await expect(
        verifySignedChallenge({
          signedTransaction: signed,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS,
          resolveSigners: resolver,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('verifies a muxed-account client', async () => {
      const store = makeStore();
      const issued = await createChallenge({ clientAccountId: MUXED_CLIENT, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      const result = await verifySignedChallenge({
        signedTransaction: signed,
        homeDomain: DOMAIN,
        store,
        nowMs: NOW_MS,
        resolveSigners: singleSignerResolver(CLIENT_G),
      });
      expect(result.clientAccountId).toBe(MUXED_CLIENT);
    });

    it('propagates signer resolution failures as 500', async () => {
      const store = makeStore();
      const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });
      const signed = signXdr(issued.transaction, [CLIENT_KP], PASS);

      await expect(
        verifySignedChallenge({
          signedTransaction: signed,
          homeDomain: DOMAIN,
          store,
          nowMs: NOW_MS,
          resolveSigners: vi.fn(async () => {
            throw new Error('horizon down');
          }),
        }),
      ).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('issueSellerJwt', () => {
    it('mints a JWT with sellerWallet set to the owning G-address', () => {
      const token = issueSellerJwt({
        clientAccountId: CLIENT_G,
        homeDomain: DOMAIN,
        nowSec: 1_700_000_000,
      });
      const claims = verifySep10Jwt(token, JWT_SECRET, {
        nowSec: 1_700_000_100,
        expectedIssuer: DOMAIN,
      });
      expect(claims?.sub).toBe(CLIENT_G);
      expect(claims?.sellerWallet).toBe(CLIENT_G);
    });

    it('normalizes a muxed client to its G-address in sellerWallet', () => {
      const token = issueSellerJwt({
        clientAccountId: MUXED_CLIENT,
        homeDomain: DOMAIN,
        nowSec: 1_700_000_000,
      });
      const claims = verifySep10Jwt(token, JWT_SECRET, {
        nowSec: 1_700_000_100,
        expectedIssuer: DOMAIN,
      });
      expect(claims?.sub).toBe(MUXED_CLIENT);
      expect(claims?.sellerWallet).toBe(CLIENT_G);
    });
  });

  describe('toEd25519PublicKey', () => {
    it('converts M-addresses to G-addresses', () => {
      expect(toEd25519PublicKey(MUXED_CLIENT)).toBe(CLIENT_G);
      expect(toEd25519PublicKey(CLIENT_G)).toBe(CLIENT_G);
    });

    it('rejects invalid addresses', () => {
      expect(() => toEd25519PublicKey('garbage')).toThrow(Sep10Error);
    });
  });

  describe('resolveSignersFromHorizon', () => {
    it('falls back to the master key when the account is unknown (404)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false });
      vi.stubGlobal('fetch', fetchMock);

      const result = await resolveSignersFromHorizon(CLIENT_G);
      expect(result).toEqual({ threshold: 1, signers: [{ key: CLIENT_G, weight: 1 }] });
    });

    it('reads signers and the medium threshold from the account record', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          thresholds: { med_threshold: 2 },
          signers: [
            { key: CLIENT_G, weight: 1 },
            { key: CLIENT2_KP.publicKey(), weight: 1 },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await resolveSignersFromHorizon(CLIENT_G);
      expect(result.threshold).toBe(2);
      expect(result.signers).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/accounts/${CLIENT_G}`));
    });

    it('throws on other Horizon failures', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      await expect(resolveSignersFromHorizon(CLIENT_G)).rejects.toThrow();
    });
  });
});
