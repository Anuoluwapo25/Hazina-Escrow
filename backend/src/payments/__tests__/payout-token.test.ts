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

vi.mock('../../notifications/email.service', () => ({
  sendSellerNotificationEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../agent/agent.wallet', () => ({
  sendTokenPayment: vi.fn(() => Promise.resolve({ txHash: 'seller-tx-hash' })),
  getAgentPublicKey: vi.fn(() => 'GAGENT'),
}));

vi.mock('../trustline.service', () => ({
  checkDestinationReady: vi.fn(() => Promise.resolve({ ready: true })),
  classifyDestinationFailure: vi.fn(() => null),
}));

vi.mock('../payout-retry.service', async importOriginal => {
  const actual = await importOriginal<typeof import('../payout-retry.service')>();
  return {
    ...actual,
    recordPayoutFailure: vi.fn(() => Promise.resolve()),
    scheduleRetrySweep: vi.fn(),
  };
});

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
        datasetId: 'ds-token-1',
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

import { paymentsRouter } from '../payments.router';
import { generateDataSummary } from '../../ai/claude.service';
import { sendSellerNotificationEmail } from '../../notifications/email.service';
import { getDataset, txHashUsed } from '../../common/storage';
import type { Dataset } from '../../common/storage';
import { sendTokenPayment } from '../../agent/agent.wallet';
import { recordPayoutFailure } from '../payout-retry.service';
import { verifyStellarPayment } from '../stellar.service';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_WALLET = `G${'A'.repeat(55)}`;

function datasetWithToken(paymentToken?: string): Dataset {
  return {
    id: 'ds-token-1',
    name: 'Multi Token Dataset',
    description: 'A dataset priced in a non-USDC token',
    type: 'yield-data',
    pricePerQuery: 1,
    sellerWallet: SELLER_WALLET,
    paymentToken,
    data: { rows: [1, 2, 3] },
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
  };
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('seller payouts use the dataset payment token', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
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
      txHash: 'seller-tx-hash',
      from: 'GAGENT',
      to: SELLER_WALLET,
      amount: '0.9500000',
      tokenCode: 'USDC',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pays the seller in EURC when the dataset is priced in EURC', async () => {
    vi.mocked(getDataset).mockResolvedValue(datasetWithToken('EURC'));

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-token-1')
      .send({ txHash: 'tx-eurc' });

    expect(res.status).toBe(200);
    expect(verifyStellarPayment).toHaveBeenCalledWith(
      expect.objectContaining({ tokenCode: 'EURC' }),
    );
    expect(sendTokenPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destinationAddress: SELLER_WALLET, tokenCode: 'EURC' }),
    );
  });

  it('pays the seller in XLM when the dataset is priced in XLM', async () => {
    vi.mocked(getDataset).mockResolvedValue(datasetWithToken('XLM'));

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-token-1')
      .send({ txHash: 'tx-xlm' });

    expect(res.status).toBe(200);
    expect(sendTokenPayment).toHaveBeenCalledWith(expect.objectContaining({ tokenCode: 'XLM' }));
  });

  it('falls back to USDC when the dataset has no payment token', async () => {
    vi.mocked(getDataset).mockResolvedValue(datasetWithToken(undefined));

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-token-1')
      .send({ txHash: 'tx-default' });

    expect(res.status).toBe(200);
    expect(sendTokenPayment).toHaveBeenCalledWith(expect.objectContaining({ tokenCode: 'USDC' }));
  });

  it('records the payment token on the payout failure when the payout fails', async () => {
    vi.mocked(getDataset).mockResolvedValue(datasetWithToken('EURC'));
    vi.mocked(sendTokenPayment).mockRejectedValueOnce(new Error('no EURC trustline'));

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-token-1')
      .send({ txHash: 'tx-eurc-failed' });

    expect(res.status).toBe(200);
    expect(recordPayoutFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: 'ds-token-1',
        buyerTxHash: 'tx-eurc-failed',
        paymentToken: 'EURC',
        error: 'no EURC trustline',
      }),
    );
  });

  it('labels the seller notification email with the dataset token', async () => {
    vi.mocked(getDataset).mockResolvedValue({
      ...datasetWithToken('EURC'),
      notificationEmail: 'seller@example.com',
    });

    const res = await request(app)
      .post('/api/v1/payments/verify/ds-token-1')
      .send({ txHash: 'tx-eurc-email' });

    expect(res.status).toBe(200);
    expect(sendSellerNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'seller@example.com', paymentToken: 'EURC' }),
    );
  });
});
