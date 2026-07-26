import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Calendar, Database, DollarSign, Hash, ShoppingCart, Star } from 'lucide-react';
import clsx from 'clsx';
import { api, DatasetDetail } from '../lib/api';
import { formatUSDC, getTypeMeta, truncateAddress } from '../lib/utils';
import QueryModal from '../components/ui/QueryModal';
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
  const { locale } = useI18n();
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
              <span className={clsx('type-badge mb-5 inline-flex', typeMeta?.color, typeMeta?.bg)}>
                {typeMeta?.label ?? dataset.type}
              </span>
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
                  label="Per query"
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

            <section className="glass-card p-6 md:p-8">
              <h2 className="font-display text-2xl font-semibold text-foreground mb-4">
                Sanitised preview
              </h2>
              <pre className="overflow-x-auto rounded-xl bg-void/80 border border-border p-4 text-sm text-foreground-muted">
                <code>{previewJson}</code>
              </pre>
            </section>

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
              <div className="flex items-center justify-between gap-3 mb-4">
                <Stars value={ratings.score} />
                <span className="text-sm text-foreground-muted">
                  {ratings.score.toFixed(1)} ({ratings.count})
                </span>
              </div>
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
