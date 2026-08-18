/**
 * releaseConservation.ts — I1 in docs/INVARIANTS.md, checked live against the
 * deployed contract rather than just in the fuzz suite: every `released`
 * event's seller_cut + platform_cut must equal the amount that was locked.
 *
 * `claim_expired` is deliberately asymmetric (I3 — the fee stays in the
 * contract rather than reaching the treasury) so it is out of scope here.
 */
import type { EscrowReader, RaisedAlert, SentinelEvent } from '../types';

export async function evaluate(event: SentinelEvent, reader: EscrowReader): Promise<RaisedAlert[]> {
  if (event.topic !== 'released') return [];

  const [escrowIdRaw, , sellerCutRaw, platformCutRaw] = event.data as [
    number | bigint,
    string,
    string | number | bigint,
    string | number | bigint,
  ];
  const escrowId = Number(escrowIdRaw);
  const sellerCut = BigInt(sellerCutRaw);
  const platformCut = BigInt(platformCutRaw);

  const record = await reader.getEscrow(escrowId);
  // A missing record for a `released` event is itself an anomaly, but a
  // different one — see unknownEscrow.ts. Without the locked amount there is
  // nothing to conserve against, so this invariant has nothing to say.
  if (!record) return [];

  const total = sellerCut + platformCut;
  if (total === record.amount) return [];

  return [
    {
      invariant: 'release_conservation',
      severity: 'critical',
      escrowId,
      txHash: event.txHash,
      ledger: event.ledger,
      message:
        `Escrow #${escrowId} released seller_cut(${sellerCut}) + platform_cut(${platformCut}) ` +
        `= ${total}, but the locked amount was ${record.amount}`,
      details: {
        escrowId,
        sellerCut: sellerCut.toString(),
        platformCut: platformCut.toString(),
        total: total.toString(),
        lockedAmount: record.amount.toString(),
      },
    },
  ];
}
