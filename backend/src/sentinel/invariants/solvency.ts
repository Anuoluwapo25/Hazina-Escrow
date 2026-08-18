/**
 * solvency.ts — the cheapest possible mitigation for an admin-key risk you
 * can't design away (#519): the contract's on-chain token balance must
 * always be >= the sum of every open escrow's amount, per token. A gap means
 * money the contract owes sellers/buyers isn't actually there.
 *
 * Ground truth comes from get_escrow_count/get_escrow (not the ingested
 * event stream) precisely so a bug in event decoding or a gap in ingestion
 * can't hide a real shortfall — see docs/MONITORING.md.
 */
import type { EscrowReader, OpenEscrow, RaisedAlert } from '../types';
import { scanOpenEscrows, type ScannedEscrow } from './scan';

export interface TokenSolvency {
  token: string;
  onChainBalance: string;
  openLiability: string;
  /** onChainBalance - openLiability, as a signed decimal string. Negative means a shortfall. */
  delta: string;
}

export interface SolvencyReport {
  tokens: TokenSolvency[];
  openEscrowCount: number;
  lastCheckedLedger: number;
  checkedAt: string;
}

function groupByToken(open: ScannedEscrow[]): Map<string, bigint> {
  const byToken = new Map<string, bigint>();
  for (const escrow of open) {
    byToken.set(escrow.token, (byToken.get(escrow.token) ?? 0n) + escrow.amount);
  }
  return byToken;
}

export async function computeSolvency(
  reader: EscrowReader,
  open?: ScannedEscrow[] | OpenEscrow[],
): Promise<SolvencyReport> {
  const openEscrows = open ?? (await scanOpenEscrows(reader));
  const byToken = groupByToken(openEscrows as ScannedEscrow[]);
  const lastCheckedLedger = await reader.getLatestLedger();

  const tokens: TokenSolvency[] = [];
  for (const [token, openLiability] of byToken) {
    const onChainBalance = await reader.getTokenBalance(token);
    tokens.push({
      token,
      onChainBalance: onChainBalance.toString(),
      openLiability: openLiability.toString(),
      delta: (onChainBalance - openLiability).toString(),
    });
  }

  return {
    tokens,
    openEscrowCount: openEscrows.length,
    lastCheckedLedger,
    checkedAt: new Date().toISOString(),
  };
}

export async function evaluate(
  reader: EscrowReader,
  open?: ScannedEscrow[] | OpenEscrow[],
): Promise<RaisedAlert[]> {
  const report = await computeSolvency(reader, open);
  const alerts: RaisedAlert[] = [];

  for (const t of report.tokens) {
    if (BigInt(t.delta) < 0n) {
      alerts.push({
        invariant: 'solvency',
        severity: 'critical',
        dedupeSuffix: t.token,
        ledger: report.lastCheckedLedger,
        message:
          `Token ${t.token}: on-chain balance ${t.onChainBalance} is below open escrow ` +
          `liability ${t.openLiability} (short ${(-BigInt(t.delta)).toString()})`,
        details: {
          token: t.token,
          onChainBalance: t.onChainBalance,
          openLiability: t.openLiability,
          delta: t.delta,
        },
      });
    }
  }

  return alerts;
}
