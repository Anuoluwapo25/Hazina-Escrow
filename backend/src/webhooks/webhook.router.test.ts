import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

// ── In-memory storage state ────────────────────────────────────────────────

type MockWebhook = {
  id: string;
  sellerWallet: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: string;
};

type MockTransaction = {
  id: string;
  datasetId: string;
  txHash: string;
  memo?: string;
  amount: number;
  status: string;
  timestamp: string;
  buyerQuery?: string;
  [key: string]: unknown;
};

let _webhooks: MockWebhook[] = [];
let _transactions: MockTransaction[] = [];

function resetStore() {
  _webhooks = [];
  _transactions = [];
}

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../common/storage', () => ({
  addWebhook: vi.fn(async (wh: MockWebhook) => {
    _webhooks.push(wh);
  }),
  getWebhookById: vi.fn(async (id: string) => {
    return _webhooks.find(w => w.id === id);
  }),
  getWebhooksForSeller: vi.fn(async (wallet: string) => {
    return _webhooks.filter(w => w.sellerWallet === wallet);
  }),
  removeWebhook: vi.fn(async (id: string) => {
    const idx = _webhooks.findIndex(w => w.id === id);
    if (idx === -1) return false;
    _webhooks.splice(idx, 1);
    return true;
  }),
  updateWebhook: vi.fn(async (id: string, updates: Partial<MockWebhook>) => {
    const idx = _webhooks.findIndex(w => w.id === id);
    const existing = _webhooks[idx];
    if (idx === -1 || !existing) return undefined;
    _webhooks[idx] = { ...existing, ...updates };
    return _webhooks[idx];
  }),
  getTransactionByMemo: vi.fn(async (memo: string) => {
    return _transactions.find(tx => tx.memo === memo);
  }),
  addTransaction: vi.fn(async (tx: MockTransaction) => {
    _transactions.push(tx);
    return tx;
  }),
  writeStore: vi.fn(async () => {}),
  readStore: vi.fn(async () => ({
    datasets: [],
    transactions: [],
    webhooks: [],
    payoutFailures: [],
  })),
  invalidateCache: vi.fn(),
}));

vi.mock('./webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
  dispatchWebhook: vi.fn(() => Promise.resolve()),
  signPayload: vi.fn((body: string, secret: string) =>
    crypto.createHmac('sha256', secret).update(body).digest('hex'),
  ),
}));

vi.mock('../payments/payments.service', () => ({
  processPayment: vi.fn(() =>
    Promise.resolve({
      success: true,
      transaction: { deliveryStatus: 'delivered' },
    }),
  ),
  deliverVerifiedPayment: vi.fn(),
  markDeliveryFailure: vi.fn(),
}));

vi.mock('../common/secret-crypto', () => ({
  encryptSecret: vi.fn((s: string) => `enc:${s}`),
  decryptSecret: vi.fn((s: string) => s.replace(/^enc:/, '')),
}));

vi.mock('../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { webhooksRouter } from './webhook.router';
import { signPayload } from './webhook.service';

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-api-key';
const TEST_JWT_SECRET = 'test-jwt-secret';

// Valid Stellar addresses deterministically derived from fixed seeds.
const SELLER_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa1)).publicKey();
const SELLER_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0xa2)).publicKey();

/** Build a minimal valid HS256 seller JWT. */
function makeSellerJwt(sellerWallet: string, secret: string, ttlSeconds = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sellerWallet,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const apiKeyHeader = () => ({ Authorization: `Bearer ${TEST_API_KEY}` });
const jwtHeader = (wallet: string) => ({
  Authorization: `Bearer ${makeSellerJwt(wallet, TEST_JWT_SECRET)}`,
});

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Webhook Router', () => {
  let app: Express;

  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', webhooksRouter);

    process.env.PAYMENT_WEBHOOK_SECRET = 'test-secret';
    process.env.API_KEY = TEST_API_KEY;
    process.env.SELLER_JWT_SECRET = TEST_JWT_SECRET;
    process.env.WEBHOOK_SECRET_KEY = crypto.randomBytes(32).toString('hex');
  });

  afterEach(() => {
    delete process.env.API_KEY;
    delete process.env.SELLER_JWT_SECRET;
    delete process.env.PAYMENT_WEBHOOK_SECRET;
  });

  // ── POST /payment ──────────────────────────────────────────────────────────

  describe('POST /api/v1/webhooks/payment', () => {
    const validPayload = { txHash: '0x123', memo: 'haz-dataset1-12345' };

    it('processes valid signed webhook', async () => {
      _transactions.push({
        id: 'tx-1',
        datasetId: 'dataset1',
        txHash: '',
        memo: 'haz-dataset1-12345',
        amount: 10,
        status: 'pending',
        timestamp: new Date().toISOString(),
      });

      const bodyString = JSON.stringify(validPayload);
      const signature = vi.mocked(signPayload)(bodyString, 'test-secret');

      const res = await request(app)
        .post('/api/v1/webhooks/payment')
        .set('X-Webhook-Signature', signature)
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Payment processed');
    });

    it('rejects invalid signature', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks/payment')
        .set('X-Webhook-Signature', 'wrong-sig')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('rejects missing signature', async () => {
      const res = await request(app).post('/api/v1/webhooks/payment').send(validPayload);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Missing signature');
    });

    it('returns 404 if transaction not found by memo', async () => {
      const payload = { txHash: '0x456', memo: 'unknown-memo' };
      const signature = vi.mocked(signPayload)(JSON.stringify(payload), 'test-secret');

      const res = await request(app)
        .post('/api/v1/webhooks/payment')
        .set('X-Webhook-Signature', signature)
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  // ── POST / (register) ──────────────────────────────────────────────────────

  describe('POST /api/v1/webhooks', () => {
    it('registers a webhook with valid data', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({
          sellerWallet: SELLER_A,
          url: 'https://example.com/webhook',
          secret: 'supersecret',
          events: ['payment.received', 'dataset.created'],
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.webhook.sellerWallet).toBe(SELLER_A);
      expect(res.body.webhook.url).toBe('https://example.com/webhook');
      expect(res.body.webhook.events).toEqual(['payment.received', 'dataset.created']);
      expect(res.body.webhook.active).toBe(true);
      expect(res.body.webhook.secret).toBeUndefined();
    });

    it('rejects missing sellerWallet', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ url: 'https://example.com/webhook', secret: 'shh' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('sellerWallet');
    });

    it('rejects invalid URL', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'not-a-url', secret: 'shh' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid URL');
    });

    it('rejects non-http(s) URL', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'ftp://example.com/hook', secret: 'shh' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('http or https');
    });

    it('rejects invalid event names', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({
          sellerWallet: SELLER_A,
          url: 'https://example.com/webhook',
          secret: 'shh',
          events: ['invalid.event'],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid events');
    });

    it('rejects request with no API key', async () => {
      const res = await request(app)
        .post('/api/v1/webhooks')
        .send({ sellerWallet: SELLER_A, url: 'https://x.com', secret: 'shh' });
      expect(res.status).toBe(401);
    });
  });

  // ── GET /:sellerWallet ─────────────────────────────────────────────────────

  describe('GET /api/v1/webhooks/:sellerWallet', () => {
    it('lists webhooks for a seller without secrets (API key)', async () => {
      await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({
          sellerWallet: SELLER_A,
          url: 'https://a.com/hook',
          secret: 'secret-a',
          events: ['ping'],
        });

      const res = await request(app).get(`/api/v1/webhooks/${SELLER_A}`).set(apiKeyHeader());
      expect(res.status).toBe(200);
      expect(res.body.webhooks.length).toBe(1);
      expect(res.body.webhooks[0].secret).toBeUndefined();
    });

    it('returns empty array for unknown seller', async () => {
      const res = await request(app).get(`/api/v1/webhooks/${SELLER_B}`).set(apiKeyHeader());
      expect(res.status).toBe(200);
      expect(res.body.webhooks).toEqual([]);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get(`/api/v1/webhooks/${SELLER_A}`);
      expect(res.status).toBe(401);
    });

    it('allows seller JWT scoped to matching wallet', async () => {
      await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({
          sellerWallet: SELLER_A,
          url: 'https://a.com/hook',
          secret: 'shh',
          events: ['ping'],
        });

      const res = await request(app).get(`/api/v1/webhooks/${SELLER_A}`).set(jwtHeader(SELLER_A));
      expect(res.status).toBe(200);
      expect(res.body.webhooks.length).toBe(1);
    });

    it('rejects seller JWT scoped to a different wallet with 403', async () => {
      const res = await request(app).get(`/api/v1/webhooks/${SELLER_A}`).set(jwtHeader(SELLER_B));
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('wallet');
    });
  });

  // ── DELETE /:id ────────────────────────────────────────────────────────────

  describe('DELETE /api/v1/webhooks/:id', () => {
    it('deletes an existing webhook (API key)', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const del = await request(app).delete(`/api/v1/webhooks/${id}`).set(apiKeyHeader());
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const list = await request(app).get(`/api/v1/webhooks/${SELLER_A}`).set(apiKeyHeader());
      expect(list.body.webhooks.length).toBe(0);
    });

    it('deletes own webhook with seller JWT', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const del = await request(app).delete(`/api/v1/webhooks/${id}`).set(jwtHeader(SELLER_A));
      expect(del.status).toBe(200);
    });

    it('returns 403 when seller JWT belongs to a different seller', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const del = await request(app).delete(`/api/v1/webhooks/${id}`).set(jwtHeader(SELLER_B));
      expect(del.status).toBe(403);
      expect(del.body.error).toContain('Not authorized');
    });

    it('returns 404 for non-existent webhook', async () => {
      const res = await request(app).delete('/api/v1/webhooks/wh-nonexistent').set(apiKeyHeader());
      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).delete('/api/v1/webhooks/wh-nonexistent');
      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /:id ─────────────────────────────────────────────────────────────

  describe('PATCH /api/v1/webhooks/:id', () => {
    it('updates webhook fields (API key)', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({
          sellerWallet: SELLER_A,
          url: 'https://old.com/hook',
          secret: 'oldsecret',
          events: ['ping'],
        });
      const id = create.body.webhook.id;

      const patch = await request(app)
        .patch(`/api/v1/webhooks/${id}`)
        .set(apiKeyHeader())
        .send({
          url: 'https://new.com/hook',
          secret: 'newsecret',
          events: ['payment.received'],
          active: false,
        });
      expect(patch.status).toBe(200);
      expect(patch.body.webhook.url).toBe('https://new.com/hook');
      expect(patch.body.webhook.events).toEqual(['payment.received']);
      expect(patch.body.webhook.active).toBe(false);
      expect(patch.body.webhook.secret).toBeUndefined();
    });

    it('updates own webhook with seller JWT', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://old.com/hook', secret: 'oldsecret' });
      const id = create.body.webhook.id;

      const patch = await request(app)
        .patch(`/api/v1/webhooks/${id}`)
        .set(jwtHeader(SELLER_A))
        .send({ url: 'https://new.com/hook' });
      expect(patch.status).toBe(200);
      expect(patch.body.webhook.url).toBe('https://new.com/hook');
    });

    it('returns 403 when seller JWT belongs to a different seller', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://old.com/hook', secret: 'oldsecret' });
      const id = create.body.webhook.id;

      const patch = await request(app)
        .patch(`/api/v1/webhooks/${id}`)
        .set(jwtHeader(SELLER_B))
        .send({ url: 'https://attacker.com/hook' });
      expect(patch.status).toBe(403);
      expect(patch.body.error).toContain('Not authorized');
    });

    it('rejects invalid URL on patch', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://old.com/hook', secret: 'oldsecret' });
      const id = create.body.webhook.id;

      const patch = await request(app)
        .patch(`/api/v1/webhooks/${id}`)
        .set(apiKeyHeader())
        .send({ url: 'bad-url' });
      expect(patch.status).toBe(400);
    });

    it('returns 404 for non-existent webhook', async () => {
      const res = await request(app)
        .patch('/api/v1/webhooks/wh-xyz')
        .set(apiKeyHeader())
        .send({ active: false });
      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).patch('/api/v1/webhooks/wh-xyz').send({ active: false });
      expect(res.status).toBe(401);
    });
  });

  // ── POST /:id/test ─────────────────────────────────────────────────────────

  describe('POST /api/v1/webhooks/:id/test', () => {
    it('returns success for test ping (API key)', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const res = await request(app).post(`/api/v1/webhooks/${id}/test`).set(apiKeyHeader());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows owner to trigger test via seller JWT', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const res = await request(app).post(`/api/v1/webhooks/${id}/test`).set(jwtHeader(SELLER_A));
      expect(res.status).toBe(200);
    });

    it('returns 403 when seller JWT belongs to a different seller', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      const res = await request(app).post(`/api/v1/webhooks/${id}/test`).set(jwtHeader(SELLER_B));
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Not authorized');
    });

    it('returns 400 for inactive webhook', async () => {
      const create = await request(app)
        .post('/api/v1/webhooks')
        .set(apiKeyHeader())
        .send({ sellerWallet: SELLER_A, url: 'https://example.com/webhook', secret: 'shh' });
      const id = create.body.webhook.id;

      await request(app)
        .patch(`/api/v1/webhooks/${id}`)
        .set(apiKeyHeader())
        .send({ active: false });

      const res = await request(app).post(`/api/v1/webhooks/${id}/test`).set(apiKeyHeader());
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('inactive');
    });

    it('returns 404 for non-existent webhook', async () => {
      const res = await request(app).post('/api/v1/webhooks/wh-ghost/test').set(apiKeyHeader());
      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).post('/api/v1/webhooks/wh-ghost/test');
      expect(res.status).toBe(401);
    });
  });
});
