import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bundle, BundlePurchase, BundlePurchaseComponent, Dataset } from '../common/storage';

vi.mock('../common/storage', () => ({
  addBundlePurchase: vi.fn(() => Promise.resolve()),
  addBundlePurchaseComponent: vi.fn(() => Promise.resolve()),
  createBundle: vi.fn(),
  getAllBundles: vi.fn(() => Promise.resolve([])),
  getAllDatasets: vi.fn(() => Promise.resolve([])),
  getBundle: vi.fn(),
  getBundlePurchase: vi.fn(),
  getBundlePurchaseComponents: vi.fn(() => Promise.resolve([])),
  getBundlePurchaseComponentsForSeller: vi.fn(() => Promise.resolve([])),
  getBundlePurchasesForBundle: vi.fn(() => Promise.resolve([])),
  getBundlesByCurator: vi.fn(() => Promise.resolve([])),
  getBundlesContainingDataset: vi.fn(() => Promise.resolve([])),
  getDataset: vi.fn(),
  updateBundlePurchase: vi.fn(),
  updateBundlePurchaseComponent: vi.fn(() => Promise.resolve(null)),
  updateDataset: vi.fn(() => Promise.resolve(null)),
  BundleShareMismatchError: class BundleShareMismatchError extends Error {},
}));

vi.mock('../lib/escrow.client', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/escrow.client')>();
  return {
    ...actual,
    buildLockMultiTx: vi.fn(() =>
      Promise.resolve({ xdr: 'unsigned-lock-multi-xdr', contractId: 'CCONTRACT' }),
    ),
    submitSignedLockMulti: vi.fn(),
    buildConfirmDeliveryTx: vi.fn(({ escrowId }: { escrowId: number }) =>
      Promise.resolve({ xdr: `confirm-xdr-${escrowId}` }),
    ),
    submitSignedConfirmDelivery: vi.fn(() => Promise.resolve({ txHash: 'confirm-tx' })),
    releaseMultiEscrow: vi.fn(() => Promise.resolve('release-tx-hash')),
    refundEscrow: vi.fn(() => Promise.resolve('refund-tx-hash')),
  };
});

vi.mock('../ai/research.service', () => ({
  synthesizeResearch: vi.fn(() =>
    Promise.resolve({
      topOpportunity: {
        protocol: '',
        vault: '',
        chain: '',
        apy: 0,
        riskLevel: '',
        whaleConfidence: '',
        sentimentScore: '',
      },
      reasoning: '',
      alternatives: [],
      warnings: [],
      rawAnalysis: 'Cross-dataset synthesis of the bundle',
    }),
  ),
}));

vi.mock('../snapshots/snapshots.service', () => ({
  recordDatasetSnapshot: vi.fn(() => Promise.resolve({ snapshot: { id: 'snap-1' } })),
}));

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

import {
  createBundleRecord,
  buildBundlePurchaseLockTx,
  submitBundlePurchase,
  buildBundleConfirmTxs,
  submitBundleConfirmation,
  computeBundleAvailability,
  listBundlesWithAvailability,
  getBundleWithAvailability,
  BundleUnavailableError,
  BundleNotFoundError,
  BundlePurchaseStateError,
} from './bundle.service';
import { InvalidBundleSplitError } from './bundle.splits';
import {
  getDataset,
  getBundle,
  createBundle,
  addBundlePurchase,
  addBundlePurchaseComponent,
  getBundlePurchase,
  getBundlePurchaseComponents,
  updateBundlePurchase,
  updateBundlePurchaseComponent,
  updateDataset,
  getAllBundles,
} from '../common/storage';
import {
  buildLockMultiTx,
  submitSignedLockMulti,
  releaseMultiEscrow,
  refundEscrow,
  toStroops,
} from '../lib/escrow.client';

const SELLER_A = `G${'A'.repeat(55)}`;
const SELLER_B = `G${'B'.repeat(55)}`;
const CURATOR = `G${'C'.repeat(55)}`;
const BUYER = `G${'D'.repeat(55)}`;

function makeDataset(overrides: Partial<Dataset> & { id: string; sellerWallet: string }): Dataset {
  return {
    name: overrides.id,
    description: 'test dataset',
    type: 'whale-movements',
    pricePerQuery: 1,
    data: { foo: 'bar' },
    queriesServed: 0,
    totalEarned: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'DeFi Risk Pack',
    description: 'Whale + risk + sentiment',
    curatorWallet: CURATOR,
    totalPrice: 0.12,
    paymentToken: 'USDC',
    curatorFeeBps: 1000,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    components: [
      {
        id: 'c1',
        bundleId: 'bundle-1',
        datasetId: 'ds-whale',
        shareBps: 4500,
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'c2',
        bundleId: 'bundle-1',
        datasetId: 'ds-risk',
        shareBps: 3000,
        position: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'c3',
        bundleId: 'bundle-1',
        datasetId: 'ds-sentiment',
        shareBps: 1500,
        position: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const DATASETS_BY_ID: Record<string, Dataset> = {
  'ds-whale': makeDataset({ id: 'ds-whale', sellerWallet: SELLER_A }),
  'ds-risk': makeDataset({ id: 'ds-risk', sellerWallet: SELLER_B }),
  'ds-sentiment': makeDataset({ id: 'ds-sentiment', sellerWallet: SELLER_B }),
};

/** Fixture lookups the test itself controls and knows must succeed — throws instead of risking a silent `undefined`. */
function mustGet<T>(value: T | undefined, context: string): T {
  if (value === undefined) throw new Error(`Test fixture error: expected ${context}`);
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDataset).mockImplementation(async (id: string) => DATASETS_BY_ID[id]);
  vi.mocked(updateBundlePurchase).mockImplementation(async (id: string, updates) => {
    const existing = mustGet(await getBundlePurchase(id), `an existing purchase ${id}`);
    return { ...existing, ...updates };
  });
  vi.mocked(updateBundlePurchaseComponent).mockImplementation(async () => null);
});

describe('createBundleRecord', () => {
  const validInput = {
    name: 'DeFi Risk Pack',
    description: 'desc',
    curatorWallet: CURATOR,
    totalPrice: 0.12,
    curatorFeeBps: 1000,
    components: [
      { datasetId: 'ds-whale', shareBps: 4500 },
      { datasetId: 'ds-risk', shareBps: 3000 },
      { datasetId: 'ds-sentiment', shareBps: 1500 },
    ],
  };

  it('creates a bundle when splits sum to 10000 and every component is live', async () => {
    vi.mocked(createBundle).mockImplementation(async (bundle, components) => ({
      ...bundle,
      components,
    }));

    const bundle = await createBundleRecord(validInput);

    expect(bundle.components).toHaveLength(3);
    expect(createBundle).toHaveBeenCalledTimes(1);
  });

  it('rejects a split that does not sum to 10000 before touching storage', async () => {
    await expect(createBundleRecord({ ...validInput, curatorFeeBps: 500 })).rejects.toThrow(
      InvalidBundleSplitError,
    );
    expect(createBundle).not.toHaveBeenCalled();
  });

  it('rejects a bundle containing a delisted dataset', async () => {
    vi.mocked(getDataset).mockImplementation(async (id: string) => {
      if (id === 'ds-risk')
        return { ...mustGet(DATASETS_BY_ID['ds-risk'], 'fixture ds-risk'), active: false };
      return DATASETS_BY_ID[id];
    });

    await expect(createBundleRecord(validInput)).rejects.toThrow(/delisted/);
    expect(createBundle).not.toHaveBeenCalled();
  });

  it('rejects a bundle containing a dataset that does not exist', async () => {
    vi.mocked(getDataset).mockImplementation(async (id: string) =>
      id === 'ds-risk' ? undefined : DATASETS_BY_ID[id],
    );

    await expect(createBundleRecord(validInput)).rejects.toThrow(/does not exist/);
  });

  it('allows two components from the same seller (duplicate seller, distinct datasets)', async () => {
    vi.mocked(createBundle).mockImplementation(async (bundle, components) => ({
      ...bundle,
      components,
    }));
    // ds-risk and ds-sentiment are both owned by SELLER_B in the fixture above.
    const bundle = await createBundleRecord(validInput);
    const sellers = bundle.components.map(
      c => mustGet(DATASETS_BY_ID[c.datasetId], `fixture ${c.datasetId}`).sellerWallet,
    );
    expect(sellers.filter(s => s === SELLER_B)).toHaveLength(2);
  });
});

describe('computeBundleAvailability / listBundlesWithAvailability', () => {
  it('is not degraded when the bundle and every component dataset are active', async () => {
    const availability = await computeBundleAvailability(makeBundle());
    expect(availability.degraded).toBe(false);
  });

  it('is degraded when the bundle itself has been deactivated', async () => {
    const availability = await computeBundleAvailability(makeBundle({ active: false }));
    expect(availability.degraded).toBe(true);
    expect(availability.degradedReason).toMatch(/deactivated/);
  });

  it('is degraded with a reason when a component dataset has been delisted', async () => {
    vi.mocked(getDataset).mockImplementation(async (id: string) => {
      if (id === 'ds-sentiment')
        return {
          ...mustGet(DATASETS_BY_ID['ds-sentiment'], 'fixture ds-sentiment'),
          active: false,
        };
      return DATASETS_BY_ID[id];
    });

    const availability = await computeBundleAvailability(makeBundle());
    expect(availability.degraded).toBe(true);
    expect(availability.degradedReason).toMatch(/delisted/);
  });

  it('is degraded with a reason when a component dataset no longer exists', async () => {
    vi.mocked(getDataset).mockImplementation(async (id: string) =>
      id === 'ds-whale' ? undefined : DATASETS_BY_ID[id],
    );

    const availability = await computeBundleAvailability(makeBundle());
    expect(availability.degraded).toBe(true);
    expect(availability.degradedReason).toMatch(/no longer exists/);
  });

  it('getBundleWithAvailability returns undefined for a missing bundle', async () => {
    vi.mocked(getBundle).mockResolvedValue(undefined);
    expect(await getBundleWithAvailability('missing')).toBeUndefined();
  });

  it('listBundlesWithAvailability annotates every bundle returned by storage', async () => {
    vi.mocked(getAllBundles).mockResolvedValue([
      makeBundle(),
      makeBundle({ id: 'bundle-2', active: false }),
    ]);
    const bundles = await listBundlesWithAvailability();
    expect(bundles).toHaveLength(2);
    expect(bundles.find(b => b.id === 'bundle-1')?.degraded).toBe(false);
    expect(bundles.find(b => b.id === 'bundle-2')?.degraded).toBe(true);
  });
});

describe('buildBundlePurchaseLockTx', () => {
  it('throws BundleNotFoundError for a missing bundle', async () => {
    vi.mocked(getBundle).mockResolvedValue(undefined);
    await expect(buildBundlePurchaseLockTx('missing', BUYER)).rejects.toThrow(BundleNotFoundError);
  });

  it('throws BundleUnavailableError for a degraded bundle and never calls buildLockMultiTx', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle({ active: false }));
    await expect(buildBundlePurchaseLockTx('bundle-1', BUYER)).rejects.toThrow(
      BundleUnavailableError,
    );
    expect(buildLockMultiTx).not.toHaveBeenCalled();
  });

  it('builds a lock_multi with one SellerShare per component plus the curator fee leg', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle());

    const result = await buildBundlePurchaseLockTx('bundle-1', BUYER);

    expect(result.componentCount).toBe(4); // 3 datasets + curator leg
    expect(buildLockMultiTx).toHaveBeenCalledTimes(1);
    const call = mustGet(
      vi.mocked(buildLockMultiTx).mock.calls[0],
      'the first buildLockMultiTx call',
    )[0];
    expect(call.buyer).toBe(BUYER);
    expect(call.shares).toHaveLength(4);
    expect(call.datasetIds).toHaveLength(4);

    // Sum of all locked stroops must equal exactly the bundle's total price in stroops.
    const totalStroops = toStroops(0.12);
    const sum = call.shares.reduce((s, share) => s + BigInt(share.amount), 0n);
    expect(sum).toBe(totalStroops);
  });
});

describe('submitBundlePurchase', () => {
  // A minimal in-memory fake standing in for the DB layer, so
  // submitBundlePurchase's full read-your-own-writes flow (persist, then
  // immediately re-read to deliver) exercises real state instead of
  // independently-stubbed no-ops.
  let fakePurchases: Map<string, BundlePurchase>;
  let fakeComponents: Map<string, BundlePurchaseComponent>;

  beforeEach(() => {
    fakePurchases = new Map();
    fakeComponents = new Map();

    vi.mocked(addBundlePurchase).mockImplementation(async p => {
      fakePurchases.set(p.id, p);
    });
    vi.mocked(getBundlePurchase).mockImplementation(async id => fakePurchases.get(id));
    vi.mocked(updateBundlePurchase).mockImplementation(async (id, updates) => {
      const existing = fakePurchases.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...updates };
      fakePurchases.set(id, merged);
      return merged;
    });
    vi.mocked(addBundlePurchaseComponent).mockImplementation(async c => {
      fakeComponents.set(c.id, c);
    });
    vi.mocked(getBundlePurchaseComponents).mockImplementation(async purchaseId =>
      [...fakeComponents.values()].filter(c => c.purchaseId === purchaseId),
    );
    vi.mocked(updateBundlePurchaseComponent).mockImplementation(async (id, updates) => {
      const existing = fakeComponents.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...updates };
      fakeComponents.set(id, merged);
      return merged;
    });
  });

  function mockLockMultiSubmit(componentCount: number, firstEscrowId = 100) {
    vi.mocked(submitSignedLockMulti).mockResolvedValue({
      txHash: 'lock-multi-tx',
      firstEscrowId,
      escrowIds: Array.from({ length: componentCount }, (_, i) => firstEscrowId + i),
    });
  }

  /**
   * submitBundlePurchase re-checks every component is still live right
   * before ever submitting the buyer's signed transaction — so to test the
   * real "delivered-then-fails" race (the dataset was fine when the buyer
   * locked funds, then went away before delivery ran), the mocked
   * `getDataset` must only start reporting the failure once the lock has
   * actually gone through.
   */
  function mockLockMultiSubmitThenDelist(datasetId: string, reason: 'delisted' | 'deleted') {
    let locked = false;
    vi.mocked(submitSignedLockMulti).mockImplementation(async () => {
      locked = true;
      return { txHash: 'lock-multi-tx', firstEscrowId: 100, escrowIds: [100, 101, 102, 103] };
    });
    vi.mocked(getDataset).mockImplementation(async (id: string) => {
      if (id === datasetId && locked) {
        return reason === 'deleted'
          ? undefined
          : { ...mustGet(DATASETS_BY_ID[datasetId], `fixture ${datasetId}`), active: false };
      }
      return DATASETS_BY_ID[id];
    });
  }

  it('persists a purchase and one component per leg, then delivers successfully', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle());
    mockLockMultiSubmit(4);

    const purchase = await submitBundlePurchase('bundle-1', BUYER, 'signed-xdr');

    expect(addBundlePurchase).toHaveBeenCalledTimes(1);
    expect(addBundlePurchaseComponent).toHaveBeenCalledTimes(4);
    expect(purchase.status).toBe('delivered');
    expect(purchase.escrowIds).toEqual([100, 101, 102, 103]);

    // The persisted per-component amounts (converted back to stroops) sum exactly
    // to what was locked — integer arithmetic, no floating-point drift.
    const persistedAmounts = vi
      .mocked(addBundlePurchaseComponent)
      .mock.calls.map(([component]) => component.amount);
    const totalStroops = toStroops(0.12);
    const sumStroops = persistedAmounts.reduce((s, amount) => s + toStroops(amount), 0n);
    expect(sumStroops).toBe(totalStroops);
  });

  it('handles two components from the same seller as two distinct escrow legs', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle()); // ds-risk and ds-sentiment both SELLER_B
    mockLockMultiSubmit(4);

    await submitBundlePurchase('bundle-1', BUYER, 'signed-xdr');

    const components = vi.mocked(addBundlePurchaseComponent).mock.calls.map(([c]) => c);
    const sellerBLegs = components.filter(c => c.sellerWallet === SELLER_B);
    expect(sellerBLegs).toHaveLength(2);
    expect(new Set(sellerBLegs.map(c => c.escrowId)).size).toBe(2); // distinct escrow ids
    expect(new Set(sellerBLegs.map(c => c.datasetId)).size).toBe(2); // distinct datasets
  });

  it('refunds the whole batch and pays no seller when one component fails to deliver (delisted mid-flight)', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle());
    // The dataset was live when the buyer locked funds, but got delisted before delivery ran.
    mockLockMultiSubmitThenDelist('ds-sentiment', 'delisted');

    const purchase = await submitBundlePurchase('bundle-1', BUYER, 'signed-xdr');

    expect(purchase.status).toBe('refunded');
    expect(purchase.failureReason).toMatch(/ds-sentiment/);
    expect(refundEscrow).toHaveBeenCalledTimes(4);
    expect(refundEscrow).toHaveBeenCalledWith(100);
    expect(refundEscrow).toHaveBeenCalledWith(101);
    expect(refundEscrow).toHaveBeenCalledWith(102);
    expect(refundEscrow).toHaveBeenCalledWith(103);

    // No dataset stats were ever touched — the failure is caught before any payout side effect.
    expect(updateDataset).not.toHaveBeenCalled();
  });

  it('refunds the whole batch when a component dataset was deleted entirely', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle());
    mockLockMultiSubmitThenDelist('ds-whale', 'deleted');

    const purchase = await submitBundlePurchase('bundle-1', BUYER, 'signed-xdr');

    expect(purchase.status).toBe('refunded');
    expect(purchase.failureReason).toMatch(/deleted/);
    expect(refundEscrow).toHaveBeenCalledTimes(4);
    expect(updateDataset).not.toHaveBeenCalled();
  });

  it('marks the purchase failed (not silently refunded) when a refund call itself errors, for manual reconciliation', async () => {
    vi.mocked(getBundle).mockResolvedValue(makeBundle());
    mockLockMultiSubmitThenDelist('ds-whale', 'deleted');
    vi.mocked(refundEscrow).mockImplementation(async (escrowId: number) => {
      if (escrowId === 101) throw new Error('network blip');
      return 'refund-tx-hash';
    });

    const purchase = await submitBundlePurchase('bundle-1', BUYER, 'signed-xdr');

    expect(purchase.status).toBe('failed');
    expect(purchase.failureReason).toMatch(/needs manual reconciliation/);
    expect(refundEscrow).toHaveBeenCalledTimes(4); // still attempts every leg
  });
});

describe('confirm + release flow', () => {
  function deliveredPurchase(): BundlePurchase {
    return {
      id: 'purchase-1',
      bundleId: 'bundle-1',
      buyerWallet: BUYER,
      firstEscrowId: 100,
      escrowIds: [100, 101, 102, 103],
      totalAmount: 0.12,
      paymentToken: 'USDC',
      status: 'delivered',
      lockTxHash: 'lock-tx',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function componentsFor(
    purchase: BundlePurchase,
    confirmed: number[] = [],
  ): BundlePurchaseComponent[] {
    const datasetIds = ['ds-whale', 'ds-risk', 'ds-sentiment'];
    const sellerWallets = [SELLER_A, SELLER_B, SELLER_B];
    return purchase.escrowIds.map((escrowId, i) => ({
      id: `comp-${i}`,
      purchaseId: purchase.id,
      datasetId: i < 3 ? mustGet(datasetIds[i], `datasetIds[${i}]`) : 'bundle-curator-fee:bundle-1',
      role: i < 3 ? ('dataset' as const) : ('curator' as const),
      escrowId,
      sellerWallet: i < 3 ? mustGet(sellerWallets[i], `sellerWallets[${i}]`) : CURATOR,
      amount: 0.03,
      buyerConfirmed: confirmed.includes(escrowId),
      deliveryStatus: 'delivered' as const,
      deliveryAttempts: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
  }

  it('buildBundleConfirmTxs only builds XDRs for unconfirmed legs', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    vi.mocked(getBundlePurchaseComponents).mockResolvedValue(componentsFor(purchase, [100, 101]));

    const confirmations = await buildBundleConfirmTxs('purchase-1', BUYER);

    expect(confirmations).toHaveLength(2);
    expect(confirmations.map(c => c.escrowId).sort()).toEqual([102, 103]);
  });

  it('buildBundleConfirmTxs rejects a caller who is not the purchase buyer', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    await expect(buildBundleConfirmTxs('purchase-1', SELLER_A)).rejects.toThrow(
      BundlePurchaseStateError,
    );
  });

  it('buildBundleConfirmTxs rejects when the purchase is not yet delivered', async () => {
    vi.mocked(getBundlePurchase).mockResolvedValue({ ...deliveredPurchase(), status: 'locked' });
    await expect(buildBundleConfirmTxs('purchase-1', BUYER)).rejects.toThrow(
      BundlePurchaseStateError,
    );
  });

  it('does not release until every leg is confirmed', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    vi.mocked(getBundlePurchaseComponents).mockResolvedValue(componentsFor(purchase, [100, 101]));

    await submitBundleConfirmation('purchase-1', 102, 'signed-confirm-xdr');

    expect(releaseMultiEscrow).not.toHaveBeenCalled();
  });

  it('automatically calls release_multi once the last leg is confirmed', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    // First read (inside submitBundleConfirmation, pre-update) is missing the last confirm;
    // the refreshed read after marking it confirmed reports everything confirmed.
    vi.mocked(getBundlePurchaseComponents)
      .mockResolvedValueOnce(componentsFor(purchase, [100, 101, 102]))
      .mockResolvedValueOnce(componentsFor(purchase, [100, 101, 102, 103]));

    const result = await submitBundleConfirmation('purchase-1', 103, 'signed-confirm-xdr');

    expect(releaseMultiEscrow).toHaveBeenCalledWith([100, 101, 102, 103]);
    expect(result.status).toBe('released');
    expect(result.releaseTxHash).toBe('release-tx-hash');
    expect(result.aiSummary).toBe('Cross-dataset synthesis of the bundle');
  });

  it('rejects confirming an escrow id that is not part of the purchase', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    vi.mocked(getBundlePurchaseComponents).mockResolvedValue(componentsFor(purchase));
    await expect(submitBundleConfirmation('purchase-1', 999, 'xdr')).rejects.toThrow(
      BundlePurchaseStateError,
    );
  });

  it('a release failure never rolls back the confirmations that already landed', async () => {
    const purchase = deliveredPurchase();
    vi.mocked(getBundlePurchase).mockResolvedValue(purchase);
    vi.mocked(getBundlePurchaseComponents)
      .mockResolvedValueOnce(componentsFor(purchase, [100, 101, 102]))
      .mockResolvedValueOnce(componentsFor(purchase, [100, 101, 102, 103]));
    vi.mocked(releaseMultiEscrow).mockRejectedValueOnce(new Error('rpc down'));

    await expect(submitBundleConfirmation('purchase-1', 103, 'xdr')).rejects.toThrow('rpc down');
    // The last leg's buyerConfirmed=true write already happened before the release attempt.
    expect(updateBundlePurchaseComponent).toHaveBeenCalledWith(expect.any(String), {
      buyerConfirmed: true,
    });
  });
});
