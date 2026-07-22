import { useEffect, useState, useCallback } from 'react';
import { Lock, CheckCircle2, AlertTriangle, RotateCcw, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { api, type EscrowState } from '../../lib/api';
import { escrowStatusLabel } from '../../lib/escrow';
import { getEnv } from '../../lib/env';

interface EscrowStatusProps {
  escrowId: number;
  /** Poll interval in ms while the escrow is still open (0 disables polling). */
  pollMs?: number;
  className?: string;
}

const STATUS_META: Record<
  ReturnType<typeof escrowStatusLabel>,
  { label: string; color: string; bg: string; Icon: typeof Lock }
> = {
  locked: {
    label: 'Funds locked on-chain',
    color: 'text-sky-400',
    bg: 'bg-sky-400/10',
    Icon: Lock,
  },
  confirmed: {
    label: 'Delivery confirmed',
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    Icon: CheckCircle2,
  },
  released: {
    label: 'Released to seller (95/5 split)',
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    Icon: CheckCircle2,
  },
  refunded: {
    label: 'Refunded to buyer',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    Icon: RotateCcw,
  },
  disputed: {
    label: 'Disputed',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    Icon: AlertTriangle,
  },
};

function stellarExpertContractUrl(contractId: string): string {
  const network = getEnv().stellarNetwork === 'public' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/contract/${contractId}`;
}

/**
 * Live on-chain escrow state panel (#548). Reads the authoritative EscrowRecord
 * from the contract via the backend and reflects settlement status in real time.
 * A terminal state (released/refunded) stops the poll.
 */
export function EscrowStatus({ escrowId, pollMs = 5000, className }: EscrowStatusProps) {
  const [escrow, setEscrow] = useState<EscrowState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await api.getEscrow(escrowId);
      setEscrow(state);
      setError(null);
      return state;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read escrow state');
      return null;
    }
  }, [escrowId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const state = await refresh();
      if (!active) return;
      const settled = state?.released || state?.refunded;
      if (pollMs > 0 && !settled) {
        timer = setTimeout(tick, pollMs);
      }
    };

    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, pollMs]);

  if (error && !escrow) {
    return (
      <div className={clsx('rounded-lg border border-red-400/20 bg-red-400/10 p-3', className)}>
        <p className="text-xs font-body text-red-400">
          Escrow #{escrowId}: {error}
        </p>
      </div>
    );
  }

  if (!escrow) {
    return (
      <div className={clsx('rounded-lg border border-border p-3 animate-pulse', className)}>
        <p className="text-xs font-body text-foreground-muted">Reading escrow #{escrowId}…</p>
      </div>
    );
  }

  const status = escrowStatusLabel(escrow);
  const meta = STATUS_META[status];
  const { Icon } = meta;

  return (
    <div
      className={clsx('rounded-lg border border-current/20 p-4', meta.bg, meta.color, className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" aria-hidden="true" />
        <span className="text-sm font-body font-medium">{meta.label}</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-body text-foreground-muted">
        <dt>Escrow ID</dt>
        <dd className="text-right text-foreground">#{escrow.escrowId}</dd>
        <dt>Amount</dt>
        <dd className="text-right text-foreground">{escrow.amount}</dd>
        <dt>Platform fee</dt>
        <dd className="text-right text-foreground">{escrow.platformFeeBps / 100}%</dd>
        <dt>Buyer confirmed</dt>
        <dd className="text-right text-foreground">{escrow.buyerConfirmed ? 'Yes' : 'No'}</dd>
      </dl>

      <a
        href={stellarExpertContractUrl(escrow.token)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs font-body underline hover:no-underline"
      >
        View on Stellar Expert
        <ExternalLink className="w-3 h-3" aria-hidden="true" />
      </a>
    </div>
  );
}
