import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayoutFailure } from '../../common/storage';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

const { store } = vi.hoisted(() => ({
  store: { failures: [] as PayoutFailure[] },
}));

vi.mock('../../common/storage', () => ({
  addPayoutFailure: vi.fn((failure: PayoutFailure) => {
    store.failures.push(failure);
    return Promise.resolve();
  }),
  getPayoutFailureByBuyerTxHash: vi.fn((buyerTxHash: string) =>
    Promise.resolve(store.failures.find(f => f.buyerTxHash === buyerTxHash)),
  ),
  getPayoutFailuresByStatus: vi.fn((status: string) =>
    Promise.resolve(store.failures.filter(f => f.status === status)),
  ),
  getPendingPayoutFailures: vi.fn(() =>
    Promise.resolve(store.failures.filter(f => f.status === 'pending_retry')),
  ),
  updatePayoutFailure: vi.fn((id: string, updates: Partial<PayoutFailure>) => {
    const index = store.failures.findIndex(f => f.id === id);
    if (index === -1) return Promise.resolve(null);
    const merged = { ...store.failures[index], ...updates } as PayoutFailure;
    store.failures[index] = merged;
    return Promise.resolve(merged);
  }),
}));

vi.mock('../../agent/agent.wallet', () => ({
  sendTokenPayment: vi.fn(),
}));

vi.mock('../../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { recordPayoutFailure, runDuePayoutRetries } from '../payout-retry.service';
import { sendTokenPayment } from '../../agent/agent.wallet';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELLER_WALLET = `G${'A'.repeat(55)}`;

function seedFailure(overrides: Partial<PayoutFailure> = {}): PayoutFailure {
  const nowIso = new Date().toISOString();
  const failure: PayoutFailure = {
    id: 'payout-failure-1',
    datasetId: 'ds-token-1',
    sellerWallet: SELLER_WALLET,
    buyerTxHash: 'tx-buyer-1',
    intendedAmount: 0.95,
    paymentToken: 'EURC',
    status: 'pending_retry',
    retryCount: 0,
    nextRetryAt: nowIso,
    lastError: 'no EURC trustline',
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
  store.failures.push(failure);
  return failure;
}

describe('payout retry preserves the original payment token', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.failures.length = 0;
    vi.mocked(sendTokenPayment).mockResolvedValue({
      txHash: 'retry-tx-hash',
      from: 'GAGENT',
      to: SELLER_WALLET,
      amount: '0.9500000',
      tokenCode: 'EURC',
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stores the payment token on a newly recorded failure', async () => {
    await recordPayoutFailure({
      datasetId: 'ds-token-1',
      sellerWallet: SELLER_WALLET,
      buyerTxHash: 'tx-buyer-eurc',
      intendedAmount: 0.95,
      paymentToken: 'EURC',
      error: 'no EURC trustline',
    });

    expect(store.failures[0]?.paymentToken).toBe('EURC');
  });

  it('defaults a recorded failure to USDC when no token is supplied', async () => {
    await recordPayoutFailure({
      datasetId: 'ds-token-1',
      sellerWallet: SELLER_WALLET,
      buyerTxHash: 'tx-buyer-default',
      intendedAmount: 0.95,
      error: 'horizon timeout',
    });

    expect(store.failures[0]?.paymentToken).toBe('USDC');
  });

  it('retries in the original token rather than USDC', async () => {
    seedFailure({ paymentToken: 'EURC' });

    const processed = await runDuePayoutRetries();

    expect(processed).toBe(1);
    expect(sendTokenPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationAddress: SELLER_WALLET,
        amount: '0.9500000',
        tokenCode: 'EURC',
      }),
    );
    expect(store.failures[0]?.status).toBe('paid');
    expect(store.failures[0]?.sellerTxHash).toBe('retry-tx-hash');
  });

  it('retries an XLM payout in XLM', async () => {
    seedFailure({ paymentToken: 'XLM' });

    await runDuePayoutRetries();

    expect(sendTokenPayment).toHaveBeenCalledWith(expect.objectContaining({ tokenCode: 'XLM' }));
  });

  it('retries in USDC for legacy failures recorded without a token', async () => {
    seedFailure({ paymentToken: undefined });

    await runDuePayoutRetries();

    expect(sendTokenPayment).toHaveBeenCalledWith(expect.objectContaining({ tokenCode: 'USDC' }));
  });

  it('keeps the original token on the record when a retry fails', async () => {
    seedFailure({ paymentToken: 'EURC' });
    vi.mocked(sendTokenPayment).mockRejectedValueOnce(new Error('still no trustline'));

    await runDuePayoutRetries();

    expect(store.failures[0]?.status).toBe('pending_retry');
    expect(store.failures[0]?.retryCount).toBe(1);
    expect(store.failures[0]?.paymentToken).toBe('EURC');
  });
});
