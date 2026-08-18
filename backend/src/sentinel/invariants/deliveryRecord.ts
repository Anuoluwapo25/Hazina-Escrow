/**
 * deliveryRecord.ts — every on-chain release should correspond to a backend
 * transaction record that actually delivered the dataset. A release with no
 * matching record means funds moved without the off-chain side agreeing
 * delivery happened — not proof of theft, but exactly the kind of drift
 * between "the chain" and "our books" that needs a human to reconcile.
 */
import type { RaisedAlert, SentinelEvent } from '../types';

export interface DeliveryRecordChecker {
  hasDeliveryRecord(escrowId: number): Promise<boolean>;
}

export async function evaluate(
  event: SentinelEvent,
  checker: DeliveryRecordChecker,
): Promise<RaisedAlert[]> {
  if (event.topic !== 'released') return [];

  const escrowId = Number(event.data[0]);
  const hasRecord = await checker.hasDeliveryRecord(escrowId);
  if (hasRecord) return [];

  return [
    {
      invariant: 'delivery_record',
      severity: 'high',
      escrowId,
      txHash: event.txHash,
      ledger: event.ledger,
      message: `Escrow #${escrowId} released on-chain with no matching backend delivery record`,
      details: { escrowId },
    },
  ];
}
