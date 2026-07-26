import { useState } from 'react';

import { Link } from 'react-router-dom';
import { ShoppingCart, TrendingUp, User, Zap, Clock, ImageOff, Star } from 'lucide-react';

import clsx from 'clsx';
import { DatasetMeta } from '../../lib/api';
import { truncateAddress, formatUSDC, getTypeMeta } from '../../lib/utils';

import { useI18n } from '../../i18n';

interface Props {
  dataset: DatasetMeta;
  onBuy?: (dataset: DatasetMeta) => void;
}

export default function DatasetCard({ dataset, onBuy }: Props) {
  const [hovered, setHovered] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { locale, t } = useI18n();
  const typeMeta = getTypeMeta(dataset.type);
  const typeLabel = typeMeta.labelKey ? t(typeMeta.labelKey) : typeMeta.label;

  return (
    <Link
      to={`/marketplace/${dataset.id}`}
      className={clsx(
        'glass-card group relative cursor-pointer transition-all duration-300 overflow-hidden',
        hovered && 'shadow-card-hover border-border-gold/30 translate-y-[-2px]',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`View details for ${dataset.name}`}
    >
      {/* Top gold shimmer line */}
      <div
        className={clsx(
          'absolute top-0 left-0 right-0 h-px transition-all duration-500 z-10',
          hovered
            ? 'bg-gradient-to-r from-transparent via-gold to-transparent opacity-100'
            : 'opacity-0',
        )}
      />

      {/* Dataset Image */}
      <div className="relative h-40 overflow-hidden bg-void-2/50 group-hover:bg-void-2/30 transition-colors duration-500 flex items-center justify-center">
        {imageError ? (
          <div className="flex flex-col items-center gap-2 text-muted-2">
            <ImageOff className="w-8 h-8 opacity-20" />
            <span className="text-[10px] uppercase tracking-tighter opacity-30 font-body">
              {t('common.errors.imageNotSupported')}
            </span>
          </div>
        ) : (
          <>
            <img
              src={
                dataset.thumbnail || `https://source.unsplash.com/featured/?crypto,${dataset.type}`
              }
              alt={`${dataset.name} dataset preview`}
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-60 group-hover:opacity-80"
              onError={() => setImageError(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-transparent to-transparent opacity-60" />
          </>
        )}

        {/* Floating badge over image */}
        <div className="absolute top-4 left-4 z-10">
          <span
            className={clsx(
              'type-badge backdrop-blur-md border border-gold/20 shadow-lg',
              typeMeta.color,
              typeMeta.bg,
            )}
          >
            <Zap className="w-3 h-3" />
            {typeLabel}
          </span>
        </div>
      </div>

      <div className="p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex-1">
            <h3 className="font-display font-semibold text-foreground text-base mb-1 leading-snug line-clamp-1 group-hover:text-gold transition-colors duration-300">
              {dataset.name}
            </h3>
            <div className="flex items-center gap-1.5">
              <User className="w-3 h-3 text-muted" />
              <span className="text-[10px] font-mono text-muted-2">
                {truncateAddress(dataset.sellerWallet)}
              </span>
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xs text-muted-2 font-body">{t('common.units.perQuery')}</p>
            <p className="text-lg font-display font-bold text-gold-gradient">
              ${formatUSDC(dataset.pricePerQuery, locale)}
            </p>
          </div>
        </div>

        {/* Description */}
        <p className="text-sm text-foreground-muted font-body leading-relaxed line-clamp-2 mb-5 h-10">
          {dataset.description}
        </p>

        {/* Stats */}
        <div className="flex items-center gap-4 mb-5 border-t border-border/20 pt-4">
          <div className="flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-body text-foreground-muted">
              <span className="text-foreground font-medium">
                {dataset.queriesServed.toLocaleString(locale)}
              </span>{' '}
              {t('common.units.queries')}
            </span>
          </div>
          {dataset.ratings && dataset.ratings.count > 0 && (
            <>
              <div className="w-px h-3 bg-border" />
              <div className="flex items-center gap-1.5">
                <Star className="w-3.5 h-3.5 text-gold" fill="currentColor" />
                <span className="text-xs font-body text-foreground-muted">
                  <span className="text-foreground font-medium">
                    {dataset.ratings.score.toFixed(1)}
                  </span>{' '}
                  ({dataset.ratings.count})
                </span>
              </div>
            </>
          )}
          <div className="w-px h-3 bg-border" />
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted" />
            <span className="text-xs font-body text-foreground-muted">
              {new Date(dataset.createdAt).toLocaleDateString(locale, { dateStyle: 'medium' })}
            </span>
          </div>
        </div>

        {/* Earnings bar */}
        <div className="mb-5">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-xs text-muted-2 font-body">
              {t('dashboard.stats.totalEarned')}
            </span>
            <span className="text-xs font-body font-medium text-gold">
              ${formatUSDC(dataset.totalEarned, locale)} USDC
            </span>
          </div>
          <div className="h-1.5 bg-border/60 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${Math.min((dataset.totalEarned / 20) * 100, 100)}%`,
                background: 'linear-gradient(90deg, #C9A84C, #E8C96A)',
              }}
            />
          </div>
        </div>

        {/* Buy button */}
        <button
          onClick={event => {
            if (!onBuy) return;
            event.preventDefault();
            event.stopPropagation();
            onBuy(dataset);
          }}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-3 rounded-xl font-body font-semibold text-sm transition-all duration-300',
            hovered
              ? 'btn-gold'
              : 'border border-border-gold/30 text-gold hover:border-border-gold/50 hover:bg-gold/5',
          )}
        >
          <ShoppingCart className="w-4 h-4" />
          {t('sell.preview.buyLabel', { price: formatUSDC(dataset.pricePerQuery, locale) })}
        </button>
      </div>
    </Link>
  );
}
