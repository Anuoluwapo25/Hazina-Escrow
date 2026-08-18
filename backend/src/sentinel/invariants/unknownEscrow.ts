/**
 * unknownEscrow.ts — a release/refund/claim for an escrow id the contract
 * has no record of should be impossible (the contract itself panics
 * EscrowNotFound before ever emitting the event). Checking it live is
 * defense-in-depth against a misconfigured contract id, a decode bug, or a
 * ledger-state anomaly — not something a healthy contract should ever trip.
 */
import type { EscrowReader, RaisedAlert, SentinelEvent } from '../types';

const SETTLEMENT_TOPICS = new Set(['released', 'refunded', 'claimed']);

export async function evaluate(event: SentinelEvent, reader: EscrowReader): Promise<RaisedAlert[]> {
  if (!SETTLEMENT_TOPICS.has(event.topic)) return [];

  const escrowId = Number(event.data[0]);
  const record = await reader.getEscrow(escrowId);
  if (record) return [];

  return [
    {
      invariant: 'unknown_escrow_settlement',
      severity: 'critical',
      escrowId,
      txHash: event.txHash,
      ledger: event.ledger,
      message: `${event.topic} event fired for escrow #${escrowId}, but the contract has no record of it`,
      details: { topic: event.topic, escrowId },
    },
  ];
}
