/**
 * escrow.ts — Issues #547 / #548
 *
 * Buyer-side helpers for the non-custodial escrow flow. The buyer's funds are
 * locked into the Soroban contract from their OWN wallet — the frontend asks the
 * backend to assemble an unsigned transaction, signs it with Freighter, and
 * relays it back. No Hazina key ever touches the buyer's money.
 */

import { api } from './api';
import { connectFreighter, signWithFreighter } from './stellarWallets';

export interface LockResult {
  escrowId: number;
  txHash: string;
  buyer: string;
}

/**
 * Full buyer lock flow:
 *   1. connect Freighter (buyer's own wallet)
 *   2. ask the backend to build an unsigned lock() transaction
 *   3. sign it in Freighter
 *   4. relay the signed transaction and return the on-chain escrow id
 */
export async function lockFundsInEscrow(
  datasetId: string,
  amount?: number,
  quote?: Record<string, unknown>,
): Promise<LockResult> {
  const buyer = await connectFreighter();

  const built = await api.buildEscrowLock(buyer, datasetId, amount, quote);
  const signedXdr = await signWithFreighter(built.xdr);
  const submitted = await api.submitEscrowLock(signedXdr);

  return { escrowId: submitted.escrowId, txHash: submitted.txHash, buyer };
}

/**
 * Buyer confirms delivery on-chain (unblocks admin release). Signs
 * confirm_delivery() with their own wallet.
 */
export async function confirmDelivery(escrowId: number): Promise<string> {
  const buyer = await connectFreighter();
  const built = await api.buildConfirmDelivery(buyer, escrowId);
  return signWithFreighter(built.xdr);
}

/**
 * Buyer raises a dispute on-chain. Signs raise_dispute() with their own wallet.
 * `evidenceHash` is an optional 32-byte hex string hashing off-chain evidence;
 * when omitted the backend anchors the dispute to the delivery receipt's
 * receipt hash (the verifiable commitment) for this escrow's transaction.
 */
export async function raiseDispute(escrowId: number, evidenceHash?: string): Promise<string> {
  const buyer = await connectFreighter();
  const built = await api.buildRaiseDispute(buyer, escrowId, evidenceHash);
  return signWithFreighter(built.xdr);
}

/** Human-readable settlement status for the live escrow-state UI (#548). */
export function escrowStatusLabel(escrow: {
  released: boolean;
  refunded: boolean;
  disputed: boolean;
  buyerConfirmed: boolean;
}): 'released' | 'refunded' | 'disputed' | 'confirmed' | 'locked' {
  if (escrow.released) return 'released';
  if (escrow.refunded) return 'refunded';
  if (escrow.disputed) return 'disputed';
  if (escrow.buyerConfirmed) return 'confirmed';
  return 'locked';
}
