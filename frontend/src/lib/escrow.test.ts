import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
  isAllowed: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    buildEscrowLock: vi.fn(),
    submitEscrowLock: vi.fn(),
    buildConfirmDelivery: vi.fn(),
    buildRaiseDispute: vi.fn(),
  },
}));

import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  isAllowed as freighterIsAllowed,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api';
import { api } from './api';
import { lockFundsInEscrow, confirmDelivery, raiseDispute, escrowStatusLabel } from './escrow';
import { initEnv } from './env';

const BUYER = `G${'B'.repeat(55)}`;

describe('escrow (buyer-side)', () => {
  beforeEach(() => {
    initEnv();
    vi.clearAllMocks();
    (freighterIsConnected as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterIsAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterRequestAccess as ReturnType<typeof vi.fn>).mockResolvedValue(BUYER);
    (freighterSignTransaction as ReturnType<typeof vi.fn>).mockResolvedValue('signed-xdr');
  });

  it('locks funds: build → sign → submit, returning the escrow id', async () => {
    (api.buildEscrowLock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'unsigned-xdr',
      contractId: 'C...',
      amount: 1,
    });
    (api.submitEscrowLock as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      txHash: 'lock-hash',
      escrowId: 42,
    });

    const result = await lockFundsInEscrow('ds-1', 1);

    expect(api.buildEscrowLock).toHaveBeenCalledWith(BUYER, 'ds-1', 1, undefined);
    expect(freighterSignTransaction).toHaveBeenCalledWith('unsigned-xdr', expect.any(Object));
    expect(api.submitEscrowLock).toHaveBeenCalledWith('signed-xdr');
    expect(result).toEqual({ escrowId: 42, txHash: 'lock-hash', buyer: BUYER });
  });

  it('confirms delivery by signing the built transaction', async () => {
    (api.buildConfirmDelivery as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'confirm-xdr',
    });
    const signed = await confirmDelivery(42);
    expect(api.buildConfirmDelivery).toHaveBeenCalledWith(BUYER, 42);
    expect(signed).toBe('signed-xdr');
  });

  it('raises a dispute by signing the built transaction', async () => {
    (api.buildRaiseDispute as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'dispute-xdr',
    });
    const signed = await raiseDispute(42, 'ab'.repeat(32));
    expect(api.buildRaiseDispute).toHaveBeenCalledWith(BUYER, 42, 'ab'.repeat(32));
    expect(signed).toBe('signed-xdr');
  });

  describe('escrowStatusLabel', () => {
    const base = { released: false, refunded: false, disputed: false, buyerConfirmed: false };
    it('maps flags to a status in priority order', () => {
      expect(escrowStatusLabel(base)).toBe('locked');
      expect(escrowStatusLabel({ ...base, buyerConfirmed: true })).toBe('confirmed');
      expect(escrowStatusLabel({ ...base, disputed: true })).toBe('disputed');
      expect(escrowStatusLabel({ ...base, refunded: true })).toBe('refunded');
      expect(escrowStatusLabel({ ...base, released: true })).toBe('released');
      // released wins over everything
      expect(
        escrowStatusLabel({ released: true, refunded: true, disputed: true, buyerConfirmed: true }),
      ).toBe('released');
    });
  });
});
