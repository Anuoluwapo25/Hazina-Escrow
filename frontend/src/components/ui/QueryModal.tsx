import { useState, useEffect, useId, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  X,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  Sparkles,
  ShieldCheck,
  AlertCircle,
  ChevronRight,
  Zap,
  Star,
} from 'lucide-react';
import { api, DatasetMeta, QueryResult } from '../../lib/api';
import { useToastContext } from './ToastProvider';
import { formatUSDC, getTypeMeta, truncateAddress } from '../../lib/utils';
import WalletConnectButton from './WalletConnectButton';
import clsx from 'clsx';
import { getCatalog, useI18n } from '../../i18n';
import { isDemoModeEnabled } from '../../lib/env';

type Step = 'details' | 'payment' | 'verifying' | 'result' | 'error';

interface Props {
  dataset: DatasetMeta;
  onClose: () => void;
  onSuccess: (updated: Partial<DatasetMeta> & { id: string }) => void;
  isOpen?: boolean;
}

export default function QueryModal({ dataset, onClose, onSuccess, isOpen = true }: Props) {
  const { locale, t } = useI18n();
  const catalog = getCatalog(locale);
  const { success: toastSuccess, error: toastError } = useToastContext();
  const [step, setStep] = useState<Step>('details');
  const [paymentInfo, setPaymentInfo] = useState<{
    paymentAddress: string;
    amount: number;
    memo: string;
  } | null>(null);
  const [txHash, setTxHash] = useState('');
  const [buyerQuestion, setBuyerQuestion] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [useDemoMode, setUseDemoMode] = useState(false);
  const [verifyStage, setVerifyStage] = useState(0);
  const [walletStatus, setWalletStatus] = useState('');

  const [ratingScore, setRatingScore] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [isSubmittingRating, setIsSubmittingRating] = useState(false);

  const verifyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(modalRef);

  const typeMeta = getTypeMeta(dataset.type);
  const typeLabel = typeMeta.labelKey ? t(typeMeta.labelKey) : typeMeta.label;
  const verifyingStages = catalog.queryModal.verifyingStages;
  const enableDemoMode = isDemoModeEnabled();

  // Reset all state when the modal is (re)opened so stale results from a
  // previous session never bleed through when the same component instance is
  // reused across open/close cycles.
  useEffect(() => {
    if (isOpen) {
      setStep('details');
      setError('');
      setTxHash('');
      setBuyerQuestion('');
      setResult(null);
      setPaymentInfo(null);
      setVerifyStage(0);
      setWalletStatus('');
      setUseDemoMode(false);
      setRatingScore(0);
      setRatingComment('');
      setRatingSubmitted(false);
      setIsSubmittingRating(false);
    }
  }, [isOpen]);

  // Fetch 402 payment details
  useEffect(() => {
    if (isOpen && step === 'payment' && !paymentInfo) {
      api.initiateQuery(dataset.id).then(res => {
        if (res.payment) setPaymentInfo(res.payment);
      });
    }
  }, [isOpen, step, paymentInfo, dataset.id]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const clearVerifyTimer = () => {
    if (verifyTimerRef.current) {
      clearInterval(verifyTimerRef.current);
      verifyTimerRef.current = null;
    }
  };

  const handleVerify = async () => {
    if (!txHash.trim() && !useDemoMode) return;
    setVerifyStage(0);
    setStep('verifying');
    // Cycle through stage labels while waiting
    verifyTimerRef.current = setInterval(() => {
      setVerifyStage(s => Math.min(s + 1, verifyingStages.length - 1));
    }, 1800);
    try {
      let res: QueryResult;
      if (enableDemoMode && useDemoMode) {
        res = await api.demoQuery(dataset.id, buyerQuestion);
      } else {
        res = await api.verifyPayment(dataset.id, txHash.trim(), buyerQuestion);
      }
      clearVerifyTimer();
      console.log('QUERY_RESULT', res);
      setResult(res);
      setStep('result');
      toastSuccess(t('queryModal.result.paymentVerified'), dataset.name);
      const delivered = res.transaction.deliveryStatus === 'delivered';
      onSuccess({
        id: dataset.id,
        queriesServed: delivered || res.demo ? dataset.queriesServed + 1 : dataset.queriesServed,
        totalEarned:
          res.demo || !delivered
            ? dataset.totalEarned
            : dataset.totalEarned + res.transaction.sellerReceived,
      });
    } catch (err: unknown) {
      clearVerifyTimer();
      const msg = err instanceof Error ? err.message : t('queryModal.error.title');
      setError(msg);
      toastError(t('queryModal.error.title'), msg);
      setStep('error');
    }
  };

  const handleWalletTxHash = (hash: string) => {
    setTxHash(hash);
  };

  const handleRatingSubmit = async () => {
    if (!ratingScore || !result) return;
    setIsSubmittingRating(true);
    try {
      await api.submitRating(dataset.id, result.transaction.hash, ratingScore, ratingComment);
      setRatingSubmitted(true);
      toastSuccess('Rating submitted', 'Thank you for your feedback!');
    } catch (err) {
      toastError('Failed to submit rating', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSubmittingRating(false);
    }
  };

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (step !== 'result' && step !== 'error') {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [step, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-void/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-lg glass-card-gold overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        {/* Gold top bar */}
        <div className="h-px bg-gradient-to-r from-transparent via-gold to-transparent" />

        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4">
          <div>
            <span
              className={clsx('type-badge text-xs mb-2 inline-flex', typeMeta.color, typeMeta.bg)}
            >
              <Zap className="w-3 h-3" />
              {typeLabel}
            </span>
            <h2
              id={titleId}
              className="font-display font-bold text-xl text-foreground leading-tight"
            >
              {dataset.name}
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

        {/* Progress steps */}
        {step !== 'result' && step !== 'error' && (
          <div className="flex items-center gap-0 px-6 mb-6">
            {(['details', 'payment', 'verifying'] as Step[]).map((s, i) => (
              <div key={s} className="flex items-center flex-1">
                <div
                  className={clsx(
                    'w-7 h-7 rounded-full border text-xs font-body font-medium flex items-center justify-center flex-shrink-0',
                    step === s
                      ? 'border-gold bg-gold text-void'
                      : ['payment', 'verifying'].includes(step) && i === 0
                        ? 'border-gold/50 bg-gold/10 text-gold'
                        : step === 'verifying' && i === 1
                          ? 'border-gold/50 bg-gold/10 text-gold'
                          : 'border-border text-muted',
                  )}
                >
                  {i + 1}
                </div>
                {i < 2 && (
                  <div
                    className={clsx(
                      'flex-1 h-px',
                      i < ['details', 'payment', 'verifying'].indexOf(step)
                        ? 'bg-gold/40'
                        : 'bg-border',
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="px-6 pb-6">
          {/* ── STEP 1: Details ── */}
          {step === 'details' && (
            <div>
              <p className="text-sm text-foreground-muted font-body mb-5 leading-relaxed">
                {dataset.description}
              </p>

              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="glass-card p-4">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('queryModal.details.pricePerQuery')}
                  </p>
                  <p className="font-display font-bold text-xl text-gold">
                    ${formatUSDC(dataset.pricePerQuery, locale)} USDC
                  </p>
                </div>
                <div className="glass-card p-4">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('queryModal.details.queriesSold')}
                  </p>
                  <p className="font-display font-bold text-xl text-foreground">
                    {dataset.queriesServed.toLocaleString(locale)}
                  </p>
                </div>
                <div className="glass-card p-4">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('queryModal.details.seller')}
                  </p>
                  <p className="font-mono text-xs text-foreground">
                    {truncateAddress(dataset.sellerWallet)}
                  </p>
                </div>
                <div className="glass-card p-4">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('queryModal.details.network')}
                  </p>
                  <p className="text-xs font-body font-medium text-emerald-400">
                    {t('common.states.testnet')}
                  </p>
                </div>
              </div>

              {/* Optional question */}
              <div className="mb-5">
                <label className="text-sm font-body font-medium text-foreground-muted mb-2 block">
                  {t('queryModal.details.askQuestion')}{' '}
                  <span className="text-muted-2">{t('common.labels.optional')}</span>
                </label>
                <textarea
                  value={buyerQuestion}
                  onChange={e => setBuyerQuestion(e.target.value)}
                  placeholder={t('queryModal.details.questionPlaceholder')}
                  className="w-full bg-void/60 border border-border/60 rounded-xl p-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors resize-none h-20"
                />
              </div>

              <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 mb-5">
                <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <p className="text-xs text-emerald-400 font-body">
                  {t('queryModal.details.escrowNote')}
                </p>
              </div>

              <button
                onClick={() => setStep('payment')}
                className="btn-gold w-full flex items-center justify-center gap-2 py-3.5"
              >
                {t('common.actions.proceedToPayment')}
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── STEP 2: Payment ── */}
          {step === 'payment' && (
            <div>
              <div className="text-center mb-5 p-5 glass-card">
                <p className="text-4xl font-display font-bold text-gold mb-1">
                  ${formatUSDC(dataset.pricePerQuery, locale)}
                </p>
                <p className="text-sm text-foreground-muted font-body">
                  {t('queryModal.payment.headline')}
                </p>
              </div>

              {paymentInfo ? (
                <div className="space-y-3 mb-5">
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-muted-2 font-body">
                        {t('queryModal.payment.sendToAddress')}
                      </p>
                      <button
                        onClick={() => copyToClipboard(paymentInfo.paymentAddress, 'addr')}
                        className="text-gold hover:text-gold-light transition-colors"
                        aria-label={t('common.actions.copyAddress')}
                      >
                        {copied === 'addr' ? (
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    <p className="font-mono text-xs text-foreground break-all">
                      {paymentInfo.paymentAddress}
                    </p>
                  </div>

                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-muted-2 font-body">
                        {t('queryModal.payment.requiredMemo')}
                      </p>
                      <button
                        onClick={() => copyToClipboard(paymentInfo.memo, 'memo')}
                        className="text-gold hover:text-gold-light transition-colors"
                        aria-label={t('common.actions.copyMemo')}
                      >
                        {copied === 'memo' ? (
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    <p className="font-mono text-sm text-amber-400">{paymentInfo.memo}</p>
                  </div>

                  <div className="glass-card p-4">
                    <WalletConnectButton
                      payment={paymentInfo}
                      onTxHash={handleWalletTxHash}
                      onStatusChange={setWalletStatus}
                    />
                    {walletStatus && (
                      <p
                        className="text-xs text-foreground-muted font-body mt-3"
                        aria-live="polite"
                      >
                        {walletStatus}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-gold animate-spin" />
                </div>
              )}

              {/* Instructions */}
              <div className="p-4 rounded-xl bg-gold/5 border border-gold/15 mb-5">
                <p className="text-xs font-body font-semibold text-gold mb-2">
                  {t('queryModal.payment.stepsTitle')}
                </p>
                <ol className="space-y-1">
                  {[
                    t('queryModal.payment.stepOne'),
                    t('queryModal.payment.stepTwo', {
                      amount: `$${formatUSDC(dataset.pricePerQuery, locale)}`,
                    }),
                    t('queryModal.payment.stepThree'),
                    t('queryModal.payment.stepFour'),
                  ].map((step, i) => (
                    <li key={i} className="text-xs text-foreground-muted font-body flex gap-2">
                      <span className="text-gold flex-shrink-0">{i + 1}.</span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Tx hash input */}
              <div className="mb-4">
                <label className="text-sm font-body font-medium text-foreground-muted mb-2 block">
                  {t('queryModal.payment.transactionHash')}
                </label>
                <input
                  type="text"
                  placeholder={t('queryModal.payment.transactionHashPlaceholder')}
                  value={txHash}
                  onChange={e => setTxHash(e.target.value)}
                  className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
                />
              </div>

              {/* Demo mode toggle */}
              {enableDemoMode && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-surface-2/60 border border-border/40 mb-4">
                  <input
                    type="checkbox"
                    id="demo-mode"
                    checked={useDemoMode}
                    onChange={e => setUseDemoMode(e.target.checked)}
                    className="w-4 h-4 accent-amber-400"
                  />
                  <label htmlFor="demo-mode" className="text-xs text-foreground-muted font-body">
                    <span className="text-amber-400 font-medium">
                      {t('queryModal.payment.demoModeLabel')}
                    </span>{' '}
                    — {t('queryModal.payment.demoModeDescription')}
                  </label>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setStep('details')}
                  className="btn-ghost flex-1 py-3 text-sm"
                >
                  {t('common.actions.back')}
                </button>
                <button
                  onClick={handleVerify}
                  disabled={!txHash.trim() && !useDemoMode}
                  className={clsx(
                    'btn-gold flex-1 py-3 text-sm flex items-center justify-center gap-2',
                    !txHash.trim() && !useDemoMode && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <ShieldCheck className="w-4 h-4" />
                  {useDemoMode
                    ? t('common.actions.getAiAnalysis')
                    : t('common.actions.verifyAndGetData')}
                </button>
              </div>

              <a
                href="https://laboratory.stellar.org"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 mt-3 text-xs text-muted hover:text-gold transition-colors font-body"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('common.actions.openStellarLab')}
              </a>
            </div>
          )}

          {/* ── STEP 3: Verifying ── */}
          {step === 'verifying' && (
            <div className="text-center py-10">
              <div className="relative inline-flex mb-6">
                <div className="w-16 h-16 rounded-full border-2 border-gold/20 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-gold animate-spin" />
                </div>
                <div className="absolute inset-0 rounded-full border-2 border-gold/10 animate-ping" />
              </div>
              <h3 className="font-display font-semibold text-xl text-foreground mb-2">
                {useDemoMode
                  ? t('queryModal.verifying.runningDemo')
                  : t('queryModal.verifying.verifyingPayment')}
              </h3>
              <p className="text-sm text-foreground-muted font-body transition-all duration-500">
                {verifyingStages[verifyStage]}
              </p>
              <div className="flex justify-center gap-1.5 mt-4">
                {verifyingStages.map((_, i) => (
                  <div
                    key={i}
                    className={clsx(
                      'h-1 rounded-full transition-all duration-500',
                      i === verifyStage
                        ? 'w-6 bg-gold'
                        : i < verifyStage
                          ? 'w-2 bg-gold/40'
                          : 'w-2 bg-border',
                    )}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── RESULT ── */}
          {step === 'result' && result && (
            <div>
              <div
                className={clsx(
                  'flex items-center gap-2 mb-4 p-3 rounded-xl border',
                  result.transaction.deliveryStatus === 'delivered'
                    ? 'bg-emerald-500/10 border-emerald-500/25'
                    : 'bg-amber-500/10 border-amber-500/25',
                )}
              >
                <ShieldCheck
                  className={clsx(
                    'w-5 h-5 flex-shrink-0',
                    result.transaction.deliveryStatus === 'delivered'
                      ? 'text-emerald-400'
                      : 'text-amber-400',
                  )}
                />
                <div>
                  <p
                    className={clsx(
                      'text-sm font-body font-semibold',
                      result.transaction.deliveryStatus === 'delivered'
                        ? 'text-emerald-400'
                        : 'text-amber-400',
                    )}
                  >
                    {result.transaction.deliveryStatus === 'delivered'
                      ? t('queryModal.result.paymentVerified')
                      : 'Payment received, delivery pending'}
                  </p>
                  <p
                    className={clsx(
                      'text-xs font-mono',
                      result.transaction.deliveryStatus === 'delivered'
                        ? 'text-emerald-400/70'
                        : 'text-amber-400/70',
                    )}
                  >
                    {result.transaction.hash.slice(0, 40)}...
                  </p>
                  {result.warning && (
                    <p className="text-xs text-amber-300/80 font-body mt-1">{result.warning}</p>
                  )}
                </div>
              </div>

              {/* Transaction breakdown */}
              <div className="grid grid-cols-3 gap-2 mb-5">
                <div className="glass-card p-3 text-center">
                  <p className="text-xs text-muted-2 font-body mb-1">{t('common.labels.paid')}</p>
                  <p className="text-sm font-bold text-gold font-display">
                    ${formatUSDC(result.transaction.amount, locale)} USDC
                  </p>
                </div>
                <div className="glass-card p-3 text-center">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('common.labels.sellerGets')}
                  </p>
                  <p className="text-sm font-bold text-emerald-400 font-display">
                    ${formatUSDC(result.transaction.sellerReceived, locale)}
                  </p>
                </div>
                <div className="glass-card p-3 text-center">
                  <p className="text-xs text-muted-2 font-body mb-1">
                    {t('common.labels.platform')}
                  </p>
                  <p className="text-sm font-bold text-foreground-muted font-display">
                    ${formatUSDC(result.transaction.platformFee, locale)}
                  </p>
                </div>
              </div>

              <pre className="text-xs text-red-400 mb-3">{JSON.stringify(result, null, 2)}</pre>
              {/* AI Summary */}
              <div className="mb-5 p-4 rounded-xl bg-gradient-to-br from-gold/5 to-transparent border border-gold/15">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-gold" />
                  <p className="text-sm font-body font-semibold text-gold">
                    {t('queryModal.result.aiAnalysis')}
                  </p>
                </div>
                {result.ai?.summary ? (
                  <>
                    <p className="text-sm text-foreground font-body leading-relaxed">
                      {result.ai.summary}
                    </p>
                    {result.ai.answer && (
                      <div className="mt-3 pt-3 border-t border-gold/10">
                        <p className="text-xs font-body font-semibold text-gold mb-1">
                          {t('common.labels.answerToQuestion')}
                        </p>
                        <p className="text-sm text-foreground font-body leading-relaxed">
                          {result.ai.answer}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-foreground-muted font-body leading-relaxed">
                    The payment was verified, but delivery is still being retried. You can keep this
                    window open or come back later to see the delivered data.
                  </p>
                )}
              </div>

              {/* Raw data preview */}
              {result.data && (
                <div className="mb-5">
                  <p className="text-xs font-body font-semibold text-foreground-muted mb-2">
                    {t('common.labels.rawDataPreview')}
                  </p>
                  <div className="bg-void rounded-xl p-4 max-h-48 overflow-auto border border-border/40">
                    <pre className="text-xs font-mono text-foreground-muted leading-relaxed whitespace-pre-wrap">
                      {JSON.stringify(result.data, null, 2).slice(0, 1200)}
                      {JSON.stringify(result.data, null, 2).length > 1200 ? '\n...' : ''}
                    </pre>
                  </div>
                </div>
              )}

              {/* Ratings */}
              {result.transaction.deliveryStatus === 'delivered' && !result.demo && (
                <div className="mb-5 p-4 rounded-xl border border-border/40 bg-surface-2/30">
                  <p className="text-xs font-body font-semibold text-foreground-muted mb-3">
                    Rate this dataset
                  </p>
                  {ratingSubmitted ? (
                    <div className="flex items-center gap-2 text-emerald-400 text-sm font-body bg-emerald-500/10 p-3 rounded-lg border border-emerald-500/20">
                      <Check className="w-4 h-4" />
                      Thank you for your rating!
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex gap-1">
                        {[1, 2, 3, 4, 5].map(star => (
                          <button
                            key={star}
                            onClick={() => setRatingScore(star)}
                            className={clsx(
                              'p-1 transition-colors hover:text-gold',
                              ratingScore >= star ? 'text-gold' : 'text-muted/40',
                            )}
                          >
                            <Star
                              className="w-6 h-6"
                              fill={ratingScore >= star ? 'currentColor' : 'none'}
                            />
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={ratingComment}
                        onChange={e => setRatingComment(e.target.value)}
                        placeholder="Leave an optional comment (max 500 chars)"
                        maxLength={500}
                        className="w-full bg-void/60 border border-border/60 rounded-xl p-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors resize-none h-16"
                      />
                      <button
                        onClick={handleRatingSubmit}
                        disabled={!ratingScore || isSubmittingRating}
                        className={clsx(
                          'w-full py-2.5 rounded-lg text-sm font-body font-semibold transition-all',
                          ratingScore && !isSubmittingRating
                            ? 'bg-gold/20 text-gold hover:bg-gold/30'
                            : 'bg-surface-2 text-muted cursor-not-allowed',
                        )}
                      >
                        {isSubmittingRating ? (
                          <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                        ) : (
                          'Submit Rating'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    if (!result.data) return;
                    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
                      type: 'application/json',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');

                    try {
                      a.href = url;
                      a.download = `hazina-${dataset.id}.json`;
                      document.body.appendChild(a);
                      a.click();
                    } finally {
                      a.remove();
                      // Let the download start before revoking the Object URL.
                      setTimeout(() => URL.revokeObjectURL(url), 0);
                    }
                  }}
                  className="btn-ghost flex-1 py-3 text-sm"
                >
                  {t('common.actions.downloadJson')}
                </button>
                <button onClick={onClose} className="btn-gold flex-1 py-3 text-sm">
                  {t('common.actions.done')}
                </button>
              </div>
            </div>
          )}

          {/* ── ERROR ── */}
          {step === 'error' && (
            <div className="text-center py-8">
              <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-7 h-7 text-red-400" />
              </div>
              <h3 className="font-display font-semibold text-xl text-foreground mb-2">
                {t('queryModal.error.title')}
              </h3>
              <p className="text-sm text-red-400 font-body mb-6 bg-red-500/5 border border-red-500/20 rounded-xl p-3">
                {error}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setStep('payment')}
                  className="btn-ghost flex-1 py-3 text-sm"
                >
                  {t('common.actions.tryAgain')}
                </button>
                <button
                  onClick={onClose}
                  className="btn-ghost flex-1 py-3 text-sm border-border text-foreground-muted"
                >
                  {t('common.actions.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
