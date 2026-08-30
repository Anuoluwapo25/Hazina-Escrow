/**
 * bundle.ts — #615
 *
 * Buyer-side helpers for purchasing a composed data bundle. Same non-custodial
 * trust model as escrow.ts: the buyer's funds are locked into the Soroban
 * contract from their OWN wallet via lock_multi — the frontend asks the
 * backend to assemble the unsigned transaction, signs it with Freighter, and
 * relays it back. No Hazina key ever touches the buyer's money.
 *
 * A bundle purchase needs one lock_multi signature up front, then one
 * confirm_delivery signature per component leg (the contract has no
 * confirm_delivery_multi) before the backend can release_multi the payout —
 * see purchaseBundle() and confirmBundleDelivery() below.
 */

import { api, type BundlePurchase } from './api';
import { connectFreighter, signWithFreighter } from './stellarWallets';

export interface BundlePurchaseResult {
  purchase: BundlePurchase;
  buyer: string;
}

/**
 * Full buyer purchase flow for one bundle:
 *   1. connect Freighter (buyer's own wallet)
 *   2. ask the backend to build an unsigned lock_multi() transaction
 *   3. sign it in Freighter
 *   4. relay the signed transaction — the backend locks funds and attempts
 *      delivery immediately, returning the purchase in whatever state that
 *      left it (`delivered`, ready to confirm; or `refunded`/`failed` if a
 *      component couldn't be delivered)
 */
export async function purchaseBundle(bundleId: string): Promise<BundlePurchaseResult> {
  const buyer = await connectFreighter();

  const built = await api.buildBundlePurchase(bundleId, buyer);
  const signedXdr = await signWithFreighter(built.xdr);
  const purchase = await api.submitBundlePurchase(bundleId, buyer, signedXdr);

  return { purchase, buyer };
}

/**
 * Confirms delivery on-chain for EVERY leg of a purchase, one
 * confirm_delivery() signature at a time (sequential — Freighter can only
 * handle one signature prompt at a time). Once the last leg is confirmed,
 * the backend automatically calls release_multi and every seller (plus the
 * curator) is paid in one transaction. Returns the final purchase state.
 *
 * `onProgress`, if given, fires after each leg is signed and submitted with
 * (legsConfirmedSoFar, totalLegs) — so a caller can render "confirm 2/4"
 * instead of a single opaque spinner across what may be several wallet
 * signature prompts in a row.
 */
export async function confirmBundleDelivery(
  purchaseId: string,
  onProgress?: (confirmed: number, total: number) => void,
): Promise<BundlePurchase> {
  const buyer = await connectFreighter();
  const confirmations = await api.buildBundleConfirmations(purchaseId, buyer);

  if (confirmations.length === 0) {
    const { purchase } = await api.getBundlePurchase(purchaseId);
    return purchase;
  }

  let purchase: BundlePurchase | undefined;
  let confirmed = 0;
  for (const confirmation of confirmations) {
    const signedXdr = await signWithFreighter(confirmation.xdr);
    purchase = await api.submitBundleConfirmation(purchaseId, confirmation.escrowId, signedXdr);
    confirmed += 1;
    onProgress?.(confirmed, confirmations.length);
  }

  // confirmations.length > 0 here (the empty case already returned above), so
  // the loop always ran at least once and assigned purchase.
  if (!purchase) throw new Error('confirmBundleDelivery: no confirmation was submitted');
  return purchase;
}

/** Human-readable purchase status for buyer-facing UI. */
export function bundlePurchaseStatusLabel(status: BundlePurchase['status']): string {
  switch (status) {
    case 'locked':
      return 'Funds locked — preparing delivery';
    case 'delivering':
      return 'Delivering components';
    case 'delivered':
      return 'Delivered — confirm receipt to release payment';
    case 'released':
      return 'Released — every seller paid';
    case 'refunding':
      return 'Refunding';
    case 'refunded':
      return 'Refunded — a component could not be delivered';
    case 'failed':
      return 'Failed — needs manual reconciliation';
    default:
      return status;
  }
}
