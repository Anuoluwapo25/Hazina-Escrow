import type { MessageKey, SupportedLocale } from '../i18n';

export function truncateAddress(addr: string, chars = 6): string {
  if (!addr || addr.length <= chars * 2) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function formatUSDC(amount: number, locale: string | SupportedLocale = 'en-US'): string {
  return amount.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function formatDate(iso: string, locale: string | SupportedLocale = 'en-US'): string {
  return new Date(iso).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTimeAgo(iso: string, locale: string | SupportedLocale = 'en'): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 1) return formatter.format(0, 'minute');
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

/** Future-oriented relative time ("in 3 days") from unix seconds. */
export function formatTimeUntil(unixSeconds: number, locale: string): string {
  const diffMs = unixSeconds * 1000 - Date.now();
  const minutes = Math.ceil(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 1) return formatter.format(0, 'minute');
  if (minutes < 60) return formatter.format(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export const DATA_TYPE_META: Record<
  string,
  { label: string; labelKey: MessageKey; color: string; bg: string }
> = {
  'whale-wallets': {
    label: 'Whale Wallets',
    labelKey: 'dataTypes.whaleWallets',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
  },
  'trading-signals': {
    label: 'Trading Signals',
    labelKey: 'dataTypes.tradingSignals',
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
  },
  'yield-data': {
    label: 'Yield Data',
    labelKey: 'dataTypes.yieldData',
    color: 'text-purple-400',
    bg: 'bg-purple-400/10',
  },
  'risk-scores': {
    label: 'Risk Scores',
    labelKey: 'dataTypes.riskScores',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
  },
  'nft-data': {
    label: 'NFT Data',
    labelKey: 'dataTypes.nftData',
    color: 'text-pink-400',
    bg: 'bg-pink-400/10',
  },
  sentiment: {
    label: 'Sentiment',
    labelKey: 'dataTypes.sentiment',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
  },
};

export function getTypeMeta(type: string) {
  return (
    DATA_TYPE_META[type] ?? {
      label: type,
      labelKey: 'common.labels.dataset',
      color: 'text-gold',
      bg: 'bg-gold/10',
    }
  );
}
