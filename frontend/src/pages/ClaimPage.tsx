import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Wallet, Loader2, Sparkles, ShieldCheck, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { api, ClaimableBalanceItem } from '../lib/api';
import {
  connectFreighter,
  signWithFreighter,
  submitSignedTransaction,
} from '../lib/stellarWallets';
import { formatUSDC, truncateAddress } from '../lib/utils';
import { useToastContext } from '../components/ui/useToastContext';

type ClaimStatus = 'idle' | 'claiming' | 'claimed' | 'error';

function ageLabel(iso: string | null): string {
  if (!iso) return 'unknown age';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function reclaimLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return `Reserved for you for ${days} more day${days === 1 ? '' : 's'}`;
}

export default function ClaimPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToastContext();

  const [sellerWallet, setSellerWallet] = useState(searchParams.get('seller') ?? '');
  const [claimables, setClaimables] = useState<ClaimableBalanceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ClaimStatus>>({});
  const [claimingAll, setClaimingAll] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadClaimables = useCallback(async (wallet: string) => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getSellerClaimables(wallet);
      setClaimables(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load claimable balances.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sellerWallet) void loadClaimables(sellerWallet);
  }, [sellerWallet, loadClaimables]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const publicKey = await connectFreighter();
      setSellerWallet(publicKey);
      setSearchParams({ seller: publicKey });
    } catch (err) {
      toast.error('Could not connect wallet', err instanceof Error ? err.message : undefined);
    } finally {
      setConnecting(false);
    }
  };

  const claimOne = async (balanceId: string): Promise<boolean> => {
    setStatuses(prev => ({ ...prev, [balanceId]: 'claiming' }));
    try {
      const { xdr } = await api.buildClaimTx(sellerWallet, balanceId);
      const signedXdr = await signWithFreighter(xdr);
      await submitSignedTransaction(signedXdr);
      setStatuses(prev => ({ ...prev, [balanceId]: 'claimed' }));
      return true;
    } catch (err) {
      setStatuses(prev => ({ ...prev, [balanceId]: 'error' }));
      toast.error(
        'Claim failed',
        err instanceof Error ? err.message : 'The transaction could not be completed.',
      );
      return false;
    }
  };

  const claimAll = async () => {
    setClaimingAll(true);
    let succeeded = 0;
    for (const item of claimables) {
      if (statuses[item.balanceId] === 'claimed') continue;
      // eslint-disable-next-line no-await-in-loop -- claims must be sequential: each bumps the treasury's sequence number
      const ok = await claimOne(item.balanceId);
      if (ok) succeeded += 1;
    }
    setClaimingAll(false);
    if (succeeded > 0) {
      toast.success(
        `Claimed ${succeeded} balance${succeeded === 1 ? '' : 's'}`,
        'Your USDC is now in your wallet.',
      );
    }
  };

  const pending = claimables.filter(c => statuses[c.balanceId] !== 'claimed');
  const anyClaiming = claimingAll || Object.values(statuses).some(s => s === 'claiming');

  return (
    <div className="min-h-screen pt-28 pb-20 px-4">
      <Helmet>
        <title>Claim your balance</title>
      </Helmet>
      <div className="max-w-2xl mx-auto">
        <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
          Payout escape hatch
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground mb-3">
          Claim your earnings
        </h1>
        <p className="text-foreground-muted font-body mb-8">
          Sometimes we can&apos;t pay you directly — your wallet may not yet trust USDC, or
          hasn&apos;t been funded with XLM. When that happens we reserve your money on-chain as a{' '}
          <strong className="text-foreground">Stellar claimable balance</strong> instead of losing
          it in a retry queue. Claiming opens the USDC trustline for you and hands you the funds in
          one signature — Hazina covers the setup cost, and never touches your wallet&apos;s key.
        </p>

        {!sellerWallet && (
          <div className="card p-6 border border-border/40 rounded-2xl bg-surface-2/40 mb-8">
            <div className="flex items-center gap-3 mb-4">
              <Wallet className="w-5 h-5 text-gold" />
              <p className="font-body text-foreground">
                Connect your wallet to see what&apos;s waiting
              </p>
            </div>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="btn-gold text-sm px-5 py-2.5 flex items-center gap-2"
            >
              {connecting && <Loader2 className="w-4 h-4 animate-spin" />}
              Connect Freighter
            </button>
          </div>
        )}

        {sellerWallet && (
          <>
            <div className="flex items-center justify-between mb-4">
              <p className="font-mono text-sm text-foreground-muted">
                {truncateAddress(sellerWallet)}
              </p>
              <button
                type="button"
                onClick={() => void loadClaimables(sellerWallet)}
                className="text-xs text-gold hover:underline font-body"
                disabled={loading}
              >
                Refresh
              </button>
            </div>

            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 text-gold animate-spin" />
              </div>
            )}

            {!loading && error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 font-body mb-6">
                {error}
              </div>
            )}

            {!loading && !error && claimables.length === 0 && (
              <div className="rounded-xl border border-border/40 bg-surface-2/40 p-8 text-center">
                <ShieldCheck className="w-8 h-8 text-gold mx-auto mb-3" />
                <p className="font-body text-foreground-muted">
                  Nothing waiting for this wallet right now.
                </p>
              </div>
            )}

            {!loading && !error && claimables.length > 0 && (
              <div className="space-y-3">
                {claimables.map(item => {
                  const status = statuses[item.balanceId] ?? 'idle';
                  return (
                    <div
                      key={item.balanceId}
                      className="rounded-xl border border-border/40 bg-surface-2/40 p-4 flex items-center justify-between gap-4"
                    >
                      <div>
                        <p className="font-display text-lg font-bold text-foreground">
                          {formatUSDC(parseFloat(item.amount))} {item.assetCode}
                        </p>
                        <p className="text-xs text-foreground-muted font-body">
                          {ageLabel(item.createdAt)}
                          {reclaimLabel(item.reclaimableAt)
                            ? ` · ${reclaimLabel(item.reclaimableAt)}`
                            : ''}
                        </p>
                        <a
                          href={`https://stellar.expert/explorer/testnet/claimable-balance/${item.balanceId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gold hover:underline font-body inline-flex items-center gap-1 mt-1"
                        >
                          View on Stellar Expert <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                      <button
                        type="button"
                        onClick={() => void claimOne(item.balanceId)}
                        disabled={status === 'claiming' || status === 'claimed' || anyClaiming}
                        className={clsx(
                          'btn-gold text-sm px-4 py-2 flex items-center gap-2 shrink-0',
                          status === 'claimed' && 'opacity-60',
                        )}
                      >
                        {status === 'claiming' && <Loader2 className="w-4 h-4 animate-spin" />}
                        {status === 'claimed' ? 'Claimed' : 'Claim'}
                      </button>
                    </div>
                  );
                })}

                {pending.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void claimAll()}
                    disabled={anyClaiming}
                    className="btn-ghost w-full text-sm px-4 py-3 flex items-center justify-center gap-2"
                  >
                    {claimingAll ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    Claim all ({pending.length})
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
