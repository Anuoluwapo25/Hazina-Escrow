import { useState, useEffect } from 'react';
import { Zap, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { detectWallets, launchStellarWalletProvider } from '../../lib/stellarWallets';
import type {
  StellarWalletProvider,
  StellarPaymentRequest,
  WalletDetectionResult,
} from '../../lib/stellarWallets';
import clsx from 'clsx';

interface WalletConnectButtonProps {
  payment: StellarPaymentRequest;
  onTxHash: (hash: string) => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: string) => void;
  className?: string;
}

export default function WalletConnectButton({
  payment,
  onTxHash,
  onStatusChange,
  onError,
  className,
}: WalletConnectButtonProps) {
  const [detected, setDetected] = useState<WalletDetectionResult | null>(null);
  const [loading, setLoading] = useState<StellarWalletProvider | null>(null);

  useEffect(() => {
    detectWallets().then(setDetected);
  }, []);

  const handlePay = async (provider: StellarWalletProvider) => {
    setLoading(provider);
    onStatusChange?.('');
    try {
      const hash = await launchStellarWalletProvider(provider, payment);
      if (hash) {
        onTxHash(hash);
        onStatusChange?.('Transaction hash received. Verify to unlock the dataset.');
      } else {
        onStatusChange?.(
          'Complete the payment in your wallet, then paste the transaction hash below.',
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Wallet request failed.';
      onError?.(msg);
      onStatusChange?.(msg);
    } finally {
      setLoading(null);
    }
  };

  if (!detected) {
    return (
      <div className={clsx('flex items-center justify-center py-4', className)}>
        <Loader2 className="w-4 h-4 text-gold animate-spin" />
      </div>
    );
  }

  const hasAnyWallet = detected.freighter || detected.albedo;

  return (
    <div className={clsx('space-y-3', className)}>
      <p className="text-xs text-muted-2 font-body flex items-center gap-1.5">
        <Wallet className="w-3.5 h-3.5" />
        Pay with wallet
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => handlePay('freighter')}
          disabled={loading !== null}
          className={clsx(
            'btn-ghost py-2.5 text-xs flex items-center justify-center gap-2 transition-all',
            detected.freighter && 'ring-1 ring-gold/30',
            loading === 'freighter' && 'opacity-70',
          )}
        >
          {loading === 'freighter' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Zap className="w-3.5 h-3.5" />
          )}
          Freighter
          {detected.freighter && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-emerald-400"
              aria-label="Freighter detected"
            />
          )}
        </button>

        <button
          type="button"
          onClick={() => handlePay('albedo')}
          disabled={loading !== null}
          className={clsx(
            'btn-ghost py-2.5 text-xs flex items-center justify-center gap-2 transition-all',
            detected.albedo && 'ring-1 ring-gold/30',
            loading === 'albedo' && 'opacity-70',
          )}
        >
          {loading === 'albedo' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ExternalLink className="w-3.5 h-3.5" />
          )}
          Albedo
          {detected.albedo && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-emerald-400"
              aria-label="Albedo detected"
            />
          )}
        </button>
      </div>

      {!hasAnyWallet && (
        <p className="text-xs text-muted font-body">
          No wallet detected. Install{' '}
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold hover:underline"
          >
            Freighter
          </a>{' '}
          or use Albedo (opens in a new tab).
        </p>
      )}
    </div>
  );
}
