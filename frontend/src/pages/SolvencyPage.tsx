import { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { ShieldCheck, ShieldAlert, Loader2, RefreshCcw } from 'lucide-react';
import clsx from 'clsx';
import { api, SolvencyReport } from '../lib/api';
import { truncateAddress } from '../lib/utils';

function formatStroops(raw: string): string {
  const value = Number(raw) / 1e7;
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Public transparency panel for Sentinel's solvency check (#599): total
 * locked on-chain vs. total open escrow liability, per token, and the
 * ledger the figures were checked against. No auth — publishing this costs
 * nothing once the checker exists, and it's a genuine trust signal.
 */
export default function SolvencyPage() {
  const [report, setReport] = useState<SolvencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.getSolvency());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load solvency data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-screen pt-28 pb-20 px-4">
      <Helmet>
        <title>Solvency</title>
      </Helmet>
      <div className="max-w-2xl mx-auto">
        <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
          Escrow contract — Sentinel
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground mb-3">
          Solvency
        </h1>
        <p className="text-foreground-muted font-body mb-8">
          The escrow contract&apos;s on-chain token balance, checked continuously against the sum of
          every open escrow. This page is public — it&apos;s the same figure our own monitoring
          watches.
        </p>

        <div className="flex items-center justify-between mb-4">
          {report && (
            <p className="text-xs text-foreground-muted font-body">
              Checked at ledger {report.lastCheckedLedger} · {report.openEscrowCount} open escrow
              {report.openEscrowCount === 1 ? '' : 's'}
            </p>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="text-xs text-gold hover:underline font-body flex items-center gap-1 ml-auto"
          >
            <RefreshCcw className={clsx('w-3 h-3', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>

        {loading && !report && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-gold animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 font-body">
            {error}
          </div>
        )}

        {report && report.tokens.length === 0 && !error && (
          <div className="rounded-xl border border-border/40 bg-surface-2/40 p-8 text-center">
            <ShieldCheck className="w-8 h-8 text-gold mx-auto mb-3" />
            <p className="font-body text-foreground-muted">No open escrows right now.</p>
          </div>
        )}

        {report && report.tokens.length > 0 && (
          <div className="space-y-3">
            {report.tokens.map(t => {
              const solvent = BigInt(t.delta) >= 0n;
              return (
                <div
                  key={t.token}
                  className={clsx(
                    'rounded-xl border p-4',
                    solvent ? 'border-border/40 bg-surface-2/40' : 'border-red-500/40 bg-red-500/5',
                  )}
                >
                  <div className="flex items-center justify-between mb-3">
                    <p className="font-mono text-xs text-foreground-muted">
                      {truncateAddress(t.token)}
                    </p>
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1.5 text-xs font-body font-semibold px-2 py-1 rounded-full',
                        solvent
                          ? 'text-emerald-400 bg-emerald-400/10'
                          : 'text-red-400 bg-red-400/10',
                      )}
                    >
                      {solvent ? (
                        <ShieldCheck className="w-3.5 h-3.5" />
                      ) : (
                        <ShieldAlert className="w-3.5 h-3.5" />
                      )}
                      {solvent ? 'Solvent' : 'Shortfall'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="font-display text-lg font-bold text-foreground">
                        {formatStroops(t.onChainBalance)}
                      </p>
                      <p className="text-xs text-foreground-muted font-body">On-chain balance</p>
                    </div>
                    <div>
                      <p className="font-display text-lg font-bold text-foreground">
                        {formatStroops(t.openLiability)}
                      </p>
                      <p className="text-xs text-foreground-muted font-body">Open liability</p>
                    </div>
                    <div>
                      <p
                        className={clsx(
                          'font-display text-lg font-bold',
                          solvent ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        {solvent ? '+' : ''}
                        {formatStroops(t.delta)}
                      </p>
                      <p className="text-xs text-foreground-muted font-body">Delta</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
