/**
 * accessPass.ts — buyer/seller flows for dataset subscription access passes.
 *
 * Mirrors escrow.ts: the frontend asks the backend to assemble an UNSIGNED
 * transaction (define_plan / subscribe / renew), signs it with the user's own
 * Freighter wallet, and relays it through the backend's submit endpoint.
 * No Hazina key ever touches subscriber funds.
 */

import { api } from './api';
import { connectFreighter, signWithFreighter } from './stellarWallets';

export interface SubscribeResult {
  txHash: string;
  buyer: string;
  planId: number;
}

export interface RenewResult {
  txHash: string;
  buyer: string;
}

export interface DefinePlanParams {
  /** Display units per period (e.g. 0.05 USDC); converted to stroops backend-side. */
  pricePerPeriod: number;
  /** Term length in seconds (day/week/month presets live in the UI). */
  periodSeconds: number;
  maxSeats: number;
}

export interface DefinePlanResult {
  txHash: string;
  seller: string;
}

/**
 * Full buyer subscribe flow:
 *   1. connect Freighter (buyer's own wallet)
 *   2. ask the backend to build an unsigned subscribe() transaction
 *   3. sign it in Freighter
 *   4. relay it and return the on-chain tx hash
 */
export async function subscribeToDataset(
  datasetId: string,
  planId: number,
): Promise<SubscribeResult> {
  const buyer = await connectFreighter();

  const built = await api.buildSubscribeTx(datasetId, buyer, planId);
  const signedXdr = await signWithFreighter(built.xdr);
  const submitted = await api.submitSignedAccessTx(datasetId, signedXdr);

  return { txHash: submitted.txHash, buyer, planId };
}

/**
 * Buyer renews their pass for a dataset. Renewing before expiry extends the
 * current term; after expiry it starts a fresh one — the contract owns that
 * arithmetic, the UI only needs the signature.
 */
export async function renewSubscription(datasetId: string): Promise<RenewResult> {
  const buyer = await connectFreighter();

  const built = await api.buildRenewTx(datasetId, buyer);
  const signedXdr = await signWithFreighter(built.xdr);
  const submitted = await api.submitSignedAccessTx(datasetId, signedXdr);

  return { txHash: submitted.txHash, buyer };
}

/**
 * Seller defines a subscription plan on their dataset right after listing it.
 * Signed by the seller's own wallet; the plan becomes immutable except for
 * its active flag (repricing creates a new plan).
 */
export async function definePlanForDataset(
  datasetId: string,
  params: DefinePlanParams,
): Promise<DefinePlanResult> {
  const seller = await connectFreighter();

  const built = await api.buildDefinePlanTx(
    datasetId,
    seller,
    params.pricePerPeriod,
    params.periodSeconds,
    params.maxSeats,
  );
  const signedXdr = await signWithFreighter(built.xdr);
  const submitted = await api.submitSignedAccessTx(datasetId, signedXdr);

  return { txHash: submitted.txHash, seller };
}
