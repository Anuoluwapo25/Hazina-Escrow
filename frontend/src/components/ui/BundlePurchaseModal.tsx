import { useEffect, useId, useRef, useState } from 'react';
import { X, Loader2, ShieldCheck, AlertCircle, CheckCircle2, Layers } from 'lucide-react';
import clsx from 'clsx';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useToastContext } from './useToastContext';
import { formatUSDC, truncateAddress } from '../../lib/utils';
import { useI18n } from '../../i18n';
import type { Bundle, BundlePurchase } from '../../lib/api';
import { purchaseBundle, confirmBundleDelivery } from '../../lib/bundle';

type Step =
  | 'confirm'
  | 'purchasing'
  | 'delivered'
  | 'confirming'
  | 'released'
  | 'refunded'
  | 'error';

interface Props {
  bundle: Bundle;
  onClose: () => void;
}

export default function BundlePurchaseModal({ bundle, onClose }: Props) {
  const { locale, t } = useI18n();
  const { error: toastError, success: toastSuccess } = useToastContext();
  const [step, setStep] = useState<Step>('confirm');
  const [purchase, setPurchase] = useState<BundlePurchase | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [confirmProgress, setConfirmProgress] = useState({ confirmed: 0, total: 0 });

  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(modalRef);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handlePurchase() {
    setStep('purchasing');
    setErrorMessage('');
    try {
      const { purchase: locked } = await purchaseBundle(bundle.id);
      setPurchase(locked);
      if (locked.status === 'delivered') {
        setStep('delivered');
      } else if (locked.status === 'refunded' || locked.status === 'failed') {
        setStep('refunded');
      } else {
        // 'locked' or 'delivering' — delivery is synchronous server-side today,
        // so this is a defensive fallback, not the expected path.
        setStep('delivered');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStep('error');
      toastError(t('bundles.purchase.error', { message }));
    }
  }

  async function handleConfirm() {
    if (!purchase) return;
    setStep('confirming');
    setErrorMessage('');
    setConfirmProgress({ confirmed: 0, total: purchase.escrowIds.length });
    try {
      const released = await confirmBundleDelivery(purchase.id, (confirmed, total) =>
        setConfirmProgress({ confirmed, total }),
      );
      setPurchase(released);
      if (released.status === 'released') {
        setStep('released');
        toastSuccess(t('bundles.purchase.success'));
      } else {
        setStep('delivered');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStep('error');
      toastError(t('bundles.purchase.error', { message }));
    }
  }

  const sortedComponents = [...bundle.components].sort((a, b) => a.position - b.position);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-void/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-lg glass-card-gold overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        <div className="h-px bg-gradient-to-r from-transparent via-violet-400 to-transparent" />

        <div className="flex items-start justify-between p-6 pb-4">
          <div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-body font-semibold uppercase tracking-wide bg-violet-400/15 text-violet-300 border border-violet-400/30 mb-2">
              <Layers className="w-3 h-3" />
              {t('bundles.card.badge')}
            </span>
            <h2
              id={titleId}
              className="font-display font-bold text-xl text-foreground leading-tight"
            >
              {bundle.name}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground p-1 transition-colors flex-shrink-0"
            aria-label={t('common.actions.close')}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 pb-6">
          {step === 'confirm' && (
            <>
              <div className="glass-card p-4 mb-4">
                <p className="text-sm font-body text-foreground-muted mb-3">
                  {t('bundles.detail.title')}
                </p>
                <ul className="space-y-1.5">
                  {sortedComponents.map(component => (
                    <li
                      key={component.id}
                      className="flex items-center justify-between text-xs font-body"
                    >
                      <span className="text-foreground-muted truncate mr-2">
                        {component.datasetId}
                      </span>
                      <span className="font-mono text-violet-300 flex-shrink-0">
                        {(component.shareBps / 100).toFixed(component.shareBps % 100 === 0 ? 0 : 1)}
                        %
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between text-xs font-body pt-1.5 mt-1.5 border-t border-border/20">
                    <span className="text-muted-2">{t('bundles.detail.curatorShare')}</span>
                    <span className="font-mono text-violet-300 flex-shrink-0">
                      {(bundle.curatorFeeBps / 100).toFixed(
                        bundle.curatorFeeBps % 100 === 0 ? 0 : 1,
                      )}
                      %
                    </span>
                  </li>
                </ul>
              </div>

              <div className="text-center mb-5 p-5 glass-card">
                <p className="text-xs text-muted-2 font-body mb-1">{t('common.labels.total')}</p>
                <p className="text-3xl font-display font-bold text-violet-300">
                  ${formatUSDC(bundle.totalPrice, locale)} USDC
                </p>
              </div>

              <button
                onClick={handlePurchase}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-body font-semibold text-sm bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400 transition-all"
              >
                <ShieldCheck className="w-4 h-4" />
                {t('bundles.card.buyLabel', { price: formatUSDC(bundle.totalPrice, locale) })}
              </button>
            </>
          )}

          {step === 'purchasing' && (
            <div className="text-center py-10">
              <Loader2 className="w-10 h-10 text-violet-300 animate-spin mx-auto mb-4" />
              <p className="text-sm font-body text-foreground-muted">
                {t('bundles.purchase.locking')}
              </p>
            </div>
          )}

          {step === 'delivered' && purchase && (
            <div className="text-center py-6">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-4" />
              <p className="text-sm font-body text-foreground-muted mb-1">
                {t('bundles.purchase.delivering')}
              </p>
              <p className="text-xs font-mono text-muted-2 mb-6">
                {purchase.escrowIds.length} escrows locked · {truncateAddress(purchase.buyerWallet)}
              </p>
              <button
                onClick={handleConfirm}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-body font-semibold text-sm bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400 transition-all"
              >
                <ShieldCheck className="w-4 h-4" />
                {t('bundles.purchase.confirmCta')}
              </button>
            </div>
          )}

          {step === 'confirming' && (
            <div className="text-center py-10">
              <Loader2 className="w-10 h-10 text-violet-300 animate-spin mx-auto mb-4" />
              <p className="text-sm font-body text-foreground-muted">
                {t('bundles.purchase.confirming', {
                  current: confirmProgress.confirmed,
                  total: confirmProgress.total,
                })}
              </p>
            </div>
          )}

          {step === 'released' && purchase && (
            <div className="text-center py-6">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
              <p className="font-display text-lg text-foreground mb-2">
                {t('bundles.purchase.success')}
              </p>
              {purchase.releaseTxHash && (
                <p className="text-xs font-mono text-muted-2 mb-4">{purchase.releaseTxHash}</p>
              )}
              {purchase.aiSummary && (
                <div className="glass-card p-4 text-left mb-4">
                  <p className="text-[10px] uppercase tracking-wide text-muted-2 font-body mb-2">
                    {t('bundles.purchase.viewSummary')}
                  </p>
                  <p className="text-sm font-body text-foreground-muted whitespace-pre-wrap">
                    {purchase.aiSummary}
                  </p>
                </div>
              )}
              <button onClick={onClose} className="btn-gold w-full py-3 text-sm">
                {t('bundles.purchase.close')}
              </button>
            </div>
          )}

          {step === 'refunded' && purchase && (
            <div className="text-center py-6">
              <AlertCircle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
              <p className="font-display text-lg text-foreground mb-2">
                {purchase.status === 'failed'
                  ? t('bundles.purchase.failed')
                  : t('bundles.purchase.refunded')}
              </p>
              {purchase.failureReason && (
                <p className="text-sm font-body text-foreground-muted mb-4">
                  {purchase.failureReason}
                </p>
              )}
              <button onClick={onClose} className="btn-ghost w-full py-3 text-sm">
                {t('bundles.purchase.close')}
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="text-center py-6">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <p className="font-display text-lg text-foreground mb-2">
                {t('bundles.purchase.failed')}
              </p>
              <p className="text-sm font-body text-foreground-muted mb-4">{errorMessage}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep('confirm')}
                  className={clsx('btn-ghost flex-1 py-3 text-sm')}
                >
                  {t('common.actions.tryAgain')}
                </button>
                <button onClick={onClose} className="btn-gold flex-1 py-3 text-sm">
                  {t('common.actions.close')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
