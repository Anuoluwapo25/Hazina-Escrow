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
    getUnpaidTransactions: vi.fn(() => Promise.resolve([])),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  paymentsRouter,
  startDeliveryRetryWorker,
  stopDeliveryRetryWorker,
} from '../payments.router';
import { generateDataSummary } from '../../ai/claude.service';
import { getDataset, txHashUsed } from '../../common/storage';
import type { Dataset } from '../../common/storage';
import { verifyStellarPayment } from '../stellar.service';
import { domainMetrics } from '../../common/datadog';

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
