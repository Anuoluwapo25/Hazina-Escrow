/**
 * adminActions.ts — the admin key has instant, untimelocked power to move
 * escrowed funds (#519). Every emergency_withdraw and every admin-identity
 * change fires critical, unconditionally — there is no "wrong" call here to
 * distinguish from a "right" one; the whole point is a human sees it happen.
 *
 * `upgrade()` emits no contract event at all, so it can't be caught here —
 * see upgradeWatch.ts, which polls the deployed WASM hash instead.
 */
import type { RaisedAlert, SentinelEvent } from '../types';

export function evaluate(event: SentinelEvent): RaisedAlert[] {
  if (event.topic === 'emerg_wd') {
    const [token, to, amount] = event.data as [string, string, string | number | bigint];
    return [
      {
        invariant: 'admin_action',
        severity: 'critical',
        dedupeSuffix: event.id,
        txHash: event.txHash,
        ledger: event.ledger,
        message: `emergency_withdraw moved ${String(amount)} of token ${token} to ${to}`,
        details: { action: 'emergency_withdraw', token, to, amount: String(amount) },
      },
    ];
  }

  if (event.topic === 'admin') {
    const [newAdmin] = event.data as [string];
    return [
      {
        invariant: 'admin_action',
        severity: 'critical',
        dedupeSuffix: event.id,
        txHash: event.txHash,
        ledger: event.ledger,
        message: `Admin transferred to ${newAdmin} (transfer_admin/set_admin)`,
        details: { action: 'transfer_admin', newAdmin },
      },
    ];
  }

  return [];
}
