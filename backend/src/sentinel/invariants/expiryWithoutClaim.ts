/**
 * expiryWithoutClaim.ts — an escrow whose deadline has passed and nobody
 * (seller via claim_expired, admin via release, buyer via refund) has
 * settled it isn't an attack, but it's money sitting exposed longer than it
 * should — medium severity, worth a human glancing at.
 */
import type { RaisedAlert } from '../types';
import type { ScannedEscrow } from './scan';

export function evaluate(open: ScannedEscrow[], nowSeconds: number): RaisedAlert[] {
  return open
    .filter(escrow => escrow.deadline < nowSeconds)
    .map(escrow => ({
      invariant: 'expiry_without_claim',
      severity: 'medium' as const,
      escrowId: escrow.escrowId,
      message: `Escrow #${escrow.escrowId} has been past its deadline since ${new Date(escrow.deadline * 1000).toISOString()} with no claim/release/refund`,
      details: { escrowId: escrow.escrowId, deadline: escrow.deadline, token: escrow.token },
    }));
}
