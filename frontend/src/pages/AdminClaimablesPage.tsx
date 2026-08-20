import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Loader2, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import { api, ReclaimableBalance } from '../lib/api';
import { formatUSDC, formatTimeAgo, truncateAddress } from '../lib/utils';
import { useToastContext } from '../components/ui/useToastContext';

/**
 * Admin view of treasury-reclaimable (expired, still-unclaimed) balances.
 * Guarded by the ADMIN_API_KEY entered here and sent as a Bearer token on
 * every request — nothing is persisted client-side.
 */
export default function AdminClaimablesPage() {
  const toast = useToastContext();
  const [adminKey, setAdminKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [balances, setBalances] = useState<ReclaimableBalance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState(false);

  const load = async () => {
    if (!adminKey) return;
    setLoading(true);
    try {
      const result = await api.adminGetReclaimableBalances(adminKey);
      setBalances(result);
    } catch (err) {
      toast.error('Failed to load', err instanceof Error ? err.message : undefined);
      setBalances(null);
    } finally {
      setLoading(false);
    }
  };

  const sweep = async () => {
    setSweeping(true);
    setConfirmSweep(false);
    try {
      const result = await api.adminSweepClaimables(adminKey);
      toast.success(
        `Swept ${result.swept.length} balance${result.swept.length === 1 ? '' : 's'}`,
        result.failed.length > 0 ? `${result.failed.length} failed — check logs.` : undefined,
      );
      await load();
    } catch (err) {
      toast.error('Sweep failed', err instanceof Error ? err.message : undefined);
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div className="min-h-screen pt-28 pb-20 px-4">
      <Helmet>
        <title>Admin — reclaimable balances</title>
      </Helmet>
      <div className="max-w-4xl mx-auto">
        <h1 className="font-display text-3xl font-bold text-foreground mb-2">
          Reclaimable claimable balances
        </h1>
        <p className="text-foreground-muted font-body mb-8">
          Balances past the treasury&apos;s reclaim cutoff — created for a seller, never claimed,
          and now eligible to be swept back so they don&apos;t stay stranded on-chain forever.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={adminKey}
              onChange={e => setAdminKey(e.target.value)}
              placeholder="ADMIN_API_KEY"
              className="w-full rounded-xl border border-border/40 bg-surface-2/40 px-4 py-2.5 pr-10 font-mono text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-1 focus:ring-gold"
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={!adminKey || loading}
            className="btn-gold text-sm px-5 py-2.5 flex items-center gap-2 justify-center"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Load
          </button>
        </div>

        {balances !== null && (
          <>
            {balances.length === 0 ? (
              <p className="font-body text-foreground-muted">Nothing reclaimable right now.</p>
            ) : (
              <div className="space-y-2 mb-6">
                {balances.map(b => (
                  <div
                    key={b.id}
                    className="rounded-xl border border-border/40 bg-surface-2/40 p-4 flex items-center justify-between gap-4"
                  >
                    <div>
                      <p className="font-display font-bold text-foreground">
                        {formatUSDC(b.amount)} {b.paymentToken ?? 'USDC'}
                      </p>
                      <p className="text-xs text-foreground-muted font-mono">
                        {truncateAddress(b.sellerWallet)}
                      </p>
                      <p className="text-xs text-foreground-muted font-body">
                        Reclaimable since {formatTimeAgo(b.reclaimableAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {balances.length > 0 && !confirmSweep && (
              <button
                type="button"
                onClick={() => setConfirmSweep(true)}
                className="btn-ghost text-sm px-5 py-2.5 flex items-center gap-2 border border-red-500/30 text-red-400"
              >
                <ShieldAlert className="w-4 h-4" />
                Sweep {balances.length} balance{balances.length === 1 ? '' : 's'} back to treasury
              </button>
            )}

            {confirmSweep && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                <p className="text-sm text-foreground font-body mb-3">
                  This reclaims {balances.length} balance{balances.length === 1 ? '' : 's'} on-chain
                  right now. Sellers who show up after this can no longer claim them. Are you sure?
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void sweep()}
                    disabled={sweeping}
                    className="btn-gold text-sm px-4 py-2 flex items-center gap-2"
                  >
                    {sweeping && <Loader2 className="w-4 h-4 animate-spin" />}
                    Confirm sweep
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmSweep(false)}
                    className="btn-ghost text-sm px-4 py-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
