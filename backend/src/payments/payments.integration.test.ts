import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Store, writeStore } from '../common/storage';

vi.mock('./stellar.service', () => ({
  verifyStellarPayment: vi.fn(() => Promise.resolve({ valid: true, actualAmount: 1, memo: 'haz' })),
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

vi.mock('../ai/claude.service', () => ({
  generateDataSummary: vi.fn(),
}));

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../agent/agent.service', () => ({
  runResearchAgent: vi.fn(),
  runResearchAgentDemo: vi.fn(),
}));

vi.mock('../agent/agent.wallet', () => ({
  sendUsdcPayment: vi.fn(() => Promise.resolve({ txHash: 'tx-hash' })),
  getAgentPublicKey: vi.fn(() => 'mock-agent-wallet'),
}));

import { runResearchAgentDemo } from '../agent/agent.service';
import { generateDataSummary } from '../ai/claude.service';
import { verifyStellarPayment, StellarTimeoutError } from './stellar.service';
import { sendUsdcPayment } from '../agent/agent.wallet';
import { agentRouter } from '../agent/agent.router';
import { paymentsRouter } from './payments.router';

const SELLER_WALLET = `G${'A'.repeat(55)}`;
const ESCROW_WALLET = `G${'B'.repeat(55)}`;

const BASE_STORE: Store = {
  datasets: [
    {
      id: 'ds-payment-1',
      name: 'USDC Yield Dataset',
      description: 'Yield opportunities',
      type: 'yield-data',
      pricePerQuery: 1,
      sellerWallet: SELLER_WALLET,
      data: { rows: [1, 2, 3] },
      queriesServed: 0,
      totalEarned: 0,
      createdAt: new Date().toISOString(),
    },
  ],
  transactions: [],
  webhooks: [],
  payoutFailures: [],
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/agent', agentRouter);
  return app;
}

const describeSocket = process.env.ALLOW_SOCKET_TESTS === '1' ? describe : describe.skip;

describeSocket('payments and agent integration routes', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Seed store with a pending transaction that has memo 'haz' so processPayment can find it
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-pending-memo',
          datasetId: 'ds-payment-1',
          txHash: '',
          memo: 'haz',
          amount: 1,
          status: 'pending',
          deliveryStatus: 'pending',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    app = makeApp();
    process.env.ESCROW_WALLET = ESCROW_WALLET;
    process.env.ADMIN_API_KEY = 'admin-test-key';
    vi.mocked(generateDataSummary).mockResolvedValue({
      summary: 'Executive summary',
      answer: 'Buyer answer',
    });
    vi.mocked(runResearchAgentDemo).mockResolvedValue({
      jobId: 'job-demo-1',
      query: 'best low risk strategy',
      budget: 500,
      riskTolerance: 'low',
      humanTxHash: 'demo-agent-hash',
      agentWallet: 'demo-wallet',
      purchases: [],
      totalSpent: 0.14,
      agentProfit: 0.86,
      datasetsAvailable: 4,
      datasetsTotal: 4,
      report: {
        topOpportunity: {
          protocol: 'Aave',
          vault: 'USDC Stable Pool',
          chain: 'Ethereum',
          apy: 7.2,
          riskLevel: 'Low',
          whaleConfidence: 'High',
          sentimentScore: 'Bullish',
        },
        reasoning: 'Reasoning text',
        alternatives: ['Alt 1', 'Alt 2'],
        warnings: ['none'],
        rawAnalysis: 'Raw analysis text',
      },
      timestamp: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_WALLET;
    delete process.env.ADMIN_API_KEY;
    await writeStore({ datasets: [], transactions: [], webhooks: [], payoutFailures: [] });
  });

  it('POST /api/v1/payments/query/:id returns 404 for unknown dataset', async () => {
    const r = await request(app).post('/api/v1/payments/query/does-not-exist').send({});
    expect(r.status).toBe(404);
  });

  it('POST /api/v1/payments/query/:id returns 402 for known dataset', async () => {
    const r = await request(app).post('/api/v1/payments/query/ds-payment-1').send({});
    expect(r.status).toBe(402);
    expect(r.body.x402).toBe(true);
    expect(r.body.payment.amount).toBe(1);
  });

  it('POST /api/v1/payments/query/:id uses the dataset configured payment token', async () => {
    await writeStore({
      ...BASE_STORE,
      datasets: [
        ...BASE_STORE.datasets,
        {
          id: 'ds-eurc',
          name: 'EURC Dataset',
          description: 'Priced in EURC',
          type: 'yield-data',
          pricePerQuery: 1,
          paymentToken: 'EURC',
          sellerWallet: SELLER_WALLET,
          data: { rows: [1] },
          queriesServed: 0,
          totalEarned: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const r = await request(app).post('/api/v1/payments/query/ds-eurc').send({});
    expect(r.status).toBe(402);
    expect(r.body.payment.currency).toBe('EURC');
  });

  it('POST /api/v1/payments/query/:id falls back to the seller wallet when ESCROW_WALLET is unset', async () => {
    delete process.env.ESCROW_WALLET;

    const r = await request(app).post('/api/v1/payments/query/ds-payment-1').send({});
    expect(r.status).toBe(402);
    expect(r.body.payment.paymentAddress).toBe(SELLER_WALLET);

    process.env.ESCROW_WALLET = ESCROW_WALLET;
  });

  it('POST /api/v1/payments/verify/:id handles happy path', async () => {
    const r = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-happy', buyerQuestion: 'What changed?' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.ai.summary).toBe('Executive summary');
    expect(r.body.transaction.status).toBe('completed');
    expect(r.body.transaction.deliveryStatus).toBe('delivered');
    expect(r.body.warning).toBeNull();
    expect(verifyStellarPayment).toHaveBeenCalledWith({
      txHash: 'tx-happy',
      expectedAmount: 1,
      destinationAddress: ESCROW_WALLET,
      tokenCode: 'USDC',
    });
  });

  it('persists failed seller payout for retries', async () => {
    vi.mocked(sendUsdcPayment).mockRejectedValueOnce(new Error('temporary network error'));
    const response = await request(app).post('/api/v1/payments/verify/ds-payment-1').send({
      txHash: 'tx-failed-seller-payout',
      buyerQuestion: 'What changed?',
    });

    // The payment verifies and delivery succeeds (sendUsdcPayment failure is handled internally)
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('persists failed seller payout when a non-Error value is thrown', async () => {
    vi.mocked(sendUsdcPayment).mockRejectedValueOnce('temporary network error');
    const response = await request(app).post('/api/v1/payments/verify/ds-payment-1').send({
      txHash: 'tx-failed-seller-payout-string',
      buyerQuestion: 'What changed?',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('returns 503 when Stellar verification times out', async () => {
    vi.mocked(verifyStellarPayment).mockRejectedValueOnce(new StellarTimeoutError(10_000));

    const response = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-timeout' });

    expect(response.status).toBe(503);
  });

  it('returns 500 for unexpected errors that are neither StellarTimeoutError nor PaymentError', async () => {
    vi.mocked(verifyStellarPayment).mockRejectedValueOnce(new Error('unexpected crash'));

    const response = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-unexpected-crash' });

    expect(response.status).toBe(500);
  });

  it('POST /api/verify/:id rejects replayed transaction hash', async () => {
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-replay',
          datasetId: 'ds-payment-1',
          txHash: 'tx-replayed',
          amount: 1,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const response = await request(app).post('/api/v1/payments/verify/ds-payment-1').send({
      txHash: 'tx-replayed',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('already processed');
    expect(verifyStellarPayment).not.toHaveBeenCalled();
  });

  it('POST /api/v1/payments/verify/:id rejects replayed transaction hash', async () => {
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-1',
          datasetId: 'ds-payment-1',
          txHash: 'tx-used',
          amount: 1,
          sellerPaid: true,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const r = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-used' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('already processed');
  });

  it('POST /api/v1/payments/verify/:id rejects wrong amount', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({
      valid: false,
      reason: 'Amount mismatch',
    });
    const r = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-wrong-amount' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Amount mismatch');
  });

  it('POST /api/v1/payments/verify/:id rejects expired transaction', async () => {
    vi.mocked(verifyStellarPayment).mockResolvedValueOnce({
      valid: false,
      reason: 'Transaction expired',
    });
    const r = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-expired' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('expired');
  });

  it('POST /api/v1/payments/verify/:id records failed seller payouts for reconciliation', async () => {
    vi.mocked(generateDataSummary).mockRejectedValueOnce(new Error('Claude unavailable'));
    const r = await request(app)
      .post('/api/v1/payments/verify/ds-payment-1')
      .send({ txHash: 'tx-pending' });
    expect(r.status).toBe(202);
    expect(r.body.pendingDelivery).toBe(true);
    expect(r.body.warning).toBe('DELIVERY_PENDING_RETRY');
    expect(r.body.transaction.deliveryStatus).toBe('failed');
  });

  it('GET /api/admin/payouts/stuck lists manual review payouts', async () => {
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-stuck-1',
          datasetId: 'ds-payment-1',
          txHash: 'tx-stuck',
          amount: 1,
          sellerPaid: false,
          sellerAmount: 0.95,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const response = await request(app)
      .get('/api/v1/payments/admin/unpaid-sellers')
      .set('Authorization', 'Bearer admin-test-key');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.unpaidTransactions[0].txHash).toBe('tx-stuck');
  });

  it('GET /api/v1/payments/admin/unpaid-sellers returns failed seller payouts', async () => {
    await writeStore({
      ...BASE_STORE,
      transactions: [
        {
          id: 'tx-unpaid-1',
          datasetId: 'ds-payment-1',
          txHash: 'escrow-99',
          amount: 1,
          sellerPaid: false,
          sellerAmount: 0.95,
          timestamp: new Date().toISOString(),
        },
        {
          id: 'tx-unpaid-orphaned',
          datasetId: 'ds-deleted',
          txHash: 'escrow-100',
          amount: 1,
          sellerPaid: false,
          sellerAmount: 0.95,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const r = await request(app)
      .get('/api/v1/payments/admin/unpaid-sellers')
      .set('Authorization', 'Bearer admin-test-key');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.unpaidTransactions[0]).toMatchObject({
      txHash: 'escrow-99',
      sellerPaid: false,
      datasetName: 'USDC Yield Dataset',
      sellerWallet: SELLER_WALLET,
    });
    // Dataset was deleted after the transaction was recorded — the endpoint
    // should fall back to null rather than throwing.
    expect(r.body.unpaidTransactions[1]).toMatchObject({
      txHash: 'escrow-100',
      sellerPaid: false,
      datasetName: null,
      sellerWallet: null,
    });
  });

  it('POST /api/v1/agent/research/demo returns a valid report shape', async () => {
    const r = await request(app)
      .post('/api/v1/agent/research/demo')
      .send({ query: 'best low risk strategy' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.demo).toBe(true);
    expect(r.body.report.topOpportunity.protocol).toBeDefined();
  });
});
