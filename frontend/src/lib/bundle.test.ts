import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
  isAllowed: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    buildBundlePurchase: vi.fn(),
    submitBundlePurchase: vi.fn(),
    buildBundleConfirmations: vi.fn(),
    submitBundleConfirmation: vi.fn(),
    getBundlePurchase: vi.fn(),
  },
}));

import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  isAllowed as freighterIsAllowed,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api';
import { api } from './api';
import { purchaseBundle, confirmBundleDelivery, bundlePurchaseStatusLabel } from './bundle';
import { initEnv } from './env';
import type { BundlePurchase } from './api';

const BUYER = `G${'B'.repeat(55)}`;

function makePurchase(overrides: Partial<BundlePurchase> = {}): BundlePurchase {
  return {
    id: 'purchase-1',
    bundleId: 'bundle-1',
    buyerWallet: BUYER,
    firstEscrowId: 100,
    escrowIds: [100, 101, 102, 103],
    totalAmount: 0.12,
    status: 'delivered',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('bundle (buyer-side)', () => {
  beforeEach(() => {
    initEnv();
    vi.clearAllMocks();
    (freighterIsConnected as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterIsAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterRequestAccess as ReturnType<typeof vi.fn>).mockResolvedValue(BUYER);
    (freighterSignTransaction as ReturnType<typeof vi.fn>).mockResolvedValue('signed-xdr');
  });

  describe('purchaseBundle', () => {
    it('builds, signs, and submits the lock_multi transaction', async () => {
      (api.buildBundlePurchase as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        xdr: 'unsigned-lock-multi-xdr',
        contractId: 'CCONTRACT',
        bundleId: 'bundle-1',
        componentCount: 4,
        totalPrice: 0.12,
      });
      (api.submitBundlePurchase as ReturnType<typeof vi.fn>).mockResolvedValue(makePurchase());

      const result = await purchaseBundle('bundle-1');

      expect(api.buildBundlePurchase).toHaveBeenCalledWith('bundle-1', BUYER);
      expect(freighterSignTransaction).toHaveBeenCalledWith(
        'unsigned-lock-multi-xdr',
        expect.any(Object),
      );
      expect(api.submitBundlePurchase).toHaveBeenCalledWith('bundle-1', BUYER, 'signed-xdr');
      expect(result.buyer).toBe(BUYER);
      expect(result.purchase.status).toBe('delivered');
    });
  });

  describe('confirmBundleDelivery', () => {
    it('signs and submits one confirm_delivery per unconfirmed leg, sequentially', async () => {
      (api.buildBundleConfirmations as ReturnType<typeof vi.fn>).mockResolvedValue([
        { escrowId: 100, xdr: 'confirm-xdr-100' },
        { escrowId: 101, xdr: 'confirm-xdr-101' },
      ]);
      (api.submitBundleConfirmation as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makePurchase({ status: 'delivered' }))
        .mockResolvedValueOnce(makePurchase({ status: 'released', releaseTxHash: 'release-tx' }));

      const progressCalls: Array<[number, number]> = [];
      const result = await confirmBundleDelivery('purchase-1', (confirmed, total) =>
        progressCalls.push([confirmed, total]),
      );

      expect(api.buildBundleConfirmations).toHaveBeenCalledWith('purchase-1', BUYER);
      expect(freighterSignTransaction).toHaveBeenCalledWith('confirm-xdr-100', expect.any(Object));
      expect(freighterSignTransaction).toHaveBeenCalledWith('confirm-xdr-101', expect.any(Object));
      expect(api.submitBundleConfirmation).toHaveBeenNthCalledWith(
        1,
        'purchase-1',
        100,
        'signed-xdr',
      );
      expect(api.submitBundleConfirmation).toHaveBeenNthCalledWith(
        2,
        'purchase-1',
        101,
        'signed-xdr',
      );
      // The final returned purchase is the result of the LAST confirmation (the one that released).
      expect(result.status).toBe('released');
      expect(result.releaseTxHash).toBe('release-tx');
      expect(progressCalls).toEqual([
        [1, 2],
        [2, 2],
      ]);
    });

    it('falls back to reading the current purchase when there is nothing left to confirm', async () => {
      (api.buildBundleConfirmations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (api.getBundlePurchase as ReturnType<typeof vi.fn>).mockResolvedValue({
        purchase: makePurchase({ status: 'released' }),
        components: [],
      });

      const result = await confirmBundleDelivery('purchase-1');

      expect(api.submitBundleConfirmation).not.toHaveBeenCalled();
      expect(result.status).toBe('released');
    });
  });

  describe('bundlePurchaseStatusLabel', () => {
    it('maps every status to a human-readable label', () => {
      expect(bundlePurchaseStatusLabel('locked')).toMatch(/locked/i);
      expect(bundlePurchaseStatusLabel('delivering')).toMatch(/delivering/i);
      expect(bundlePurchaseStatusLabel('delivered')).toMatch(/confirm/i);
      expect(bundlePurchaseStatusLabel('released')).toMatch(/released/i);
      expect(bundlePurchaseStatusLabel('refunding')).toMatch(/refund/i);
      expect(bundlePurchaseStatusLabel('refunded')).toMatch(/refund/i);
      expect(bundlePurchaseStatusLabel('failed')).toMatch(/fail/i);
    });
  });
});
