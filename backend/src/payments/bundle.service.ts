/**
 * bundle.service.ts — #615
 *
 * Orchestrates a composed data bundle end to end: a curator combines several
 * sellers' datasets into one product at one price; a buyer pays once via the
 * escrow contract's `lock_multi`; every underlying seller (and the curator's
 * own fee leg) is delivered and then paid atomically via `release_multi`. If
 * any component fails to deliver, every escrow in the batch is refunded —
 * no partial delivery, no partial payment.
 *
 * State machine per purchase (see `BundlePurchaseStatus` in common/storage.ts):
 *   locked -> delivering -> delivered -> released
 *                        \-> refunding -> refunded | failed
 */

import { v4 as uuidv4 } from 'uuid';
import {
  addBundlePurchase,
  addBundlePurchaseComponent,
  createBundle,
  getAllBundles,
  getAllDatasets,
  getBundle,
  getBundlePurchase,
  getBundlePurchaseComponents,
  getBundlePurchaseComponentsForSeller,
  getBundlePurchasesForBundle,
  getBundlesByCurator,
  getBundlesContainingDataset,
  getDataset,
  updateBundlePurchase,
  updateBundlePurchaseComponent,
  updateDataset,
  type Bundle,
  type BundleComponentRecord,
  type BundlePurchase,
  type BundlePurchaseComponent,
  type Dataset,
} from '../common/storage';
import { sellerShare as computeSellerShare } from '../common/constants';
import {
  assertValidBundleSplit,
  allocateStroops,
  InvalidBundleSplitError,
  type BundleSplitComponent,
} from './bundle.splits';
import {
  buildLockMultiTx,
  submitSignedLockMulti,
  buildConfirmDeliveryTx,
  submitSignedConfirmDelivery,
  releaseMultiEscrow,
  refundEscrow,
  toStroops,
  fromStroops,
} from '../lib/escrow.client';
import type { SellerShareInput } from '../lib/scval';
import { synthesizeResearch, type SellerDataset } from '../ai/research.service';
import { recordDatasetSnapshot } from '../snapshots/snapshots.service';
import { notifySeller } from '../webhooks/webhook.service';
import { logger } from '../lib/logger';

export { InvalidBundleSplitError };

export class BundleNotFoundError extends Error {
  constructor(id: string) {
    super(`Bundle ${id} not found`);
    this.name = 'BundleNotFoundError';
  }
}

/** A bundle exists but cannot be purchased right now (deactivated, or a component dataset is gone/delisted). */
export class BundleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleUnavailableError';
  }
}

export class BundlePurchaseNotFoundError extends Error {
  constructor(id: string) {
    super(`Bundle purchase ${id} not found`);
    this.name = 'BundlePurchaseNotFoundError';
  }
}

/** The purchase exists but is not in the state a requested action requires (e.g. confirming before delivery finished). */
export class BundlePurchaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundlePurchaseStateError';
  }
}

const CURATOR_LEG_KEY = '__curator_fee__';

/** Synthetic dataset id for the curator's own fee leg in a `lock_multi` batch — never a real dataset. */
function curatorLegDatasetId(bundleId: string): string {
  return `bundle-curator-fee:${bundleId}`;
}

/**
 * Conservative mirror of the contract's `DEFAULT_MAX_ESCROWS_PER_LEDGER`
 * (100 — see `lib.rs` and the `test_lock_multi_*_ceiling*` tests), minus one
 * slot reserved for the curator's own fee leg. The real ceiling is enforced
 * authoritatively on-chain by `lock_multi`'s rate circuit breaker, which an
 * admin can raise or lower post-deploy — this constant exists only to fail a
 * too-large bundle fast, before any network round-trip, not to be the
 * ultimate source of truth.
 */
export const MAX_BUNDLE_COMPONENTS = 99;

/** `Map.get` that throws instead of returning `undefined` — for lookups the caller has already proven must succeed. */
function mustGet<V>(map: Map<string, V>, key: string, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Internal error: expected ${context} to be present for key "${key}"`);
  }
  return value;
}

/** Array indexing that throws instead of returning `undefined` — for indices the caller has already proven are in bounds. */
function mustIndex<V>(arr: V[], index: number, context: string): V {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Internal error: expected ${context} at index ${index}`);
  }
  return value;
}

export interface BundleAvailability {
  degraded: boolean;
  degradedReason?: string;
}

/**
 * A component dataset going unavailable (delisted, deleted) must disable the
 * bundle rather than silently ship a hole — this is the single source of
 * truth for that check, used by both the read endpoints (to show buyers a
 * reason) and the purchase flow (to refuse to build a lock_multi for a
 * bundle that can't be delivered).
 */
export async function computeBundleAvailability(bundle: Bundle): Promise<BundleAvailability> {
  if (bundle.active === false) {
    return { degraded: true, degradedReason: 'This bundle has been deactivated by its curator' };
  }
  for (const component of bundle.components) {
    const dataset = await getDataset(component.datasetId);
    if (!dataset) {
      return {
        degraded: true,
        degradedReason: `A component dataset (${component.datasetId}) no longer exists`,
      };
    }
    if (dataset.active === false) {
      return {
        degraded: true,
        degradedReason: `Component dataset "${dataset.name}" has been delisted`,
      };
    }
  }
  return { degraded: false };
}

export type BundleWithAvailability = Bundle & BundleAvailability;

export async function listBundlesWithAvailability(): Promise<BundleWithAvailability[]> {
  const bundles = await getAllBundles();
  return Promise.all(
    bundles.map(async bundle => ({ ...bundle, ...(await computeBundleAvailability(bundle)) })),
  );
}

export async function getBundleWithAvailability(
  id: string,
): Promise<BundleWithAvailability | undefined> {
  const bundle = await getBundle(id);
  if (!bundle) return undefined;
  return { ...bundle, ...(await computeBundleAvailability(bundle)) };
}

export interface CreateBundleInput {
  name: string;
  description: string;
  curatorWallet: string;
  totalPrice: number;
  paymentToken?: string;
  curatorFeeBps: number;
  components: BundleSplitComponent[];
}

/**
 * Creates a bundle. Splits are validated twice: here (zod already validated
 * the request shape before this is called; this re-validates the business
 * rule) and again inside `createBundle` in storage.ts against whatever
 * actually landed in the DB — defense in depth against a lost/duplicated
 * component write, not redundant paranoia.
 */
export async function createBundleRecord(input: CreateBundleInput): Promise<Bundle> {
  assertValidBundleSplit(input.components, input.curatorFeeBps);

  if (input.components.length > MAX_BUNDLE_COMPONENTS) {
    throw new InvalidBundleSplitError(
      `A bundle may have at most ${MAX_BUNDLE_COMPONENTS} component datasets (got ${input.components.length}) — lock_multi's on-chain rate limit caps the total batch size`,
    );
  }

  for (const component of input.components) {
    const dataset = await getDataset(component.datasetId);
    if (!dataset) {
      throw new InvalidBundleSplitError(`Dataset ${component.datasetId} does not exist`);
    }
    if (dataset.active === false) {
      throw new InvalidBundleSplitError(
        `Dataset ${component.datasetId} is delisted and cannot be added to a bundle`,
      );
    }
  }

  const now = new Date().toISOString();
  const bundleId = uuidv4();
  const componentRecords: BundleComponentRecord[] = input.components.map((component, index) => ({
    id: uuidv4(),
    bundleId,
    datasetId: component.datasetId,
    shareBps: component.shareBps,
    position: index,
    createdAt: now,
  }));

  return createBundle(
    {
      id: bundleId,
      name: input.name,
      description: input.description,
      curatorWallet: input.curatorWallet,
      totalPrice: input.totalPrice,
      paymentToken: input.paymentToken ?? 'USDC',
      curatorFeeBps: input.curatorFeeBps,
      active: true,
      createdAt: now,
      updatedAt: now,
    },
    componentRecords,
  );
}

interface ResolvedLeg {
  datasetId: string;
  sellerWallet: string;
  shareBps: number;
}

/** Re-resolves every component's current seller wallet and confirms it's still purchasable. */
async function resolveLegs(bundle: Bundle): Promise<ResolvedLeg[]> {
  const sorted = [...bundle.components].sort((a, b) => a.position - b.position);
  const legs: ResolvedLeg[] = [];
  for (const component of sorted) {
    const dataset = await getDataset(component.datasetId);
    if (!dataset) {
      throw new BundleUnavailableError(`Component dataset ${component.datasetId} no longer exists`);
    }
    if (dataset.active === false) {
      throw new BundleUnavailableError(`Component dataset "${dataset.name}" has been delisted`);
    }
    legs.push({
      datasetId: component.datasetId,
      sellerWallet: dataset.sellerWallet,
      shareBps: component.shareBps,
    });
  }
  return legs;
}

function splitAllocations(bundle: Bundle, legs: ResolvedLeg[]) {
  return [
    ...legs.map(leg => ({ key: leg.datasetId, bps: leg.shareBps })),
    { key: CURATOR_LEG_KEY, bps: bundle.curatorFeeBps },
  ];
}

export interface BundlePurchaseLockTx {
  xdr: string;
  contractId: string;
  bundleId: string;
  componentCount: number;
  totalPrice: number;
}

/** Builds the unsigned `lock_multi` XDR for a buyer to sign — the one on-chain call that locks every seller's share plus the curator's fee at once. */
export async function buildBundlePurchaseLockTx(
  bundleId: string,
  buyer: string,
): Promise<BundlePurchaseLockTx> {
  const bundle = await getBundle(bundleId);
  if (!bundle) throw new BundleNotFoundError(bundleId);

  const availability = await computeBundleAvailability(bundle);
  if (availability.degraded) {
    throw new BundleUnavailableError(availability.degradedReason ?? 'Bundle is unavailable');
  }

  const legs = await resolveLegs(bundle);
  const totalStroops = toStroops(bundle.totalPrice);
  const stroopMap = allocateStroops(totalStroops, splitAllocations(bundle, legs));

  const shares: SellerShareInput[] = [
    ...legs.map(leg => ({
      seller: leg.sellerWallet,
      amount: mustGet(stroopMap, leg.datasetId, 'an allocated stroop share'),
    })),
    {
      seller: bundle.curatorWallet,
      amount: mustGet(stroopMap, CURATOR_LEG_KEY, 'the curator stroop share'),
    },
  ];
  const datasetIds: string[] = [...legs.map(leg => leg.datasetId), curatorLegDatasetId(bundle.id)];

  shares.forEach((share, i) => {
    if (BigInt(share.amount) <= 0n) {
      throw new BundleUnavailableError(
        `Bundle price is too small to fund "${datasetIds[i]}" at its declared share — raise the bundle price`,
      );
    }
  });

  const { xdr, contractId } = await buildLockMultiTx({
    buyer,
    shares,
    datasetIds,
    tokenCode: bundle.paymentToken ?? 'USDC',
  });

  return {
    xdr,
    contractId,
    bundleId: bundle.id,
    componentCount: shares.length,
    totalPrice: bundle.totalPrice,
  };
}

/**
 * Submits the buyer-signed `lock_multi`, persists the purchase and its
 * per-component legs, then immediately attempts delivery. Returns the
 * purchase in whatever state delivery left it — `delivered` (ready for the
 * buyer to confirm) or `refunded`/`failed` if a component couldn't be
 * delivered.
 */
export async function submitBundlePurchase(
  bundleId: string,
  buyer: string,
  signedXdr: string,
): Promise<BundlePurchase> {
  const bundle = await getBundle(bundleId);
  if (!bundle) throw new BundleNotFoundError(bundleId);

  // Re-check availability immediately before the buyer's signed transaction
  // is ever submitted to the network — funds must never leave the buyer's
  // wallet for a bundle that can no longer be delivered.
  const legs = await resolveLegs(bundle);
  const componentCount = legs.length + 1;

  const { txHash, firstEscrowId, escrowIds } = await submitSignedLockMulti(
    signedXdr,
    componentCount,
  );

  const totalStroops = toStroops(bundle.totalPrice);
  const stroopMap = allocateStroops(totalStroops, splitAllocations(bundle, legs));

  const now = new Date().toISOString();
  const purchaseId = uuidv4();
  const purchase: BundlePurchase = {
    id: purchaseId,
    bundleId: bundle.id,
    buyerWallet: buyer,
    firstEscrowId,
    escrowIds,
    totalAmount: bundle.totalPrice,
    paymentToken: bundle.paymentToken ?? 'USDC',
    status: 'locked',
    lockTxHash: txHash,
    createdAt: now,
    updatedAt: now,
  };
  await addBundlePurchase(purchase);

  const datasetComponents: BundlePurchaseComponent[] = legs.map((leg, i) => ({
    id: uuidv4(),
    purchaseId,
    datasetId: leg.datasetId,
    role: 'dataset',
    escrowId: mustIndex(escrowIds, i, 'a locked escrow id'),
    sellerWallet: leg.sellerWallet,
    amount: fromStroops(mustGet(stroopMap, leg.datasetId, 'an allocated stroop share')),
    buyerConfirmed: false,
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    createdAt: now,
  }));
  const curatorComponent: BundlePurchaseComponent = {
    id: uuidv4(),
    purchaseId,
    datasetId: curatorLegDatasetId(bundle.id),
    role: 'curator',
    escrowId: mustIndex(escrowIds, escrowIds.length - 1, 'the curator escrow id'),
    sellerWallet: bundle.curatorWallet,
    amount: fromStroops(mustGet(stroopMap, CURATOR_LEG_KEY, 'the curator stroop share')),
    buyerConfirmed: false,
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    createdAt: now,
  };
  for (const component of [...datasetComponents, curatorComponent]) {
    await addBundlePurchaseComponent(component);
  }

  return deliverBundlePurchase(purchaseId);
}

/** Refunds every escrow in the batch — best-effort per leg, so one stuck refund never blocks the rest. */
async function refundWholeBatch(purchase: BundlePurchase, reason: string): Promise<BundlePurchase> {
  await updateBundlePurchase(purchase.id, { status: 'refunding' });

  const failedEscrowIds: number[] = [];
  for (const escrowId of purchase.escrowIds) {
    try {
      await refundEscrow(escrowId);
    } catch (err) {
      failedEscrowIds.push(escrowId);
      logger.error(
        `[Bundle] Refund failed for escrow #${escrowId} in purchase ${purchase.id} — needs manual reconciliation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const failureReason =
    failedEscrowIds.length === 0
      ? reason
      : `${reason} — refund failed for escrow(s) [${failedEscrowIds.join(', ')}], needs manual reconciliation`;

  const updated = await updateBundlePurchase(purchase.id, {
    status: failedEscrowIds.length === 0 ? 'refunded' : 'failed',
    failureReason,
  });
  if (!updated) throw new BundlePurchaseNotFoundError(purchase.id);
  return updated;
}

/**
 * Attempts to deliver every dataset component. All-or-nothing: if any
 * component dataset is gone or delisted, every escrow in the batch is
 * refunded and no seller is paid — checked before any dataset's stats are
 * touched or any seller is notified, so a mid-way failure can never leave a
 * half-delivered bundle.
 */
async function deliverBundlePurchase(purchaseId: string): Promise<BundlePurchase> {
  const purchase = await getBundlePurchase(purchaseId);
  if (!purchase) throw new BundlePurchaseNotFoundError(purchaseId);
  await updateBundlePurchase(purchaseId, { status: 'delivering' });

  const components = await getBundlePurchaseComponents(purchaseId);
  const datasetComponents = components.filter(c => c.role === 'dataset');

  // Fetched once per component and reused below — both so delivery never
  // re-fetches a dataset it already loaded, and so the second pass never
  // needs to re-assert what the first pass already proved is deliverable.
  const datasetsByComponentId = new Map<string, Dataset>();
  for (const component of datasetComponents) {
    const dataset = await getDataset(component.datasetId);
    if (!dataset || dataset.active === false) {
      await updateBundlePurchaseComponent(component.id, {
        deliveryStatus: 'failed',
        deliveryError: !dataset ? 'Dataset no longer exists' : 'Dataset has been delisted',
        deliveryAttempts: component.deliveryAttempts + 1,
      });
      return refundWholeBatch(
        purchase,
        `Component dataset ${component.datasetId} failed to deliver (${
          !dataset ? 'deleted' : 'delisted'
        }) — full refund issued, no seller was paid`,
      );
    }
    datasetsByComponentId.set(component.id, dataset);
  }

  for (const component of datasetComponents) {
    const dataset = mustGet(datasetsByComponentId, component.id, 'a verified deliverable dataset');

    try {
      await recordDatasetSnapshot(dataset.id, dataset.data);
    } catch (err) {
      logger.error(
        `[Bundle] Could not pin snapshot for ${dataset.id} in purchase ${purchaseId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await updateDataset(dataset.id, {
      queriesServed: dataset.queriesServed + 1,
      totalEarned: parseFloat(
        (dataset.totalEarned + computeSellerShare(component.amount)).toFixed(4),
      ),
    });

    await updateBundlePurchaseComponent(component.id, {
      deliveryStatus: 'delivered',
      deliveryAttempts: component.deliveryAttempts + 1,
    });

    notifySeller(dataset.sellerWallet, 'payment.received', {
      datasetId: dataset.id,
      datasetName: dataset.name,
      bundleId: purchase.bundleId,
      purchaseId,
      amount: component.amount,
      paymentToken: purchase.paymentToken ?? 'USDC',
    }).catch((err: unknown) => {
      logger.error(
        `[Bundle] Seller notification failed for ${dataset.sellerWallet} (purchase ${purchaseId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  const updated = await updateBundlePurchase(purchaseId, { status: 'delivered' });
  if (!updated) throw new BundlePurchaseNotFoundError(purchaseId);
  return updated;
}

/** Builds one `confirm_delivery` XDR per not-yet-confirmed escrow leg for the buyer to sign. */
export async function buildBundleConfirmTxs(
  purchaseId: string,
  buyer: string,
): Promise<{ escrowId: number; xdr: string }[]> {
  const purchase = await getBundlePurchase(purchaseId);
  if (!purchase) throw new BundlePurchaseNotFoundError(purchaseId);
  if (purchase.buyerWallet !== buyer) {
    throw new BundlePurchaseStateError('Only the buyer of this purchase may confirm delivery');
  }
  if (purchase.status !== 'delivered') {
    throw new BundlePurchaseStateError(
      `Cannot confirm delivery — purchase is '${purchase.status}', expected 'delivered'`,
    );
  }

  const components = await getBundlePurchaseComponents(purchaseId);
  const pending = components.filter(c => !c.buyerConfirmed);
  return Promise.all(
    pending.map(async component => ({
      escrowId: component.escrowId,
      xdr: (await buildConfirmDeliveryTx({ buyer, escrowId: component.escrowId })).xdr,
    })),
  );
}

/**
 * Submits one buyer-signed `confirm_delivery` for one escrow leg. Once every
 * leg in the purchase is confirmed, automatically calls `release_multi` —
 * the buyer never has to take a separate "release" action.
 */
export async function submitBundleConfirmation(
  purchaseId: string,
  escrowId: number,
  signedXdr: string,
): Promise<BundlePurchase> {
  const purchase = await getBundlePurchase(purchaseId);
  if (!purchase) throw new BundlePurchaseNotFoundError(purchaseId);
  if (purchase.status !== 'delivered') {
    throw new BundlePurchaseStateError(
      `Cannot confirm delivery — purchase is '${purchase.status}', expected 'delivered'`,
    );
  }

  const components = await getBundlePurchaseComponents(purchaseId);
  const component = components.find(c => c.escrowId === escrowId);
  if (!component) {
    throw new BundlePurchaseStateError(`Escrow #${escrowId} is not part of purchase ${purchaseId}`);
  }

  await submitSignedConfirmDelivery(signedXdr);
  await updateBundlePurchaseComponent(component.id, { buyerConfirmed: true });

  const refreshed = await getBundlePurchaseComponents(purchaseId);
  if (refreshed.every(c => c.buyerConfirmed)) {
    return releaseBundlePurchase(purchaseId);
  }
  const current = await getBundlePurchase(purchaseId);
  if (!current) throw new BundlePurchaseNotFoundError(purchaseId);
  return current;
}

/**
 * Pays out every escrow in the batch in one `release_multi` call, then
 * synthesizes a single cross-dataset summary over every component's data —
 * reusing `research.service.ts`'s `synthesizeResearch` rather than writing a
 * third summariser (`claude.service.ts`'s per-dataset one is the other).
 * AI synthesis is best-effort: a failure here never unwinds the payout —
 * sellers have already been paid on-chain by this point.
 */
async function releaseBundlePurchase(purchaseId: string): Promise<BundlePurchase> {
  const purchase = await getBundlePurchase(purchaseId);
  if (!purchase) throw new BundlePurchaseNotFoundError(purchaseId);

  const releaseTxHash = await releaseMultiEscrow(purchase.escrowIds);

  let aiSummary: string | undefined;
  try {
    const bundle = await getBundle(purchase.bundleId);
    const components = await getBundlePurchaseComponents(purchaseId);
    const availableSellers: SellerDataset[] = [];
    for (const component of components.filter(c => c.role === 'dataset')) {
      const dataset = await getDataset(component.datasetId);
      if (!dataset) continue;
      availableSellers.push({
        role: dataset.type,
        displayName: dataset.name,
        data: dataset.data,
        cost: component.amount,
      });
    }
    if (availableSellers.length > 0) {
      const report = await synthesizeResearch({
        userQuery: `Synthesize the datasets in the "${bundle?.name ?? purchase.bundleId}" bundle into one cross-dataset summary for the buyer.`,
        budget: purchase.totalAmount,
        riskTolerance: 'medium',
        availableSellers,
      });
      aiSummary = report.rawAnalysis;
    }
  } catch (err) {
    logger.error(
      `[Bundle] AI synthesis failed for purchase ${purchaseId} (payout already released, summary is best-effort): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const updated = await updateBundlePurchase(purchaseId, {
    status: 'released',
    releaseTxHash,
    ...(aiSummary ? { aiSummary } : {}),
  });
  if (!updated) throw new BundlePurchaseNotFoundError(purchaseId);
  return updated;
}

export interface BundlePurchaseDetail {
  purchase: BundlePurchase;
  components: BundlePurchaseComponent[];
}

export async function getBundlePurchaseDetail(
  purchaseId: string,
): Promise<BundlePurchaseDetail | undefined> {
  const purchase = await getBundlePurchase(purchaseId);
  if (!purchase) return undefined;
  const components = await getBundlePurchaseComponents(purchaseId);
  return { purchase, components };
}

// ── Dashboards (#615) ─────────────────────────────────────────────────────────

export interface CuratorBundleEarnings {
  bundleId: string;
  bundleName: string;
  active: boolean;
  totalPurchases: number;
  releasedPurchases: number;
  totalEarned: number;
}

/** Curator dashboard: every bundle they curate, with purchase counts and total curator-fee earnings. */
export async function getCuratorEarnings(curatorWallet: string): Promise<CuratorBundleEarnings[]> {
  const bundles = await getBundlesByCurator(curatorWallet);
  const summaries: CuratorBundleEarnings[] = [];

  for (const bundle of bundles) {
    const purchases = await getBundlePurchasesForBundle(bundle.id);
    const released = purchases.filter(p => p.status === 'released');

    let totalEarned = 0;
    for (const purchase of released) {
      const components = await getBundlePurchaseComponents(purchase.id);
      const curatorLeg = components.find(c => c.role === 'curator');
      if (curatorLeg) totalEarned += curatorLeg.amount;
    }

    summaries.push({
      bundleId: bundle.id,
      bundleName: bundle.name,
      active: bundle.active !== false,
      totalPurchases: purchases.length,
      releasedPurchases: released.length,
      totalEarned: parseFloat(totalEarned.toFixed(4)),
    });
  }

  return summaries;
}

export interface SellerBundleEarnings {
  bundleId: string;
  bundleName: string;
  datasetId: string;
  totalEarned: number;
  purchaseCount: number;
}

/** Seller dashboard: which bundles include this seller's datasets, and what they've earned from them. */
export async function getSellerBundleEarnings(
  sellerWallet: string,
): Promise<SellerBundleEarnings[]> {
  const legs = await getBundlePurchaseComponentsForSeller(sellerWallet);
  const byKey = new Map<string, SellerBundleEarnings>();

  for (const leg of legs) {
    const purchase = await getBundlePurchase(leg.purchaseId);
    if (!purchase || purchase.status !== 'released') continue;

    const bundle = await getBundle(purchase.bundleId);
    const key = `${purchase.bundleId}:${leg.datasetId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.totalEarned = parseFloat((existing.totalEarned + leg.amount).toFixed(4));
      existing.purchaseCount += 1;
    } else {
      byKey.set(key, {
        bundleId: purchase.bundleId,
        bundleName: bundle?.name ?? purchase.bundleId,
        datasetId: leg.datasetId,
        totalEarned: parseFloat(leg.amount.toFixed(4)),
        purchaseCount: 1,
      });
    }
  }

  return [...byKey.values()];
}

/** Every bundle (regardless of purchase history) that includes at least one of this seller's datasets. */
export async function getBundlesForSeller(sellerWallet: string): Promise<Bundle[]> {
  const datasets = await getAllDatasets();
  const sellerDatasetIds = datasets
    .filter(dataset => dataset.sellerWallet === sellerWallet)
    .map(dataset => dataset.id);

  const seen = new Map<string, Bundle>();
  for (const datasetId of sellerDatasetIds) {
    const bundles = await getBundlesContainingDataset(datasetId);
    for (const bundle of bundles) seen.set(bundle.id, bundle);
  }
  return [...seen.values()];
}
