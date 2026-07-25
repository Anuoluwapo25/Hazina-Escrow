import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../lib/escrow.client', () => ({
  getEscrow: vi.fn(),
}));

vi.mock('../ai/claude.service', () => ({
  generateDataSummary: vi.fn(() =>
    Promise.resolve({ summary: 'Executive summary', answer: 'Answer' }),
  ),
}));

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../notifications/email.service', () => ({
  sendSellerNotificationEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock('../common/datadog', () => ({
  domainMetrics: {
    paymentVerified: vi.fn(),
    datasetQueried: vi.fn(),
    paymentDeliveryFailed: vi.fn(),
    deliveryRetryAttempt: vi.fn(),
  },
}));

vi.mock('../common/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/storage')>();
  return {
    ...actual,
    getDataset: vi.fn(),
    getTransactionByHash: vi.fn(() => Promise.resolve(undefined)),
    addTransaction: vi.fn(() => Promise.resolve()),
    updateDataset: vi.fn(() => Promise.resolve()),
    updateTransactionByHash: vi.fn(() => Promise.resolve(null)),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { processEscrowPayment } from './payments.service';
import { PaymentError } from './stellar.service';
import { getEscrow } from '../lib/escrow.client';
import { getDataset, getTransactionByHash } from '../common/storage';
import type { Dataset } from '../common/storage';

const SELLER = `G${'A'.repeat(55)}`;
const BUYER = `G${'B'.repeat(55)}`;

const DATASET: Dataset = {
  id: 'ds-1',
  name: 'Test Dataset',
  description: 'desc',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER,
  data: { rows: [1] },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
};

function escrowState(overrides = {}) {
  return {
    escrowId: 7,
    datasetId: 'ds-1',
    buyer: BUYER,
    seller: SELLER,
    amountStroops: '10000000',
    amount: 1,
    token: 'C',
    deadline: 123,
    buyerConfirmed: false,
    platformFeeBps: 500,
    released: false,
    refunded: false,
    disputed: false,
    ...overrides,
  };
}

describe('processEscrowPayment', () => {
  beforeEach(() => {
    vi.mocked(getDataset).mockResolvedValue(DATASET);
    vi.mocked(getTransactionByHash).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('verifies a valid on-chain escrow and delivers the dataset', async () => {
    vi.mocked(getEscrow).mockResolvedValue(escrowState());
    const result = await processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' });
    expect(result.success).toBe(true);
    expect(result.transaction.deliveryStatus).toBe('delivered');
    expect(result.ai?.summary).toBe('Executive summary');
  });

  it('throws when the dataset is missing', async () => {
    vi.mocked(getDataset).mockResolvedValue(undefined as unknown as Dataset);
    await expect(processEscrowPayment({ escrowId: 7, datasetId: 'x' })).rejects.toBeInstanceOf(
      PaymentError,
    );
  });

  it('rejects an escrow locked for a different dataset', async () => {
    vi.mocked(getEscrow).mockResolvedValue(escrowState({ datasetId: 'other' }));
    await expect(processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' })).rejects.toThrow(
      /different dataset/,
    );
  });

  it('rejects an already-settled escrow', async () => {
    vi.mocked(getEscrow).mockResolvedValue(escrowState({ released: true }));
    await expect(processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' })).rejects.toThrow(
      /already settled/,
    );
  });

  it('rejects a seller mismatch', async () => {
    vi.mocked(getEscrow).mockResolvedValue(escrowState({ seller: BUYER }));
    await expect(processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' })).rejects.toThrow(
      /seller does not match/,
    );
  });

  it('rejects an amount mismatch', async () => {
    vi.mocked(getEscrow).mockResolvedValue(escrowState({ amount: 5 }));
    await expect(processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' })).rejects.toThrow(
      /amount mismatch/i,
    );
  });

  it('short-circuits when the escrow purchase was already completed', async () => {
    vi.mocked(getTransactionByHash).mockResolvedValue({
      id: 'tx-1',
      datasetId: 'ds-1',
      txHash: 'escrow-7',
      amount: 1,
      status: 'completed',
      aiSummary: 'cached',
      sellerAmount: 0.95,
      timestamp: new Date().toISOString(),
    });
    const result = await processEscrowPayment({ escrowId: 7, datasetId: 'ds-1' });
    expect(result.transaction.status).toBe('completed');
    expect(result.ai?.summary).toBe('cached');
    // Should not even read the chain for a completed purchase.
    expect(getEscrow).not.toHaveBeenCalled();
  });
});
