import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../stellar.service', () => ({
  verifyStellarPayment: vi.fn(),
  StellarTimeoutError: class StellarTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Stellar Horizon did not respond within ${timeoutMs / 1000} seconds.`);
      this.name = 'StellarTimeoutError';
    }
  },
  PaymentError: class PaymentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PaymentError';
    }
  },
}));

vi.mock('../../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
}));

vi.mock('../../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../trustline.service', () => ({
  checkDestinationReady: vi.fn(() => Promise.resolve({ ready: true })),
  classifyDestinationFailure: vi.fn(() => null),
}));

vi.mock('../../agent/agent.wallet', () => ({
  sendTokenPayment: vi.fn(),
}));

vi.mock('../../common/datadog', () => ({
  domainMetrics: {
    paymentVerified: vi.fn(),
    paymentVerificationError: vi.fn(),
    paymentDeliveryFailed: vi.fn(),
    deliveryRetryAttempt: vi.fn(),
    datasetQueried: vi.fn(),
    agentJobCompleted: vi.fn(),
    stellarPaymentVerified: vi.fn(),
    stellarTimeout: vi.fn(),
  },
}));

vi.mock('../../common/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('../../common/storage')>();
  return {
    ...actual,
    getDataset: vi.fn(),
    txHashUsed: vi.fn(() => Promise.resolve(false)),
    addTransaction: vi.fn(() => Promise.resolve()),
    updateDataset: vi.fn(() => Promise.resolve()),
    updateTransactionByHash: vi.fn(() => Promise.resolve(null)),
    updateTransactionByMemo: vi.fn(() => Promise.resolve(null)),
    getTransactionByMemo: vi.fn(() =>
      Promise.resolve({
        id: 'tx-pending',
        datasetId: 'ds-test-1',
        txHash: '',
        memo: 'haz',
        amount: 1,
        timestamp: new Date().toISOString(),
      }),
    ),
    getTransactionByHash: vi.fn(() =>
      Promise.resolve({
        id: 'tx-pending',
        datasetId: 'ds-test-1',
        txHash: 'tx-pending',
        buyerWallet: `G${'A'.repeat(55)}`,
        amount: 1,
        timestamp: new Date().toISOString(),
      }),
    ),
    getUnpaidTransactions: vi.fn(() => Promise.resolve([])),
    getFailedDeliveryTransactions: vi.fn(() => Promise.resolve([])),
    getManualReviewDeliveries: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../receipts/receipt.service', () => ({
  getReceiptAnchorMode: vi.fn(() => 'direct'),
  storeReceipt: vi.fn(async (input: { datasetId: string; txHash: string }) => ({
    id: `rcpt-${input.txHash}`,
    datasetId: input.datasetId,
    buyer: `G${'A'.repeat(55)}`,
    seller: `G${'A'.repeat(55)}`,
    amount: 1,
    paymentToken: 'USDC',
    txHash: input.txHash,
    leafHash: 'aa'.repeat(32),
    receiptHash: 'bb'.repeat(32),
    anchorMode: 'direct',
    anchorStatus: 'NOT_ANCHORED_YET',
    deliveredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  paymentsRouter,
  startDeliveryRetryWorker,
  stopDeliveryRetryWorker,
  retryFailedDeliveries,
} from '../payments.router';
import { generateDataSummary } from '../../ai/claude.service';
import {
  getDataset,
  txHashUsed,
  getFailedDeliveryTransactions,
  getManualReviewDeliveries,
} from '../../common/storage';
import type { Dataset, Transaction } from '../../common/storage';
import { verifyStellarPayment } from '../stellar.service';
import { domainMetrics } from '../../common/datadog';
import { sendTokenPayment } from '../../agent/agent.wallet';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_WALLET = `G${'A'.repeat(55)}`;

const DATASET: Dataset = {
  id: 'ds-test-1',
  name: 'Test Dataset',
  description: 'A test dataset',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER_WALLET,
  data: { rows: [1, 2, 3] },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  return app;
}

// ── Tests: POST /api/v1/payments/verify/:id ──────────────────────────────────────────────

describe('POST /api/v1/payments/verify/:id', () => {
  let app: Express;

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(txHashUsed).mockResolvedValue(false);
    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: true,
      actualAmount: 1,
      memo: 'haz',
    });
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Executive summary',
      answer: 'Buyer answer',
    });
    vi.mocked(sendTokenPayment).mockResolvedValue({
      txHash: 'seller-pay-tx',
      from: 'GAGENT',
      to: SELLER_WALLET,
      amount: '0.9500000',
      tokenCode: 'USDC',
    });
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/v1/payments/verify/does-not-exist')
      .send({ txHash: 'tx-missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Dataset not found');
  });

  it('returns 400 when txHash is missing', async () => {
    const res = await request(app).post('/api/v1/payments/verify/ds-test-1').send({});

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash is empty', async () => {
    const res = await request(app).post('/api/v1/payments/verify/ds-test-1').send({ txHash: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash was already used (replay attack)', async () => {
    vi.mocked(txHashUsed).mockResolvedValue(true);

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1')
      .send({ txHash: 'tx-used' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already processed');
  });

  it('returns 400 when Stellar verification fails', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValue({ valid: false, reason: 'Amount mismatch' });

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1')
      .send({ txHash: 'tx-invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Amount mismatch');
  });

  it('returns 200 with data and AI summary on happy path', async () => {
    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1')
      .send({ txHash: 'tx-happy', buyerQuestion: 'What changed?' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ai.summary).toBe('Executive summary');
    expect(res.body.ai.answer).toBe('Buyer answer');
    expect(res.body.transaction.amount).toBe(1);
    expect(res.body.transaction.status).toBe('completed');
    expect(res.body.transaction.deliveryStatus).toBe('delivered');
    expect(verifyStellarPayment).toHaveBeenCalledWith({
      txHash: 'tx-happy',
      expectedAmount: 1,
      destinationAddress: SELLER_WALLET,
      tokenCode: 'USDC',
    });
    expect(domainMetrics.paymentVerified).toHaveBeenCalledWith({
      datasetType: 'yield-data',
      mode: 'real',
      status: 'delivered',
    });
    expect(domainMetrics.datasetQueried).toHaveBeenCalledWith({
      datasetType: 'yield-data',
      mode: 'real',
      source: 'buyer',
    });
    expect(res.body.receipt).toBeDefined();
    expect(res.body.receipt.id).toBe('rcpt-tx-happy');
    expect(res.body.receipt.receiptHash).toBe('bb'.repeat(32));
    expect(res.body.receipt.anchorStatus).toBe('NOT_ANCHORED_YET');
    // Seller is only paid once delivery has actually succeeded (#518).
    expect(sendTokenPayment).toHaveBeenCalledWith({
      destinationAddress: SELLER_WALLET,
      amount: '0.9500000',
      memo: 'hazina-ds-test-1',
      tokenCode: 'USDC',
    });
  });

  it('sanitizes a whitespace-only buyerQuestion down to undefined', async () => {
    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1')
      .send({ txHash: 'tx-whitespace-question', buyerQuestion: '   ' });

    expect(res.status).toBe(200);
    expect(generateDataSummary).toHaveBeenCalledWith(DATASET.data, undefined);
  });

  it('returns 202 and records delivery failure when AI summary throws', async () => {
    // Reset the txHashUsed mock to ensure it returns false for new txHash
    vi.mocked(txHashUsed).mockResolvedValueOnce(false);

    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    // Re-assert critical mocks to avoid interference from other parallel tests
    vi.mocked(verifyStellarPayment).mockResolvedValue({
      valid: true,
      actualAmount: 1,
      memo: 'haz',
    });

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1')
      .send({ txHash: 'tx-pending' });

    expect(res.status).toBe(202);
    expect(res.body.pendingDelivery).toBe(true);
    expect(res.body.warning).toBe('DELIVERY_PENDING_RETRY');
    expect(res.body.transaction.status).toBe('delivery_failed');
    expect(res.body.transaction.deliveryStatus).toBe('failed');
    expect(domainMetrics.paymentVerified).toHaveBeenCalledWith({
      datasetType: 'yield-data',
      mode: 'real',
      status: 'pending',
    });
    expect(domainMetrics.datasetQueried).not.toHaveBeenCalled();
    // The core #518 fix: a delivery that fails must NOT pay the seller —
    // they'd be paid for a purchase the buyer never received.
    expect(sendTokenPayment).not.toHaveBeenCalled();
  });
});

// ── Tests: retryFailedDeliveries (background worker) ─────────────────────────

describe('retryFailedDeliveries', () => {
  const FAILED_CUSTODIAL_TX: Transaction = {
    id: 'tx-retry-1',
    datasetId: 'ds-test-1',
    txHash: 'tx-retry-1-hash',
    amount: 1,
    status: 'delivery_failed',
    deliveryStatus: 'failed',
    deliveryAttempts: 1,
    timestamp: new Date().toISOString(),
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(sendTokenPayment).mockResolvedValue({
      txHash: 'seller-pay-tx',
      from: 'GAGENT',
      to: SELLER_WALLET,
      amount: '0.9500000',
      tokenCode: 'USDC',
    });
  });

  it('pays the seller once a custodial delivery succeeds on retry', async () => {
    vi.mocked(getFailedDeliveryTransactions).mockResolvedValueOnce([FAILED_CUSTODIAL_TX]);
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Retried summary',
      answer: undefined,
    });

    await retryFailedDeliveries();

    expect(sendTokenPayment).toHaveBeenCalledWith({
      destinationAddress: SELLER_WALLET,
      amount: '0.9500000',
      memo: 'hazina-ds-test-1',
      tokenCode: 'USDC',
    });
  });

  it('does not pay the seller when the retried delivery still fails', async () => {
    vi.mocked(getFailedDeliveryTransactions).mockResolvedValueOnce([FAILED_CUSTODIAL_TX]);
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude still unavailable'));

    await retryFailedDeliveries();

    expect(sendTokenPayment).not.toHaveBeenCalled();
  });
});

// ── Tests: GET /api/v1/payments/admin/deliveries/stuck ───────────────────────

describe('GET /api/v1/payments/admin/deliveries/stuck', () => {
  const ADMIN_KEY = 'test-admin-key';
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    vi.clearAllMocks();
  });

  it('rejects without the admin key', async () => {
    const res = await request(app).get('/api/v1/payments/admin/deliveries/stuck');
    expect(res.status).toBe(401);
  });

  it('returns deliveries requiring manual review with the admin key', async () => {
    vi.mocked(getManualReviewDeliveries).mockResolvedValueOnce([
      {
        id: 'tx-stuck-1',
        datasetId: 'ds-test-1',
        txHash: 'tx-stuck-1-hash',
        amount: 1,
        deliveryStatus: 'manual_review_needed',
        timestamp: new Date().toISOString(),
      },
    ]);

    const res = await request(app)
      .get('/api/v1/payments/admin/deliveries/stuck')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0].id).toBe('tx-stuck-1');
  });
});

// ── Tests: POST /api/v1/payments/verify/:id/demo ────────────────────────────────────────

describe('POST /api/v1/payments/verify/:id/demo', () => {
  let app: Express;

  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    app = makeApp();
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Demo summary',
      answer: undefined,
    });
  });

  it('returns 200 with demo data', async () => {
    const res = await request(app).post('/api/v1/payments/verify/ds-test-1/demo').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.demo).toBe(true);
    expect(res.body.ai.summary).toBe('Demo summary');
    expect(domainMetrics.paymentVerified).toHaveBeenCalledWith({
      datasetType: 'yield-data',
      mode: 'demo',
      status: 'delivered',
    });
    expect(domainMetrics.datasetQueried).toHaveBeenCalledWith({
      datasetType: 'yield-data',
      mode: 'demo',
      source: 'buyer',
    });
  });

  it('returns 404 when dataset does not exist', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined);

    const res = await request(app).post('/api/v1/payments/verify/does-not-exist/demo').send({});

    expect(res.status).toBe(404);
  });

  it('returns 200 with fallback summary when AI throws', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue(new Error('Claude unavailable'));

    const res = await request(app).post('/api/v1/payments/verify/ds-test-1/demo').send({});

    expect(res.status).toBe(200);
    expect(res.body.ai.summary).toContain('Demo mode');
  });

  it('returns 200 with fallback summary when AI throws a non-Error value', async () => {
    vi.mocked(generateDataSummary).mockRejectedValue('Claude unavailable');

    const res = await request(app).post('/api/v1/payments/verify/ds-test-1/demo').send({});

    expect(res.status).toBe(200);
    expect(res.body.ai.summary).toContain('Demo mode');
  });

  it('passes a real buyerQuestion through to the AI summary call', async () => {
    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1/demo')
      .send({ buyerQuestion: 'What changed?' });

    expect(res.status).toBe(200);
    expect(generateDataSummary).toHaveBeenCalledWith(DATASET.data, 'What changed?');
  });

  it('sanitizes a whitespace-only buyerQuestion down to undefined', async () => {
    const res = await request(app)
      .post('/api/v1/payments/verify/ds-test-1/demo')
      .send({ buyerQuestion: '   ' });

    expect(res.status).toBe(200);
    expect(generateDataSummary).toHaveBeenCalledWith(DATASET.data, undefined);
  });
});

// ── Tests: delivery retry worker lifecycle ───────────────────────────────────

describe('startDeliveryRetryWorker / stopDeliveryRetryWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopDeliveryRetryWorker();
    vi.useRealTimers();
  });

  it('is a no-op to start twice, and a no-op to stop twice', async () => {
    startDeliveryRetryWorker();
    startDeliveryRetryWorker(); // second call should hit the early-return guard

    await vi.runOnlyPendingTimersAsync();

    stopDeliveryRetryWorker();
    stopDeliveryRetryWorker(); // second call should hit the early-return guard
  });
});
