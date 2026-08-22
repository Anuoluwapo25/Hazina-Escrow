import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createBundle,
  getBundle,
  getAllBundles,
  getBundlesByCurator,
  getBundlesContainingDataset,
  updateBundle,
  addBundlePurchase,
  getBundlePurchase,
  updateBundlePurchase,
  getBundlePurchasesForBundle,
  addBundlePurchaseComponent,
  getBundlePurchaseComponents,
  updateBundlePurchaseComponent,
  getBundlePurchaseComponentsForSeller,
  BundleShareMismatchError,
  type BundleComponentRecord,
  type BundlePurchase,
  type BundlePurchaseComponent,
} from './storage';

const CURATOR = `G${'C'.repeat(55)}`;
const SELLER_A = `G${'A'.repeat(55)}`;
const SELLER_B = `G${'B'.repeat(55)}`;
const BUYER = `G${'D'.repeat(55)}`;

function makeBundleInput(id: string, components: BundleComponentRecord[], curatorFeeBps = 1000) {
  const now = new Date().toISOString();
  return {
    bundle: {
      id,
      name: 'DeFi Risk Pack',
      description: 'Whale + risk + sentiment',
      curatorWallet: CURATOR,
      totalPrice: 0.12,
      paymentToken: 'USDC',
      curatorFeeBps,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    components,
  };
}

function makeComponents(bundleId: string, shares: { datasetId: string; shareBps: number }[]) {
  const now = new Date().toISOString();
  return shares.map(
    (share, i): BundleComponentRecord => ({
      id: uuidv4(),
      bundleId,
      datasetId: share.datasetId,
      shareBps: share.shareBps,
      position: i,
      createdAt: now,
    }),
  );
}

describe('storage — bundles (#615, real DB round-trip)', () => {
  it('persists a bundle and its components, retrievable by id, sorted by position', async () => {
    const bundleId = uuidv4();
    const components = makeComponents(bundleId, [
      { datasetId: 'ds-sentiment', shareBps: 1500 },
      { datasetId: 'ds-whale', shareBps: 4500 },
      { datasetId: 'ds-risk', shareBps: 3000 },
    ]);
    const { bundle } = makeBundleInput(bundleId, components);

    const created = await createBundle(bundle, components);
    expect(created.components.map(c => c.datasetId)).toEqual([
      'ds-sentiment',
      'ds-whale',
      'ds-risk',
    ]);

    const fetched = await getBundle(bundleId);
    if (!fetched) throw new Error('Expected bundle to be persisted');
    expect(fetched.name).toBe('DeFi Risk Pack');
    expect(fetched.curatorWallet).toBe(CURATOR);
    expect(fetched.components).toHaveLength(3);
    expect(fetched.components.map(c => c.position)).toEqual([0, 1, 2]);
  });

  it('rejects and cleans up a bundle whose persisted components do not sum to 10000 bps', async () => {
    const bundleId = uuidv4();
    const components = makeComponents(bundleId, [
      { datasetId: 'ds-whale', shareBps: 4500 },
      { datasetId: 'ds-risk', shareBps: 3000 },
      // 4500 + 3000 + curatorFeeBps(1000) = 8500, not 10000 — the DB-layer
      // re-check must catch this even though nothing upstream validated it.
    ]);
    const { bundle } = makeBundleInput(bundleId, components, 1000);

    await expect(createBundle(bundle, components)).rejects.toThrow(BundleShareMismatchError);

    // No half-created bundle left behind for a buyer to purchase into.
    expect(await getBundle(bundleId)).toBeUndefined();
  });

  it('getAllBundles and getBundlesByCurator both surface a created bundle', async () => {
    const bundleId = uuidv4();
    const components = makeComponents(bundleId, [{ datasetId: 'ds-whale', shareBps: 9000 }]);
    const { bundle } = makeBundleInput(bundleId, components);
    await createBundle(bundle, components);

    const all = await getAllBundles();
    expect(all.some(b => b.id === bundleId)).toBe(true);

    const byCurator = await getBundlesByCurator(CURATOR);
    expect(byCurator.some(b => b.id === bundleId)).toBe(true);

    const byOtherCurator = await getBundlesByCurator(`G${'Z'.repeat(55)}`);
    expect(byOtherCurator.some(b => b.id === bundleId)).toBe(false);
  });

  it('getBundlesContainingDataset finds every bundle backed by a dataset id', async () => {
    const bundleId = uuidv4();
    const datasetId = `ds-shared-${uuidv4()}`;
    const components = makeComponents(bundleId, [{ datasetId, shareBps: 9000 }]);
    const { bundle } = makeBundleInput(bundleId, components);
    await createBundle(bundle, components);

    const bundles = await getBundlesContainingDataset(datasetId);
    expect(bundles.map(b => b.id)).toContain(bundleId);

    const none = await getBundlesContainingDataset(`ds-unused-${uuidv4()}`);
    expect(none.map(b => b.id)).not.toContain(bundleId);
  });

  it('updateBundle merges fields and persists them', async () => {
    const bundleId = uuidv4();
    const components = makeComponents(bundleId, [{ datasetId: 'ds-whale', shareBps: 9000 }]);
    const { bundle } = makeBundleInput(bundleId, components);
    await createBundle(bundle, components);

    const updated = await updateBundle(bundleId, { active: false });
    expect(updated?.active).toBe(false);

    const fetched = await getBundle(bundleId);
    expect(fetched?.active).toBe(false);
  });

  it('updateBundle returns null for a bundle that does not exist', async () => {
    expect(await updateBundle(`missing-${uuidv4()}`, { active: false })).toBeNull();
  });

  it('round-trips a bundle purchase and its per-component legs, including status transitions', async () => {
    const bundleId = uuidv4();
    const components = makeComponents(bundleId, [
      { datasetId: 'ds-whale', shareBps: 4500 },
      { datasetId: 'ds-risk', shareBps: 3500 },
    ]);
    const { bundle } = makeBundleInput(bundleId, components, 2000);
    await createBundle(bundle, components);

    const purchaseId = uuidv4();
    const now = new Date().toISOString();
    const purchase: BundlePurchase = {
      id: purchaseId,
      bundleId,
      buyerWallet: BUYER,
      firstEscrowId: 500,
      escrowIds: [500, 501, 502],
      totalAmount: 0.12,
      paymentToken: 'USDC',
      status: 'locked',
      lockTxHash: 'lock-tx-hash',
      createdAt: now,
      updatedAt: now,
    };
    await addBundlePurchase(purchase);

    const fetched = await getBundlePurchase(purchaseId);
    expect(fetched).toEqual(purchase);

    const legs: BundlePurchaseComponent[] = [
      {
        id: uuidv4(),
        purchaseId,
        datasetId: 'ds-whale',
        role: 'dataset',
        escrowId: 500,
        sellerWallet: SELLER_A,
        amount: 0.054,
        buyerConfirmed: false,
        deliveryStatus: 'pending',
        deliveryAttempts: 0,
        createdAt: now,
      },
      {
        id: uuidv4(),
        purchaseId,
        datasetId: 'ds-risk',
        role: 'dataset',
        escrowId: 501,
        sellerWallet: SELLER_B,
        amount: 0.042,
        buyerConfirmed: false,
        deliveryStatus: 'pending',
        deliveryAttempts: 0,
        createdAt: now,
      },
      {
        id: uuidv4(),
        purchaseId,
        datasetId: `bundle-curator-fee:${bundleId}`,
        role: 'curator',
        escrowId: 502,
        sellerWallet: CURATOR,
        amount: 0.024,
        buyerConfirmed: false,
        deliveryStatus: 'pending',
        deliveryAttempts: 0,
        createdAt: now,
      },
    ];
    for (const leg of legs) await addBundlePurchaseComponent(leg);

    const fetchedLegs = await getBundlePurchaseComponents(purchaseId);
    expect(fetchedLegs).toHaveLength(3);

    // Confirm each leg, one at a time — mirrors the real buyer confirm_delivery flow.
    for (const leg of fetchedLegs) {
      const updatedLeg = await updateBundlePurchaseComponent(leg.id, { buyerConfirmed: true });
      expect(updatedLeg?.buyerConfirmed).toBe(true);
    }
    const allConfirmed = await getBundlePurchaseComponents(purchaseId);
    expect(allConfirmed.every(c => c.buyerConfirmed)).toBe(true);

    const released = await updateBundlePurchase(purchaseId, {
      status: 'released',
      releaseTxHash: 'release-tx-hash',
    });
    expect(released?.status).toBe('released');
    expect(released?.releaseTxHash).toBe('release-tx-hash');

    const purchasesForBundle = await getBundlePurchasesForBundle(bundleId);
    expect(purchasesForBundle.map(p => p.id)).toContain(purchaseId);

    const sellerALegs = await getBundlePurchaseComponentsForSeller(SELLER_A);
    expect(sellerALegs.some(l => l.purchaseId === purchaseId && l.datasetId === 'ds-whale')).toBe(
      true,
    );
  });

  it('updateBundlePurchase returns null for a purchase that does not exist', async () => {
    expect(await updateBundlePurchase(`missing-${uuidv4()}`, { status: 'refunded' })).toBeNull();
  });

  it('updateBundlePurchaseComponent returns null for a component that does not exist', async () => {
    expect(
      await updateBundlePurchaseComponent(`missing-${uuidv4()}`, { buyerConfirmed: true }),
    ).toBeNull();
  });
});
