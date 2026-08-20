import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import {
  ArrowLeft,
  Calendar,
  Database,
  DollarSign,
  Hash,
  Radio,
  ShoppingCart,
  Star,
  Loader2,
  Info,
} from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import clsx from 'clsx';
import { api, DatasetDetail, DatasetPreview } from '../lib/api';
import { formatTimeAgo, formatUSDC, getTypeMeta, truncateAddress } from '../lib/utils';
import QueryModal from '../components/ui/QueryModal';
import DatasetHistory from '../components/ui/DatasetHistory';
import { Skeleton } from '../components/ui/SkeletonLoader';
import { useI18n } from '../i18n';

function Stars({ value, onSelect }: { value: number; onSelect?: (value: number) => void }) {
  return (
    <div className="flex items-center gap-1" aria-label={`${value.toFixed(1)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(star => (
        <button
          key={star}
          type="button"
          disabled={!onSelect}
          onClick={() => onSelect?.(star)}
          className={clsx(
            'transition-colors',
            star <= Math.round(value) ? 'text-gold' : 'text-muted',
          )}
          aria-label={onSelect ? `Rate ${star} stars` : undefined}
        >
          <Star className="h-5 w-5" fill="currentColor" />
        </button>
      ))}
    </div>
  );
}

export default function DatasetDetailPage() {
  const { datasetId = '' } = useParams();
  const { locale, t } = useI18n();
  const [showQueryModal, setShowQueryModal] = useState(false);
  const {
    data: dataset,
    isLoading,
    error,
  } = useQuery<DatasetDetail>({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.getDataset(datasetId),
    enabled: Boolean(datasetId),
  });

  const {
    data: preview,
    isLoading: previewLoading,
    isError: previewError,
  } = useQuery<DatasetPreview>({
    queryKey: ['dataset-preview', datasetId],
    queryFn: () => api.getDatasetPreview(datasetId),
    enabled: Boolean(datasetId),
    // live feeds refresh server-side; keep the sample reasonably fresh
    refetchInterval: dataset?.live ? 60_000 : false,
  });

  const listedCurrency = dataset?.priceCurrency ?? 'USDC';
  const settleAsset = dataset?.paymentToken ?? 'USDC';
  const needsOracle = !(listedCurrency === 'USDC' && settleAsset === 'USDC');

  const {
    data: quote,
    isFetching: quoteLoading,
    isError: quoteError,
  } = useQuery({
    queryKey: ['oracle-convert', datasetId, dataset?.pricePerQuery, listedCurrency, settleAsset],
    queryFn: () =>
      api.oracleConvert({
        priceUsd: dataset!.pricePerQuery,
        paymentAsset: settleAsset as 'XLM' | 'USDC' | 'EURC' | 'USD',
      }),
    enabled: needsOracle && Boolean(dataset),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const previewJson = useMemo(() => JSON.stringify(dataset?.preview ?? {}, null, 2), [dataset]);
  const typeMeta = dataset ? getTypeMeta(dataset.type) : null;
  const ratings = dataset?.ratings ?? { score: 0, count: 0, reviews: [] };
  const priceHistory = dataset?.priceHistory?.length
    ? dataset.priceHistory
    : dataset
      ? [{ price: dataset.pricePerQuery, changedAt: dataset.createdAt }]
      : [];
  const maxPrice = Math.max(...priceHistory.map(point => point.price), 1);

  if (isLoading) {
    return (
      <div className="min-h-screen pt-28 pb-20 max-w-7xl mx-auto px-4">
        <Skeleton variant="rounded" height={520} />
      </div>
    );
  }

  if (error || !dataset) {
    return (
      <div className="min-h-screen pt-28 pb-20 max-w-3xl mx-auto px-4 text-center">
        <h1 className="font-display text-3xl font-bold text-foreground mb-3">Dataset not found</h1>
        <p className="text-foreground-muted mb-8">
          This dataset may have been removed or is unavailable.
        </p>
        <Link to="/marketplace" className="btn-gold px-6 py-3 inline-flex items-center gap-2">
          <ArrowLeft className="h-4 w-4" /> Back to marketplace
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-28 pb-20">
      <Helmet>
        <title>{dataset.name}</title>
        <meta name="description" content={dataset.description.slice(0, 155)} />
        <meta property="og:title" content={`${dataset.name} dataset`} />
        <meta property="og:description" content={dataset.description.slice(0, 155)} />
      </Helmet>

      <div className="max-w-7xl mx-auto px-4">
        <nav className="mb-8 text-sm font-body text-foreground-muted" aria-label="Breadcrumb">
          <Link to="/marketplace" className="hover:text-gold">
            Marketplace
          </Link>
          <span className="mx-2">→</span>
          <span className="text-foreground">{dataset.name}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_24rem] gap-8">
          <article className="space-y-8">
            <section className="glass-card p-6 md:p-8">
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className={clsx('type-badge inline-flex', typeMeta?.color, typeMeta?.bg)}>
                  {typeMeta?.label ?? dataset.type}
                </span>
                {dataset.live && (
                  <span className="type-badge inline-flex border border-emerald-400/30 bg-emerald-400/10 text-emerald-400">
                    <Radio className="w-3 h-3 animate-pulse" />
                    {t('marketplace.live.badge')}
                    {dataset.lastRefreshedAt && (
                      <span className="ml-1 opacity-80">
                        · {formatTimeAgo(dataset.lastRefreshedAt, locale)}
                      </span>
                    )}
                  </span>
                )}
              </div>
              <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-4">
                {dataset.name}
              </h1>
              <p className="text-lg text-foreground-muted leading-relaxed mb-6">
                {dataset.description}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Metric icon={Database} label="Type" value={dataset.metadata.type} />
                <Metric
                  icon={Hash}
                  label="Sample size"
                  value={dataset.metadata.sampleSize.toLocaleString(locale)}
                />
                <Metric
                  icon={Calendar}
                  label="Last updated"
                  value={new Date(dataset.metadata.lastUpdated).toLocaleDateString(locale)}
                />
                <Metric
                  icon={DollarSign}
                  label={`Per query · ${listedCurrency}`}
                  value={`$${formatUSDC(dataset.pricePerQuery, locale)}`}
                />
              </div>
            </section>

            <section className="glass-card p-6 md:p-8">
              <h2 className="font-display text-2xl font-semibold text-foreground mb-4">
                Schema fields
              </h2>
              <div className="flex flex-wrap gap-2">
                {dataset.metadata.schemaFields.map(field => (
                  <span
                    key={field}
                    className="px-3 py-1.5 rounded-lg bg-void/60 border border-border text-sm text-foreground-muted font-mono"
                  >
                    {field}
                  </span>
                ))}
              </div>
            </section>

            {dataset.live && (
              <section className="glass-card p-6 md:p-8">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-display text-2xl font-semibold text-foreground flex items-center gap-2">
                    <Radio className="w-5 h-5 text-emerald-400 animate-pulse" />
                    {t('marketplace.live.preview')}
                  </h2>
                  {preview?.provider && (
                    <span className="text-xs uppercase tracking-wide font-body text-muted-2">
                      {t('marketplace.live.source', { provider: preview.provider })}
                    </span>
                  )}
                </div>

                {previewLoading ? (
                  <Skeleton variant="rounded" height={180} />
                ) : previewError || !preview ? (
                  <p className="text-sm text-foreground-muted">
                    {t('marketplace.live.previewError')}
                  </p>
                ) : (
                  <>
                    {preview.headline && (
                      <p className="text-lg text-foreground mb-4">{preview.headline}</p>
                    )}
                    {preview.points.length > 1 ? (
                      <div className="h-44 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={preview.points}>
                            <defs>
                              <linearGradient id="liveSpark" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <YAxis hide domain={['dataMin', 'dataMax']} />
                            <Tooltip
                              contentStyle={{
                                background: 'rgba(10,10,12,0.9)',
                                border: '1px solid rgba(52,211,153,0.3)',
                                borderRadius: 12,
                                fontSize: 12,
                              }}
                              labelStyle={{ color: '#9ca3af' }}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke="#34d399"
                              strokeWidth={2}
                              fill="url(#liveSpark)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="text-sm text-foreground-muted">
                        {t('marketplace.live.noPreview')}
                      </p>
                    )}
                  </>
                )}
              </section>
            )}

            <section className="glass-card p-6 md:p-8">
              <h2 className="font-display text-2xl font-semibold text-foreground mb-4">
                Sanitised preview
              </h2>
              <pre className="overflow-x-auto rounded-xl bg-void/80 border border-border p-4 text-sm text-foreground-muted">
                <code>{previewJson}</code>
              </pre>
            </section>

            <DatasetHistory datasetId={datasetId} />

            <section className="glass-card p-6 md:p-8">
              <h2 className="font-display text-2xl font-semibold text-foreground mb-4">
                Pricing history
              </h2>
              <div className="flex items-end gap-3 h-40 border-l border-b border-border/60 p-4">
                {priceHistory.map(point => (
                  <div
                    key={`${point.changedAt}-${point.price}`}
                    className="flex-1 flex flex-col items-center gap-2"
                  >
                    <div
                      className="w-full max-w-16 rounded-t-lg bg-gradient-to-t from-gold/60 to-gold"
                      style={{ height: `${Math.max((point.price / maxPrice) * 100, 8)}%` }}
                    />
                    <span className="text-xs text-muted">${formatUSDC(point.price, locale)}</span>
                  </div>
                ))}
              </div>
            </section>
          </article>

          <aside className="space-y-6 lg:sticky lg:top-28 self-start">
            <div className="glass-card p-6">
              <p className="text-sm text-muted mb-1">Seller</p>
              <p className="font-mono text-foreground mb-5">
                {truncateAddress(dataset.sellerWallet)}
              </p>
              <p className="text-sm text-muted mb-2">Buyer rating</p>
              <div className="flex items-center justify-between gap-3 mb-5">
                <Stars value={ratings.score} />
                <span className="text-sm text-foreground-muted">
                  {ratings.score.toFixed(1)} ({ratings.count})
                </span>
              </div>

              {needsOracle && (
                <div className="mb-5 rounded-lg border border-border/60 bg-void/40 p-3.5 space-y-2">
                  <p className="text-xs uppercase tracking-wider text-muted-2 font-body">
                    Settlement estimate · {settleAsset}
                  </p>
                  {quoteLoading && !quote ? (
                    <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching rate…
                    </p>
                  ) : quoteError || !quote ? (
                    <p className="flex items-start gap-1.5 text-xs text-red-400">
                      <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                      Oracle rate unavailable. Exact price determined at checkout.
                    </p>
                  ) : (
                    <>
                      <p className="text-lg font-display font-semibold text-foreground break-words">
                        &asymp; {formatUSDC(quote.amountOut, locale)} {settleAsset}
                      </p>
                      <a
                        href={`https://stellar.expert/explorer/public/contract/${quote.price.sourceContract}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-start gap-1.5 text-[11px] text-muted-2 hover:text-foreground-muted leading-snug"
                      >
                        <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
                        <span>
                          Rate from Reflector ({quote.price.resolvedVia}) · {quote.price.ageSeconds}
                          s old
                          <span className="underline underline-offset-2 decoration-dotted">
                            {' '}
                            · view contract
                          </span>
                        </span>
                      </a>
                    </>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowQueryModal(true)}
                className="btn-gold w-full py-3 flex items-center justify-center gap-2"
              >
                <ShoppingCart className="h-4 w-4" /> Buy Now
              </button>
            </div>
          </aside>
        </div>
      </div>

      {showQueryModal && (
        <QueryModal
          dataset={dataset}
          onClose={() => setShowQueryModal(false)}
          onSuccess={() => setShowQueryModal(false)}
        />
      )}
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Database;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-void/50 border border-border/50 p-4">
      <Icon className="h-4 w-4 text-gold mb-2" />
      <p className="text-xs text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm text-foreground font-medium break-words">{value}</p>
    </div>
  );
}
