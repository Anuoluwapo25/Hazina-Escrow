import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
  isAllowed: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    buildDefinePlanTx: vi.fn(),
    buildSubscribeTx: vi.fn(),
    buildRenewTx: vi.fn(),
    submitSignedAccessTx: vi.fn(),
  },
}));

import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  isAllowed as freighterIsAllowed,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api';
import { api } from './api';
import { subscribeToDataset, renewSubscription, definePlanForDataset } from './accessPass';
import { initEnv } from './env';

const WALLET = `G${'A'.repeat(55)}`;

describe('accessPass (wallet flows)', () => {
  beforeEach(() => {
    initEnv();
    vi.clearAllMocks();
    (freighterIsConnected as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterIsAllowed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (freighterRequestAccess as ReturnType<typeof vi.fn>).mockResolvedValue(WALLET);
    (freighterSignTransaction as ReturnType<typeof vi.fn>).mockResolvedValue('signed-xdr');
  });

  it('subscribes: connect → build → sign → submit, returning the tx hash', async () => {
    (api.buildSubscribeTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'unsigned-xdr',
      contractId: 'C...',
    });
    (api.submitSignedAccessTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      txHash: 'sub-hash',
    });

    const result = await subscribeToDataset('ds-1', 3);

    expect(api.buildSubscribeTx).toHaveBeenCalledWith('ds-1', WALLET, 3);
    expect(freighterSignTransaction).toHaveBeenCalledWith('unsigned-xdr', expect.any(Object));
    expect(api.submitSignedAccessTx).toHaveBeenCalledWith('ds-1', 'signed-xdr');
    expect(result).toEqual({ txHash: 'sub-hash', buyer: WALLET, planId: 3 });
  });

  it('renews by signing the built transaction', async () => {
    (api.buildRenewTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'renew-xdr',
      contractId: 'C...',
    });
    (api.submitSignedAccessTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      txHash: 'renew-hash',
    });

    const result = await renewSubscription('ds-1');

    expect(api.buildRenewTx).toHaveBeenCalledWith('ds-1', WALLET);
    expect(api.submitSignedAccessTx).toHaveBeenCalledWith('ds-1', 'signed-xdr');
    expect(result).toEqual({ txHash: 'renew-hash', buyer: WALLET });
  });

  it('defines a plan with the seller wallet and exact pricing params', async () => {
    (api.buildDefinePlanTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      xdr: 'define-xdr',
      contractId: 'C...',
    });
    (api.submitSignedAccessTx as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      txHash: 'define-hash',
    });

    const result = await definePlanForDataset('ds-1', {
      pricePerPeriod: 0.05,
      periodSeconds: 604_800,
      maxSeats: 25,
    });

    expect(api.buildDefinePlanTx).toHaveBeenCalledWith('ds-1', WALLET, 0.05, 604_800, 25);
    expect(api.submitSignedAccessTx).toHaveBeenCalledWith('ds-1', 'signed-xdr');
    expect(result).toEqual({ txHash: 'define-hash', seller: WALLET });
  });

  it.each([
    {
      name: 'subscribe build fails',
      call: () => subscribeToDataset('ds-1', 3),
      mock: 'buildSubscribeTx' as const,
    },
    {
      name: 'submit fails after signing',
      call: () => renewSubscription('ds-1'),
      mock: 'submitSignedAccessTx' as const,
    },
  ])('propagates $name errors without swallowing them', async ({ call, mock }) => {
    if (mock === 'buildSubscribeTx') {
      (api.buildSubscribeTx as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('All seats for this plan are taken'),
      );
    } else {
      (api.buildRenewTx as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        xdr: 'xdr',
        contractId: 'C...',
      });
      (api.submitSignedAccessTx as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('subscription transaction failed on-chain'),
      );
    }

    await expect(call()).rejects.toThrow();
  });
});
