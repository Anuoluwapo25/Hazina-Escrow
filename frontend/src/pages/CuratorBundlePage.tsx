import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import { Layers, Search, X, Plus, CheckCircle, AlertCircle, Loader2, User } from 'lucide-react';
import clsx from 'clsx';
import { api, type DatasetMeta } from '../lib/api';
import { formatUSDC, truncateAddress } from '../lib/utils';
import { evenSplit, redistributeSplit, type SplitEntry } from '../lib/splitSliders';
import { useI18n } from '../i18n';

const CURATOR_ID = '__curator__';

function isValidStellarAddress(addr: string): boolean {
  const trimmed = addr.trim();
  return trimmed.length === 56 && trimmed.startsWith('G') && /^[A-Z2-7]{56}$/.test(trimmed);
}

export default function CuratorBundlePage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [curatorWallet, setCuratorWallet] = useState('');
  const [walletTouched, setWalletTouched] = useState(false);
  const [totalPrice, setTotalPrice] = useState('0.12');
  const [priceTouched, setPriceTouched] = useState(false);
  const [entries, setEntries] = useState<SplitEntry[]>(() => evenSplit([CURATOR_ID]));
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [publishedName, setPublishedName] = useState<string | null>(null);

  const { data: catalog } = useQuery<DatasetMeta[]>({
    queryKey: ['curator-dataset-catalog'],
    queryFn: () => api.getDatasets({ limit: 100 }).then(r => r.data),
  });

  const datasetById = useMemo(() => new Map((catalog ?? []).map(d => [d.id, d])), [catalog]);

  const selectedDatasetIds = useMemo(
    () => entries.filter(e => e.id !== CURATOR_ID).map(e => e.id),
    [entries],
  );

  const availableDatasets = useMemo(() => {
    const selected = new Set(selectedDatasetIds);
    const q = search.trim().toLowerCase();
    return (catalog ?? []).filter(
      d => !selected.has(d.id) && (q === '' || d.name.toLowerCase().includes(q)),
    );
  }, [catalog, selectedDatasetIds, search]);

  // entries always includes a CURATOR_ID entry — every state transition (add/remove
  // dataset, slider drag) preserves it. The fallback only guards render if that
  // invariant is ever violated; it never throws mid-render.
  const curatorEntry = entries.find(e => e.id === CURATOR_ID) ?? { id: CURATOR_ID, bps: 0 };
  const datasetEntries = entries.filter(e => e.id !== CURATOR_ID);
  const totalBps = entries.reduce((sum, e) => sum + e.bps, 0);
  const price = parseFloat(totalPrice) || 0;
  const isPriceInvalid = priceTouched && price <= 0;
  const isWalletInvalid = walletTouched && !isValidStellarAddress(curatorWallet);

  const isValid =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    isValidStellarAddress(curatorWallet) &&
    price > 0 &&
    datasetEntries.length > 0 &&
    totalBps === 10_000;

  function addDataset(id: string) {
    const nextIds = [...selectedDatasetIds, id, CURATOR_ID];
    setEntries(evenSplit(nextIds));
  }

  function removeDataset(id: string) {
    const nextIds = [...selectedDatasetIds.filter(existing => existing !== id), CURATOR_ID];
    setEntries(evenSplit(nextIds));
  }

  function onSliderChange(id: string, value: number) {
    setEntries(prev => redistributeSplit(prev, id, value));
  }

  async function handleSubmit() {
    setWalletTouched(true);
    setPriceTouched(true);
    if (!isValid) return;

    setSubmitting(true);
    setError('');
    try {
      const bundle = await api.createBundle({
        name: name.trim(),
        description: description.trim(),
        curatorWallet: curatorWallet.trim(),
        totalPrice: price,
        curatorFeeBps: curatorEntry.bps,
        components: datasetEntries.map(entry => ({ datasetId: entry.id, shareBps: entry.bps })),
      });
      setPublishedName(bundle.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('bundles.curator.error'));
    } finally {
      setSubmitting(false);
    }
  }

  function pctLabel(bps: number): string {
    const pct = bps / 100;
    return `${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%`;
  }

  if (publishedName) {
    return (
      <div className="min-h-screen pt-28 pb-20 flex items-center justify-center px-4">
        <div className="glass-card-gold max-w-md w-full p-8 text-center">
          <CheckCircle className="w-14 h-14 text-emerald-400 mx-auto mb-4" />
          <h1 className="font-display text-2xl font-bold text-foreground mb-2">
            {t('bundles.curator.success')}
          </h1>
          <p className="text-foreground-muted font-body mb-6">
            {t('bundles.curator.successBody', { name: publishedName })}
          </p>
          <button onClick={() => navigate('/marketplace')} className="btn-gold w-full py-3 text-sm">
            {t('common.actions.viewMarketplace')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-28 pb-20">
      <Helmet>
        <title>Curate a Bundle | Hazina</title>
      </Helmet>

      <div className="max-w-5xl mx-auto px-4">
        <div className="mb-10">
          <p className="text-violet-300 text-sm font-body font-medium tracking-widest uppercase mb-2">
            {t('bundles.curator.eyebrow')}
          </p>
          <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-3 flex items-center gap-3">
            <Layers className="w-9 h-9 text-violet-400" />
            {t('bundles.curator.title')}
          </h1>
          <p className="text-foreground-muted font-body text-lg max-w-2xl">
            {t('bundles.curator.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            {/* Bundle details */}
            <div className="glass-card p-6 space-y-4">
              <div>
                <label className="block text-sm font-body font-medium text-foreground mb-2">
                  {t('bundles.curator.nameLabel')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('bundles.curator.namePlaceholder')}
                  className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-violet-400/40 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-body font-medium text-foreground mb-2">
                  {t('bundles.curator.descriptionLabel')}
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('bundles.curator.descriptionPlaceholder')}
                  rows={3}
                  className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-violet-400/40 transition-colors resize-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-body font-medium text-foreground mb-2">
                    {t('bundles.curator.curatorWalletLabel')}
                  </label>
                  <input
                    type="text"
                    value={curatorWallet}
                    onChange={e => setCuratorWallet(e.target.value)}
                    onBlur={() => setWalletTouched(true)}
                    placeholder={t('bundles.curator.curatorWalletPlaceholder')}
                    className={clsx(
                      'w-full bg-void/60 border rounded-xl px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none transition-colors',
                      isWalletInvalid
                        ? 'border-red-500/60 focus:border-red-500'
                        : 'border-border/60 focus:border-violet-400/40',
                    )}
                  />
                  {isWalletInvalid && (
                    <p className="text-xs text-red-400 font-body mt-1.5">
                      {t('bundles.curator.curatorWalletError')}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-body font-medium text-foreground mb-2">
                    {t('bundles.curator.priceLabel')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={totalPrice}
                    onChange={e => {
                      setTotalPrice(e.target.value);
                      setPriceTouched(true);
                    }}
                    onBlur={() => setPriceTouched(true)}
                    className={clsx(
                      'w-full bg-void/60 border rounded-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none transition-colors',
                      isPriceInvalid
                        ? 'border-red-500/60 focus:border-red-500'
                        : 'border-border/60 focus:border-violet-400/40',
                    )}
                  />
                  {isPriceInvalid && (
                    <p className="text-xs text-red-400 font-body mt-1.5">
                      {t('bundles.curator.priceError')}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Dataset picker */}
            <div className="glass-card p-6">
              <h3 className="font-display font-semibold text-foreground text-base mb-3">
                {t('bundles.curator.pickerTitle')}
              </h3>
              <div className="relative mb-3">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('bundles.curator.pickerSearchPlaceholder')}
                  className="w-full bg-void/60 border border-border/60 rounded-xl pl-10 pr-4 py-2.5 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-violet-400/40 transition-colors"
                />
              </div>
              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {availableDatasets.length === 0 ? (
                  <p className="text-sm text-muted-2 font-body text-center py-6">
                    {t('bundles.curator.pickerEmpty')}
                  </p>
                ) : (
                  availableDatasets.map(dataset => (
                    <button
                      key={dataset.id}
                      type="button"
                      onClick={() => addDataset(dataset.id)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-void/40 border border-border/20 hover:border-violet-400/40 transition-colors text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-body text-foreground truncate">{dataset.name}</p>
                        <p className="text-xs text-muted-2 font-mono">
                          ${formatUSDC(dataset.pricePerQuery, locale)} ·{' '}
                          {truncateAddress(dataset.sellerWallet)}
                        </p>
                      </div>
                      <Plus className="w-4 h-4 text-violet-300 flex-shrink-0" />
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Component sliders */}
            <div className="glass-card p-6">
              <h3 className="font-display font-semibold text-foreground text-base mb-1">
                {t('bundles.curator.componentsTitle')}
              </h3>
              <p
                className={clsx(
                  'text-xs font-body mb-4',
                  totalBps === 10_000 ? 'text-emerald-400' : 'text-amber-400',
                )}
              >
                {totalBps === 10_000
                  ? t('bundles.curator.splitTotalOk')
                  : t('bundles.curator.splitTotalError', { total: (totalBps / 100).toFixed(1) })}
              </p>

              {datasetEntries.length === 0 ? (
                <p className="text-sm text-muted-2 font-body py-4">
                  {t('bundles.curator.componentsEmpty')}
                </p>
              ) : (
                <div className="space-y-4 mb-4">
                  {datasetEntries.map(entry => {
                    const dataset = datasetById.get(entry.id);
                    return (
                      <div key={entry.id}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-sm font-body text-foreground truncate mr-2">
                            {dataset?.name ?? entry.id}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-xs font-mono text-violet-300">
                              {pctLabel(entry.bps)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeDataset(entry.id)}
                              aria-label={`${t('bundles.curator.removeComponent')} ${dataset?.name ?? entry.id}`}
                              className="text-muted hover:text-red-400 transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={10_000}
                          step={25}
                          value={entry.bps}
                          onChange={e => onSliderChange(entry.id, Number(e.target.value))}
                          className="w-full accent-violet-400"
                          aria-label={`${t('bundles.curator.shareLabel')}: ${dataset?.name ?? entry.id}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="border-t border-border/20 pt-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-body text-foreground">
                    {t('bundles.curator.curatorFeeLabel')}
                  </span>
                  <span className="text-xs font-mono text-violet-300">
                    {pctLabel(curatorEntry.bps)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={10_000}
                  step={25}
                  value={curatorEntry.bps}
                  onChange={e => onSliderChange(CURATOR_ID, Number(e.target.value))}
                  className="w-full accent-violet-400"
                  aria-label={t('bundles.curator.curatorFeeLabel')}
                />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-sm font-body text-red-300">{error}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={!isValid || submitting}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-body font-semibold text-sm transition-all',
                !isValid || submitting
                  ? 'bg-void/40 text-muted cursor-not-allowed'
                  : 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400',
              )}
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('bundles.curator.submitting')}
                </>
              ) : (
                t('bundles.curator.submit')
              )}
            </button>
          </div>

          {/* Buyer preview sidebar */}
          <div className="space-y-4">
            <div className="glass-card-gold p-6 sticky top-28">
              <h3 className="font-display font-semibold text-foreground text-base mb-4">
                {t('bundles.curator.preview.title')}
              </h3>
              <p className="text-sm font-body text-foreground-muted mb-4">
                {t('bundles.curator.preview.priceLine', { price: formatUSDC(price, locale) })}
              </p>
              <div className="space-y-2.5">
                {datasetEntries.map(entry => {
                  const dataset = datasetById.get(entry.id);
                  const amount = (price * entry.bps) / 10_000;
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between text-xs font-body"
                    >
                      <span className="text-foreground-muted truncate mr-2 flex items-center gap-1.5">
                        <User className="w-3 h-3 text-muted flex-shrink-0" />
                        {t('bundles.curator.preview.sellerGets', {
                          name: dataset?.name ?? entry.id,
                          amount: formatUSDC(amount, locale),
                          pct: (entry.bps / 100).toFixed(1),
                        })}
                      </span>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between text-xs font-body pt-2.5 mt-2.5 border-t border-border-gold/20">
                  <span className="text-gold font-medium">
                    {t('bundles.curator.preview.curatorGets', {
                      amount: formatUSDC((price * curatorEntry.bps) / 10_000, locale),
                      pct: (curatorEntry.bps / 100).toFixed(1),
                    })}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
