import request from 'supertest';
import express, { Express, NextFunction, Request, Response } from 'express';
import 'express-async-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import type { Sep10NonceStore } from './nonce.store';
import { verifySep10Jwt } from './sep10.jwt';
import { authRouter } from './sep10.router';

const CLIENT_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa1));
const CLIENT_G = CLIENT_KP.publicKey();
const SERVER_SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x77)).secret();
const DOMAIN = 'hazina.example.com';
const PASS = 'Test SDF Network ; September 2015';

// The router reaches the real SEP-10 service (challenge build, nonce store,
// JWT minting). The only piece that must not hit the network is the Horizon
// signer resolver, which we inject with a single-signer stub for the test
// account.
vi.mock('./sep10.service', async importOriginal => {
  const actual = await importOriginal<typeof import('./sep10.service')>();
  return {
    ...actual,
    verifySignedChallenge: (input: Parameters<typeof actual.verifySignedChallenge>[0]) =>
      actual.verifySignedChallenge({
        ...input,
        resolveSigners: async () => ({
          threshold: 1,
          signers: [{ key: CLIENT_G, weight: 1 }],
        }),
      }),
  };
});

// Bind the router to an in-memory nonce store (never the shared app db).
// The store is stashed on globalThis so tests can reach it without tripping
// vitest's hoisting rule (mock factories may not reference top-level bindings).
vi.mock('./nonce.store', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle: drizzleSqlite } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const path = await import('path');
  const { sep10NoncesSqlite } = await import('../db/schema');
  const { createSep10NonceStore } =
    await vi.importActual<typeof import('./nonce.store')>('./nonce.store');
  const sqlite = new Database(':memory:');
  const drizzleDb = drizzleSqlite(sqlite, { schema: { sep10Nonces: sep10NoncesSqlite } });
  migrate(drizzleDb, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  const store = createSep10NonceStore(drizzleDb);
  (globalThis as Record<string, unknown>).__sep10TestStore = store;
  return { sep10NonceStore: store };
});

function getTestStore(): Sep10NonceStore {
  return (globalThis as Record<string, unknown>).__sep10TestStore as Sep10NonceStore;
}

function signXdr(xdr: string, keypairs: Keypair[], passphrase: string): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  for (const kp of keypairs) tx.sign(kp);
  return tx.toEnvelope().toXDR('base64').toString();
}

function makeErrorHandler(): (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => void {
  return (err, _req, res, _next) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: err.message, requestId: 'test' });
  };
}

describe('sep10.router', () => {
  const saved: Record<string, string | undefined> = {};
  let app: Express;

  beforeEach(() => {
    for (const key of [
      'AUTH_MODE',
      'WEB_AUTH_SIGNING_KEY',
      'WEB_AUTH_JWT_SECRET',
      'WEB_AUTH_DOMAIN',
      'STELLAR_NETWORK',
      'STELLAR_NETWORK_PASSPHRASE',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.AUTH_MODE = 'sep10';
    process.env.WEB_AUTH_SIGNING_KEY = saved['WEB_AUTH_SIGNING_KEY'] ?? SERVER_SECRET;
    process.env.WEB_AUTH_JWT_SECRET = saved['WEB_AUTH_JWT_SECRET'] ?? 'web-auth-jwt-secret';
    process.env.WEB_AUTH_DOMAIN = DOMAIN;
    process.env.STELLAR_NETWORK = 'testnet';
    delete process.env.STELLAR_NETWORK_PASSPHRASE;
    // Only fake Date, not timers: express's sub-router dispatch schedules via
    // setImmediate, which a full fake-timer setup would stall forever.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);

    app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use(makeErrorHandler());
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

  it('answers 503 when SEP-10 is not enabled', async () => {
    process.env.AUTH_MODE = 'legacy';
    const res = await request(app).get('/auth?account=' + CLIENT_G);
    expect(res.status).toBe(503);
  });

  it('rejects a challenge request without an account', async () => {
    const res = await request(app).get('/auth');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('account');
  });

  it('issues a challenge and stores its nonce', async () => {
    const res = await request(app).get(`/auth?account=${CLIENT_G}&home_domain=${DOMAIN}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction).toBeTruthy();
    expect(res.body.network_passphrase).toBe(PASS);
    expect(res.body.home_domain).toBe(DOMAIN);
    expect(res.body.expires_at).toBe(1_700_000_300);

    const tx = TransactionBuilder.fromXDR(
      res.body.transaction,
      PASS,
    ) as import('@stellar/stellar-sdk').Transaction;
    expect(Number.parseInt(tx.sequence, 10)).toBe(0);
    const ops = tx.operations as [
      import('@stellar/stellar-sdk').Operation.ManageData,
      ...import('@stellar/stellar-sdk').Operation[],
    ];
    const nonce = ops[0]?.value?.toString() ?? '';
    expect(nonce).toBeTruthy();
    expect(await getTestStore().isNonceValid(nonce, CLIENT_G, DOMAIN, 1_700_000_000)).toBe(true);
  });

  it('signs in: challenge, sign, verify, token', async () => {
    const challenge = await request(app).get(`/auth?account=${CLIENT_G}&home_domain=${DOMAIN}`);
    const signed = signXdr(challenge.body.transaction, [CLIENT_KP], PASS);

    const res = await request(app).post('/auth').send({
      transaction: signed,
      home_domain: DOMAIN,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.seller_wallet).toBe(CLIENT_G);
    expect(res.body.account).toBe(CLIENT_G);

    const claims = verifySep10Jwt(res.body.token, 'web-auth-jwt-secret', {
      nowSec: 1_700_000_000,
      expectedIssuer: DOMAIN,
    });
    expect(claims).not.toBeNull();
    expect(claims?.sellerWallet).toBe(CLIENT_G);
  });

  it('rejects a replayed signed challenge', async () => {
    const challenge = await request(app).get(`/auth?account=${CLIENT_G}&home_domain=${DOMAIN}`);
    const signed = signXdr(challenge.body.transaction, [CLIENT_KP], PASS);
    const payload = { transaction: signed, home_domain: DOMAIN };

    const first = await request(app).post('/auth').send(payload);
    expect(first.status).toBe(200);

    const second = await request(app).post('/auth').send(payload);
    expect(second.status).toBe(401);
  });

  it('rejects a POST without transaction or home_domain', async () => {
    const res = await request(app)
      .post('/auth')
      .send({ transaction: 'not-a-real-xdr', home_domain: DOMAIN });
    expect(res.status).toBe(400);
  });
});
