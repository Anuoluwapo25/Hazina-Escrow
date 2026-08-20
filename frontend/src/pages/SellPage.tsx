import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Upload,
  CheckCircle,
  AlertCircle,
  Loader2,
  Database,
  DollarSign,
  FileJson,
  User,
  Mail,
  Zap,
  Info,
  ExternalLink,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatUSDC, getTypeMeta, DATA_TYPE_META } from '../lib/utils';
import clsx from 'clsx';
import { getCatalog, useI18n } from '../i18n';
import { useToastContext } from '../components/ui/useToastContext';
import { Toast, ToastProps } from '../components/ui/Toast';

const PRICE_PRESETS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5];

type Tab = 'form' | 'preview';

interface FormState {
  name: string;
  description: string;
  type: string;
  pricePerQuery: string;
  priceCurrency: 'USDC' | 'USD';
  paymentToken: 'USDC' | 'EURC' | 'XLM';
  sellerWallet: string;
  notificationEmail: string;
  dataText: string;
}

const INITIAL: FormState = {
  name: '',
  description: '',
  type: 'whale-wallets',
  pricePerQuery: '0.05',
  priceCurrency: 'USDC',
  paymentToken: 'USDC',
  sellerWallet: '',
  notificationEmail: '',
  dataText: '',
};

const STORAGE_KEY = 'hazina_sell_form_draft';
const DRAFT_EXPIRY_HOURS = 24;

interface StoredDraft {
  data: Omit<FormState, 'sellerWallet' | 'notificationEmail'>;
  timestamp: number;
}

function loadDraft(): {
  form: FormState;
  wasRestored: boolean;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { form: INITIAL, wasRestored: false };

    const stored: StoredDraft = JSON.parse(raw);
    const ageHours = (Date.now() - stored.timestamp) / (1000 * 60 * 60);

    if (ageHours > DRAFT_EXPIRY_HOURS) {
      localStorage.removeItem(STORAGE_KEY);
      return { form: INITIAL, wasRestored: false };
    }

    const restoredForm: FormState = {
      ...INITIAL,
      ...stored.data,
      sellerWallet: '',
      notificationEmail: '',
    };

    return { form: restoredForm, wasRestored: true };
  } catch {
    return { form: INITIAL, wasRestored: false };
  }
}

function saveDraft(form: FormState): void {
  try {
    const toStore: StoredDraft = {
      data: {
        name: form.name,
        description: form.description,
        type: form.type,
        pricePerQuery: form.pricePerQuery,
        priceCurrency: form.priceCurrency,
        paymentToken: form.paymentToken,
        dataText: form.dataText,
      },
      timestamp: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch {
    // ignore
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export default function SellPage() {
  const { locale, t } = useI18n();
  const catalog = getCatalog(locale);
  const navigate = useNavigate();
  const { success: toastSuccess, error: toastError } = useToastContext();
  const [form, setForm] = useState<FormState>(() => loadDraft().form);
  const [tab, setTab] = useState<Tab>('form');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [jsonError, setJsonError] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);
  const [walletTouched, setWalletTouched] = useState(false);
  const [toast, setToast] = useState<ToastProps | null>(null);

  const hasShownRestoreToastRef = useRef(false);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const isFirstRenderRef = useRef(true);

  const needsConversion = form.priceCurrency === 'USD' && form.paymentToken !== 'USDC';
  const priceUsdNum = parseFloat(form.pricePerQuery);
  const priceValid = !isNaN(priceUsdNum) && priceUsdNum > 0;

  const { data: convertData, isFetching: convertFetching } = useQuery({
    queryKey: ['oracle-convert', form.priceCurrency, form.pricePerQuery, form.paymentToken],
    queryFn: () =>
      api.oracleConvert({
        priceUsd: priceUsdNum,
        paymentAsset: form.paymentToken,
      }),
    enabled: needsConversion && priceValid,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!hasShownRestoreToastRef.current) {
      hasShownRestoreToastRef.current = true;
      const { wasRestored } = loadDraft();
      if (wasRestored) {
        setToast({
          message: t('sell.messages.draftRestored'),
          type: 'success',
          duration: 3000,
        });
      }
    }
  }, [t]);

  // Persist form draft across page reloads. Skip the mount-time run so an
  // untouched (or freshly-expired) form doesn't immediately write a draft.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    saveDraft(form);
  }, [form]);

  const set =
    (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [key]: e.target.value }));

  const typeMeta = getTypeMeta(form.type);
  const typeLabel = typeMeta.labelKey ? t(typeMeta.labelKey) : typeMeta.label;
  const dataTypes = Object.entries(DATA_TYPE_META).map(([value, meta]) => ({
    value,
    label: meta.labelKey ? t(meta.labelKey) : meta.label,
    color: meta.color,
    bg: meta.bg,
  }));

  const validateJson = (text: string): boolean => {
    if (!text.trim()) return true;
    try {
      JSON.parse(text);
      setJsonError('');
      return true;
    } catch {
      setJsonError(t('sell.messages.invalidJson'));
      return false;
    }
  };

  const handleDataChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setForm(f => ({ ...f, dataText: e.target.value }));
    validateJson(e.target.value);
  };

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm(f => ({ ...f, pricePerQuery: value }));
    setPriceTouched(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      setForm(f => ({ ...f, dataText: text }));
      validateJson(text);
    };
    reader.readAsText(file);
  };

  const isValidStellarAddress = (addr: string): boolean => {
    const trimmed = addr.trim();
    return trimmed.length === 56 && trimmed.startsWith('G') && /^[A-Z2-7]{56}$/.test(trimmed);
  };

  const isPriceInvalid = priceTouched && parseFloat(form.pricePerQuery) <= 0;

  const isWalletInvalid = walletTouched && !isValidStellarAddress(form.sellerWallet);
  const isNotificationEmailInvalid =
    form.notificationEmail.trim().length > 0 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.notificationEmail.trim());

  const isValid =
    form.name.trim() &&
    form.description.trim() &&
    form.type &&
    parseFloat(form.pricePerQuery) > 0 &&
    !isPriceInvalid &&
    isValidStellarAddress(form.sellerWallet) &&
    !isNotificationEmailInvalid &&
    form.dataText.trim() &&
    !jsonError;

  const handleSubmitConfirmed = async () => {
    setShowConfirm(false);
    if (!isValid || !validateJson(form.dataText)) return;
    setSubmitting(true);
    setError('');
    try {
      await api.createDataset({
        name: form.name.trim(),
        description: form.description.trim(),
        type: form.type,
        pricePerQuery: parseFloat(form.pricePerQuery),
        priceCurrency: form.priceCurrency,
        paymentToken: form.paymentToken,
        sellerWallet: form.sellerWallet.trim(),
        ...(form.notificationEmail.trim()
          ? { notificationEmail: form.notificationEmail.trim() }
          : {}),
        data: JSON.parse(form.dataText),
      });
      clearDraft();
      setSuccess(true);
      toastSuccess(t('sell.messages.listingLive'), form.name.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('sell.messages.createFailed');
      setError(msg);
      toastError(t('sell.messages.createFailed'), msg);
    } finally {
      setSubmitting(false);
    }
  };

  const listedPriceLabel = `${formatUSDC(Number(form.pricePerQuery), locale)} ${form.priceCurrency}`;
  const settleLabel = convertData
    ? `≈ ${formatUSDC(convertData.amountOut, locale)} ${form.paymentToken}`
    : needsConversion
      ? ''
      : listedPriceLabel;

  if (success) {
    return (
      <div className="min-h-screen pt-28 pb-20 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-20 h-20 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-6 animate-pulse-gold">
            <CheckCircle className="w-10 h-10 text-emerald-400" />
          </div>
          <h2 className="font-display text-3xl font-bold text-foreground mb-3">
            {t('sell.messages.listingLive')}
          </h2>
          <p className="text-foreground-muted font-body mb-2">
            {t('sell.messages.listingLiveBody', { name: form.name })}
          </p>
          <p className="text-sm text-foreground-muted font-body mb-8">
            Listed at {listedPriceLabel}
            {settleLabel && form.priceCurrency !== form.paymentToken ? (
              <> · settles {settleLabel}</>
            ) : null}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => {
                clearDraft();
                setForm(INITIAL);
                setSuccess(false);
              }}
              className="btn-ghost px-6 py-3 text-sm"
            >
              {t('common.actions.listAnother')}
            </button>
            <button onClick={() => navigate('/marketplace')} className="btn-gold px-6 py-3 text-sm">
              {t('common.actions.viewMarketplace')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-28 pb-20">
      <div className="max-w-4xl mx-auto px-4">
        {/* Header */}
        <div className="mb-10">
          <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
            {t('sell.eyebrow')}
          </p>
          <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-3">
            {t('sell.title')}
          </h1>
          <p className="text-foreground-muted font-body text-lg">{t('sell.subtitle')}</p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 glass-card inline-flex mb-8 rounded-xl">
          {(['form', 'preview'] as Tab[]).map(tabKey => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={clsx(
                'px-5 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200 capitalize',
                tab === tabKey
                  ? 'bg-gold text-void shadow-sm'
                  : 'text-foreground-muted hover:text-foreground',
              )}
            >
              {tabKey === 'form' ? t('sell.tabs.form') : t('sell.tabs.preview')}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main form */}
          <div className="lg:col-span-2">
            {tab === 'form' ? (
              <div className="glass-card-gold p-6 space-y-6">
                {/* Dataset name */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Database className="w-4 h-4 text-gold" />
                    {t('sell.form.datasetName')} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={set('name')}
                    placeholder={t('sell.form.datasetNamePlaceholder')}
                    className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/50 transition-colors"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <FileJson className="w-4 h-4 text-gold" />
                    {t('sell.form.description')} <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={form.description}
                    onChange={set('description')}
                    placeholder={t('sell.form.descriptionPlaceholder')}
                    className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/50 transition-colors resize-none h-24"
                  />
                </div>

                {/* Type row */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-gold" />
                    {t('sell.form.dataType')} <span className="text-red-400">*</span>
                  </label>
                  <select
                    value={form.type}
                    onChange={set('type')}
                    className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none focus:border-gold/50 transition-colors"
                  >
                    {dataTypes.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Price row */}
                <div className="grid grid-cols-[1fr_110px_140px] gap-3 items-end">
                  <div>
                    <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-gold" />
                      {t('sell.form.pricePerQuery')} <span className="text-red-400">*</span>
                    </label>
                    <div className="flex">
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={form.pricePerQuery}
                        onChange={handlePriceChange}
                        onBlur={() => setPriceTouched(true)}
                        className={clsx(
                          'flex-1 bg-void/60 border rounded-l-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none transition-colors',
                          isPriceInvalid
                            ? 'border-red-500/50 focus:border-red-500/70'
                            : 'border-border/60 focus:border-gold/50',
                        )}
                      />
                      <select
                        value={form.priceCurrency}
                        onChange={e =>
                          setForm(f => ({ ...f, priceCurrency: e.target.value as 'USDC' | 'USD' }))
                        }
                        className={clsx(
                          'bg-void/60 border-y border-r rounded-r-xl px-3 py-3 text-sm font-body text-foreground focus:outline-none transition-colors',
                          isPriceInvalid
                            ? 'border-red-500/50 focus:border-red-500/70'
                            : 'border-border/60 focus:border-gold/50',
                        )}
                      >
                        <option value="USDC">USDC</option>
                        <option value="USD">USD</option>
                      </select>
                    </div>
                    {isPriceInvalid && (
                      <p className="text-xs text-red-400 mt-1 font-body">
                        {t('sell.form.pricePerQueryError')}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-gold" />
                      {t('sell.form.paymentToken')} <span className="text-red-400">*</span>
                    </label>
                    <select
                      value={form.paymentToken}
                      onChange={set('paymentToken')}
                      className="w-full bg-void/60 border border-border/60 rounded-xl px-3 py-3 text-sm font-body text-foreground focus:outline-none focus:border-gold/50 transition-colors"
                    >
                      <option value="USDC">USDC</option>
                      <option value="EURC">EURC</option>
                      <option value="XLM">XLM</option>
                    </select>
                  </div>
                </div>

                {/* Live conversion preview */}
                {needsConversion && priceValid && (
                  <div className="rounded-xl border border-border-gold/30 bg-gold/5 p-3">
                    {convertFetching && !convertData ? (
                      <div className="flex items-center gap-2 text-sm text-muted-2 font-body">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Fetching oracle rate…
                      </div>
                    ) : convertData ? (
                      <div className="space-y-1 text-sm font-body">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-2">Settlement amount</span>
                          <span className="text-foreground font-semibold">
                            ≈ {formatUSDC(convertData.amountOut, locale)} {form.paymentToken}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-2">
                          <span>
                            1 {convertData.price.base} ≈{' '}
                            {formatUSDC(convertData.price.value, locale)} {convertData.price.quote}
                          </span>
                          <span>·</span>
                          <span>Reflector, {convertData.price.ageSeconds}s old</span>
                          <a
                            href={`https://stellar.expert/explorer/testnet/contract/${convertData.price.sourceContract}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-gold hover:text-gold/80"
                          >
                            contract <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-red-400 font-body">
                        <AlertCircle className="w-3.5 h-3.5" />
                        Oracle unavailable — rate cannot be confirmed
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <p className="text-xs text-muted-2 font-body mb-2">
                    {t('sell.form.quickPricePresets')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {PRICE_PRESETS.map(p => (
                      <button
                        key={p}
                        onClick={() => setForm(f => ({ ...f, pricePerQuery: String(p) }))}
                        className={clsx(
                          'px-3 py-1.5 rounded-lg text-xs font-body font-medium border transition-all duration-150',
                          parseFloat(form.pricePerQuery) === p
                            ? 'bg-gold text-void border-gold'
                            : 'border-border/60 text-foreground-muted hover:border-gold/40 hover:text-gold',
                        )}
                      >
                        ${p} {form.priceCurrency}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Stellar wallet */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <User className="w-4 h-4 text-gold" />
                    {t('sell.form.sellerWallet')} <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.sellerWallet}
                    onChange={set('sellerWallet')}
                    onBlur={() => setWalletTouched(true)}
                    placeholder={t('sell.form.sellerWalletPlaceholder')}
                    className={clsx(
                      'w-full bg-void/60 border rounded-xl px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none transition-colors',
                      isWalletInvalid
                        ? 'border-red-500/50 focus:border-red-500/70'
                        : 'border-border/60 focus:border-gold/50',
                    )}
                  />
                  {isWalletInvalid && (
                    <p className="text-xs text-red-400 mt-1 font-body">
                      {t('sell.form.sellerWalletError')}
                    </p>
                  )}
                  <p className="text-xs text-muted-2 font-body mt-1.5 flex items-start gap-1">
                    <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {t('sell.form.sellerWalletHelp')}
                  </p>
                </div>

                {/* Optional seller notifications */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Mail className="w-4 h-4 text-gold" />
                    {t('sell.form.notificationEmail')}{' '}
                    <span className="text-muted-2">{t('common.labels.optional')}</span>
                  </label>
                  <input
                    type="email"
                    value={form.notificationEmail}
                    onChange={set('notificationEmail')}
                    placeholder={t('sell.form.notificationEmailPlaceholder')}
                    className={clsx(
                      'w-full bg-void/60 border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted focus:outline-none transition-colors',
                      isNotificationEmailInvalid
                        ? 'border-red-500/50 focus:border-red-500/70'
                        : 'border-border/60 focus:border-gold/50',
                    )}
                  />
                  {isNotificationEmailInvalid && (
                    <p className="text-xs text-red-400 mt-1 font-body">
                      {t('sell.form.notificationEmailError')}
                    </p>
                  )}
                  <p className="text-xs text-muted-2 font-body mt-1.5 flex items-start gap-1">
                    <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {t('sell.form.notificationEmailHelp')}
                  </p>
                </div>

                {/* Data upload */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Upload className="w-4 h-4 text-gold" />
                    {t('sell.form.datasetJson')} <span className="text-red-400">*</span>
                  </label>

                  {/* File upload */}
                  <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-dashed border-border-gold/30 hover:border-border-gold/60 bg-gold/5 hover:bg-gold/8 transition-all duration-200 mb-3 group">
                    <Upload className="w-5 h-5 text-gold group-hover:scale-110 transition-transform" />
                    <div>
                      <p className="text-sm font-body font-medium text-foreground">
                        {t('sell.form.uploadFileTitle')}
                      </p>
                      <p className="text-xs text-muted-2 font-body">
                        {t('sell.form.uploadFileSubtitle')}
                      </p>
                    </div>
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>

                  <textarea
                    value={form.dataText}
                    onChange={handleDataChange}
                    placeholder={t('sell.form.dataPlaceholder')}
                    className={clsx(
                      'w-full bg-void/60 border rounded-xl px-4 py-3 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none transition-colors resize-none h-48',
                      jsonError
                        ? 'border-red-500/50 focus:border-red-500/70'
                        : 'border-border/60 focus:border-gold/50',
                    )}
                  />
                  {jsonError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                      <p className="text-xs text-red-400 font-body">{jsonError}</p>
                    </div>
                  )}
                  {form.dataText && !jsonError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                      <p className="text-xs text-emerald-400 font-body">
                        {t('common.states.validJson')}
                      </p>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <p className="text-sm text-red-400 font-body">{error}</p>
                  </div>
                )}

                <button
                  onClick={() => setShowConfirm(true)}
                  disabled={!isValid || submitting}
                  className={clsx(
                    'btn-gold w-full flex items-center justify-center gap-2 py-4 text-base',
                    (!isValid || submitting) && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {t('sell.messages.publishing')}
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5" />
                      {t('sell.form.submit')}
                    </>
                  )}
                </button>

                {/* Confirmation dialog */}
                {showConfirm && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                      className="absolute inset-0 bg-void/80 backdrop-blur-sm"
                      onClick={() => setShowConfirm(false)}
                      aria-hidden="true"
                    />
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="confirm-title"
                      className="relative w-full max-w-sm glass-card-gold p-6 rounded-2xl"
                    >
                      <h3
                        id="confirm-title"
                        className="font-display font-bold text-lg text-foreground mb-2"
                      >
                        Publish dataset?
                      </h3>
                      <p className="text-sm text-foreground-muted font-body mb-3">
                        You are about to list{' '}
                        <span className="text-foreground font-medium">{form.name}</span> at{' '}
                        <span className="text-gold font-semibold">{listedPriceLabel}</span> per
                        query.
                      </p>
                      {needsConversion && convertData && (
                        <p className="text-xs text-muted-2 font-body mb-6 flex items-center gap-2">
                          Settles ≈ {formatUSDC(convertData.amountOut, locale)} {form.paymentToken}{' '}
                          · Reflector, {convertData.price.ageSeconds}s old
                        </p>
                      )}
                      {needsConversion && !convertData && !convertFetching && (
                        <p className="text-xs text-red-400 font-body mb-6 flex items-center gap-2">
                          <AlertCircle className="w-3 h-3" />
                          Oracle unavailable — publishing may fail
                        </p>
                      )}
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowConfirm(false)}
                          className="btn-ghost flex-1 py-2.5 text-sm"
                        >
                          Cancel
                        </button>
                        <button
                          ref={confirmBtnRef}
                          onClick={handleSubmitConfirmed}
                          className="btn-gold flex-1 py-2.5 text-sm"
                        >
                          Publish
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Preview tab */
              <div>
                <p className="text-sm text-foreground-muted font-body mb-4">
                  {t('sell.preview.intro')}
                </p>
                <div className="glass-card-gold p-6">
                  <div className="flex justify-between items-start mb-4">
                    <span className={clsx('type-badge', typeMeta.color, typeMeta.bg)}>
                      <Zap className="w-3 h-3" />
                      {typeLabel}
                    </span>
                    <div className="text-right">
                      <p className="text-xs text-muted-2 mb-0.5">{t('common.units.perQuery')}</p>
                      <p className="font-display font-bold text-xl text-gold">{listedPriceLabel}</p>
                      {needsConversion && convertData && (
                        <p className="text-xs text-muted-2 mt-1">
                          ≈ {formatUSDC(convertData.amountOut, locale)} {form.paymentToken}
                        </p>
                      )}
                    </div>
                  </div>
                  <h3 className="font-display font-semibold text-foreground text-lg mb-2">
                    {form.name || t('sell.preview.datasetNameFallback')}
                  </h3>
                  <p className="text-sm text-foreground-muted font-body leading-relaxed mb-5">
                    {form.description || t('sell.preview.descriptionFallback')}
                  </p>
                  <div className="flex items-center gap-4 mb-5 text-xs text-foreground-muted font-body">
                    <span>0 {t('common.units.queriesServed')}</span>
                    <span className="w-px h-3 bg-border" />
                    <span className="font-mono">
                      {form.sellerWallet
                        ? `${form.sellerWallet.slice(0, 6)}...${form.sellerWallet.slice(-6)}`
                        : t('sell.preview.walletFallback')}
                    </span>
                  </div>
                  {needsConversion && convertData && (
                    <div className="mb-3 text-xs text-muted-2 font-body flex items-center justify-between">
                      <span>Rate via Reflector · {convertData.price.ageSeconds}s old</span>
                      <a
                        href={`https://stellar.expert/explorer/testnet/contract/${convertData.price.sourceContract}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-gold hover:text-gold/80"
                      >
                        contract <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                  <div className="w-full py-3 rounded-xl border border-border-gold/30 text-gold text-sm font-body font-semibold text-center">
                    {settleLabel || listedPriceLabel}
                    {settleLabel && needsConversion ? ` per query` : ''}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Earnings calculator */}
            <div className="glass-card p-5">
              <h3 className="font-display font-semibold text-foreground text-base mb-4">
                {t('sell.earnings.title')}
              </h3>
              {[
                { queries: 10, label: t('sell.earnings.tenQueries') },
                { queries: 100, label: t('sell.earnings.hundredQueries') },
                { queries: 1000, label: t('sell.earnings.thousandQueries') },
              ].map(({ queries, label }) => {
                const price = parseFloat(form.pricePerQuery) || 0;
                const earned = price * queries * 0.95;
                return (
                  <div
                    key={queries}
                    className="flex justify-between items-center py-2 border-b border-border/30 last:border-0"
                  >
                    <span className="text-sm text-foreground-muted font-body">{label}</span>
                    <span className="font-body font-semibold text-gold text-sm">
                      ${formatUSDC(earned, locale)}
                    </span>
                  </div>
                );
              })}
              <p className="text-xs text-muted-2 font-body mt-3">{t('sell.earnings.footnote')}</p>
            </div>

            {/* Tips */}
            <div className="glass-card p-5">
              <h3 className="font-display font-semibold text-foreground text-base mb-3">
                {t('sell.tips.title')}
              </h3>
              <ul className="space-y-2">
                {catalog.sell.tips.items.map((tip, i) => (
                  <li key={i} className="text-xs text-foreground-muted font-body flex gap-2">
                    <span className="text-gold flex-shrink-0">✦</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>

            {/* How it works */}
            <div className="glass-card p-5 bg-gold/5 border-border-gold/20">
              <h3 className="font-display font-semibold text-gold text-sm mb-3">
                {t('sell.howItWorks.title')}
              </h3>
              <div className="space-y-2 text-xs text-foreground-muted font-body">
                {catalog.sell.howItWorks.items.map((item, index) => (
                  <p key={item}>
                    {index + 1}. {item}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Toast notification */}
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
}
