import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, ShoppingCart, User, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import clsx from 'clsx';
import type { Bundle } from '../../lib/api';
import { truncateAddress, formatUSDC } from '../../lib/utils';
import { useI18n } from '../../i18n';

interface Props {
  bundle: Bundle;
  /** Best-effort dataset id → display name lookup, e.g. from whatever page of the dataset list is currently loaded. Falls back to the raw id when unresolved. */
  datasetNames?: Record<string, string>;
  onBuy?: (bundle: Bundle) => void;
}

/**
 * Bundle cards are deliberately NOT a reskinned DatasetCard — transparency
 * about composition (who's inside, what split each seller gets) is the
 * product's whole selling point, so that information is shown up front
 * rather than hidden behind a click.
 */
export default function BundleCard({ bundle, datasetNames, onBuy }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { locale, t } = useI18n();

  const sortedComponents = [...bundle.components].sort((a, b) => a.position - b.position);
  const curatorPct = bundle.curatorFeeBps / 100;

  return (
    <div
      className={clsx(
        'relative rounded-2xl overflow-hidden border transition-all duration-300',
        bundle.degraded
          ? 'border-red-500/30 bg-red-950/10'
          : 'border-violet-400/30 bg-gradient-to-b from-violet-500/[0.07] to-transparent hover:border-violet-400/50 hover:shadow-[0_0_0_1px_rgba(167,139,250,0.15)]',
      )}
    >
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-400/60 to-transparent" />

      <div className="p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-body font-semibold uppercase tracking-wide bg-violet-400/15 text-violet-300 border border-violet-400/30 mb-2">
              <Layers className="w-3 h-3" />
              {t('bundles.card.badge')}
            </span>
            <h3 className="font-display font-semibold text-foreground text-base leading-snug line-clamp-1">
              {bundle.name}
            </h3>
            <div className="flex items-center gap-1.5 mt-1">
              <User className="w-3 h-3 text-muted" />
              <span className="text-[10px] font-mono text-muted-2">
                {t('bundles.card.curatorLabel', { wallet: truncateAddress(bundle.curatorWallet) })}
              </span>
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xs text-muted-2 font-body">{t('common.labels.total')}</p>
            <p className="text-lg font-display font-bold text-violet-300">
              ${formatUSDC(bundle.totalPrice, locale)}
            </p>
          </div>
        </div>

        <p className="text-sm text-foreground-muted font-body leading-relaxed line-clamp-2 mb-4 h-10">
          {bundle.description}
        </p>

        {bundle.degraded && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
            <span className="text-xs font-body text-red-300">
              {bundle.degradedReason ?? t('bundles.card.degradedBadge')}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center justify-between text-xs font-body text-foreground-muted hover:text-foreground border-t border-border/20 pt-3 mb-3"
          aria-expanded={expanded}
        >
          <span>{t('bundles.card.componentsCount', { count: sortedComponents.length })}</span>
          <span className="inline-flex items-center gap-1 text-violet-300">
            {t('bundles.card.viewSplits')}
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </span>
        </button>

        {expanded && (
          <ul className="space-y-1.5 mb-4">
            {sortedComponents.map(component => (
              <li
                key={component.id}
                className="flex items-center justify-between text-xs font-body px-3 py-2 rounded-lg bg-void/40 border border-border/20"
              >
                <Link
                  to={`/marketplace/${component.datasetId}`}
                  onClick={e => e.stopPropagation()}
                  className="text-foreground-muted hover:text-violet-300 truncate mr-2"
                >
                  {datasetNames?.[component.datasetId] ?? component.datasetId}
                </Link>
                <span className="font-mono text-violet-300 flex-shrink-0">
                  {(component.shareBps / 100).toFixed(component.shareBps % 100 === 0 ? 0 : 1)}%
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between text-xs font-body px-3 py-2 rounded-lg bg-violet-400/5 border border-violet-400/20">
              <span className="text-muted-2">{t('bundles.detail.curatorShare')}</span>
              <span className="font-mono text-violet-300 flex-shrink-0">
                {curatorPct.toFixed(curatorPct % 1 === 0 ? 0 : 1)}%
              </span>
            </li>
          </ul>
        )}

        <button
          type="button"
          disabled={bundle.degraded}
          onClick={() => onBuy?.(bundle)}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-3 rounded-xl font-body font-semibold text-sm transition-all duration-300',
            bundle.degraded
              ? 'bg-void/40 text-muted cursor-not-allowed'
              : 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400',
          )}
        >
          <ShoppingCart className="w-4 h-4" />
          {t('bundles.card.buyLabel', { price: formatUSDC(bundle.totalPrice, locale) })}
        </button>
      </div>
    </div>
  );
}
