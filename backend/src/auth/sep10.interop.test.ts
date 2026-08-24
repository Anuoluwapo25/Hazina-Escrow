import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { createSep10NonceStore, type Sep10NonceStore } from './nonce.store';
import { sep10NoncesSqlite } from '../db/schema';
import { createChallenge, issueSellerJwt, verifySignedChallenge } from './sep10.service';

/**
 * Interop test: proves the challenges our server issues are consumable by the
 * official @stellar/stellar-sdk WebAuth client, and that the client's signed
 * response is accepted by our verifier. This is the "other side of the wire"
 * the service unit tests never exercise (they reuse our own builders).
 */
const NOW_MS = 1_700_000_000_000;
const DOMAIN = 'hazina.example.com';
const PASS = 'Test SDF Network ; September 2015';

const SERVER_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x77));
const CLIENT_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa1));
const CLIENT_G = CLIENT_KP.publicKey();
const SECRET = SERVER_KP.secret();
const JWT_SECRET = 'web-auth-jwt-secret';

function makeStore(): Sep10NonceStore {
  const sqlite = new Database(':memory:');
  const db = drizzleSqlite(sqlite, { schema: { sep10Nonces: sep10NoncesSqlite } });
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  return createSep10NonceStore(db);
}

const singleSignerResolver = () =>
  vi.fn(async () => ({
    threshold: 1,
    signers: [{ key: CLIENT_G, weight: 1 }],
  }));

/** The official SDK client path: read + verify the server's challenge, then sign it. */
function clientSign(xdr: string): string {
  const read = WebAuth.readChallengeTx(xdr, SERVER_KP.publicKey(), PASS, [DOMAIN], DOMAIN);
  expect(read.tx.sequence).toBe('0');
  expect(read.matchedHomeDomain).toBe(DOMAIN);

  const tx = TransactionBuilder.fromXDR(xdr, PASS);
  tx.sign(CLIENT_KP);
  return tx.toEnvelope().toXDR('base64').toString();
}

describe('sep10 interop with the official stellar-sdk WebAuth client', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'WEB_AUTH_SIGNING_KEY',
      'WEB_AUTH_JWT_SECRET',
      'WEB_AUTH_DOMAIN',
      'STELLAR_NETWORK',
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

  it('accepts a challenge signed by the official SDK client', async () => {
    const store = makeStore();
    const issued = await createChallenge({ clientAccountId: CLIENT_G, store, nowMs: NOW_MS });

    const signed = clientSign(issued.transaction);

    const verified = await verifySignedChallenge({
      signedTransaction: signed,
      homeDomain: DOMAIN,
      store,
      nowMs: NOW_MS,
      resolveSigners: singleSignerResolver(),
    });

    expect(verified.clientAccountId).toBe(CLIENT_G);
    expect(verified.matchedHomeDomain).toBe(DOMAIN);
    expect(verified.nonce).toBe(issued.nonce);

    // The resulting JWT identifies the seller who signed the challenge.
    const token = issueSellerJwt({ clientAccountId: CLIENT_G, homeDomain: DOMAIN });
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects a tampered challenge before the client ever signs it', async () => {
    const store = makeStore();
    const issued = await createChallenge({
      clientAccountId: CLIENT_G,
      store,
      nowMs: NOW_MS,
    });

    // Flip a byte in the signed challenge envelope.
    const raw = Buffer.from(issued.transaction, 'base64');
    raw[20] = (raw[20] ?? 0) ^ 0xff;
    const tampered = raw.toString('base64');

    expect(() => clientSign(tampered)).toThrow();
  });
});
