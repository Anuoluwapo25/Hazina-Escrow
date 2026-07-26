import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  TrendingUp,
  Database,
  Zap,
  Clock,
  ArrowUpRight,
  DollarSign,
  Activity,
  ChevronRight,
  Loader2,
} from 'lucide-react';

import { api, DatasetMeta, PaginatedDatasets, SellerAnalytics, Transaction } from '../lib/api';

import { useCountUp } from '../hooks/useCountUp';
import { formatTimeAgo, formatUSDC, getTypeMeta, truncateAddress } from '../lib/utils';
import { Link } from 'react-router-dom';
import {
  Skeleton,
  StatCardSkeleton,
  TransactionRowSkeleton,
  ChartSkeleton,
} from '../components/ui/SkeletonLoader';
import clsx from 'clsx';
import { useI18n } from '../i18n';
import { useTransactionWebSocket } from '../hooks/useTransactionWebSocket';
import { WebSocketStatus } from '../components/ui/WebSocketStatus';

/* ── Animated stat card ── */
function StatCard({
  icon: Icon,
  label,
  value,
  suffix = '',
  prefix = '',
  decimals = 0,
  color = 'text-gold',
  trend,
  locale = 'en-US',
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  color?: string;
  trend?: number | null;
  locale?: string;
}) {
  const animated = useCountUp(value, 1800, decimals);
  const trendValid = trend !== undefined && trend !== null && isFinite(trend) && !isNaN(trend);
  return (
    <div className="glass-card-gold p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/20 flex items-center justify-center">
          <Icon className="w-5 h-5 text-gold" />
        </div>
        {trend !== undefined && (
          <span
            className={clsx(
              'text-xs font-body font-medium flex items-center gap-0.5 px-2 py-1 rounded-full',
              !trendValid
                ? 'text-foreground-muted bg-surface-2'
                : trend >= 0
                  ? 'text-emerald-400 bg-emerald-400/10'
                  : 'text-red-400 bg-red-400/10',
            )}
          >
            {trendValid && <ArrowUpRight className={clsx('w-3 h-3', trend < 0 && 'rotate-180')} />}
            {trendValid ? `${Math.abs(trend).toFixed(1)}%` : '—'}
          </span>
        )}
      </div>
      <p className="font-display font-bold text-2xl text-foreground mb-0.5 tabular-nums">
        <span className={color}>{prefix}</span>
        {decimals > 0 ? animated.toFixed(decimals) : Math.round(animated).toLocaleString(locale)}
        <span className="text-sm text-foreground-muted ml-1 font-body font-normal">{suffix}</span>
      </p>
      <p className="text-xs text-foreground-muted font-body">{label}</p>
    </div>
  );
}

/* ── Custom tooltip for charts ── */
function ChartTooltip({
  active,
  payload,
  label,
  locale,
  earnedLabel,
  queriesLabel,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
  locale: string;
  earnedLabel: string;
  queriesLabel: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card-gold px-4 py-3 text-xs font-body">
      <p className="text-foreground-muted mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.name} className="text-gold font-semibold">
          {p.name === earnedLabel ? '$' : ''}
          {p.name === earnedLabel
            ? formatUSDC(p.value, locale)
            : p.value.toLocaleString(locale)}{' '}
          {p.name === earnedLabel ? 'USDC' : queriesLabel}
        </p>
      ))}
    </div>
  );
}

/* ── Safe percentage change (returns null when previous is 0 to avoid NaN/Infinity) ── */
function safePctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/* ── Generate 7-day chart data from transactions ── */
function buildChartData(transactions: Transaction[], locale: string) {
  const days: Record<string, { queries: number; earned: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
    days[key] = { queries: 0, earned: 0 };
  }
  transactions.forEach(tx => {
    const key = new Date(tx.timestamp).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
    if (days[key]) {
      days[key].queries += 1;
      days[key].earned += tx.sellerReceived ?? tx.amount;
    }
  });
  return Object.entries(days).map(([day, v]) => ({ day, ...v }));
}

export default function DashboardPage() {
  const { locale, t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [isRefetching, setIsRefetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [walletFilter, setWalletFilter] = useState('');

  const [analytics, setAnalytics] = useState<SellerAnalytics | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'analytics'>('overview');

  const [isMobile, setIsMobile] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const websocketOptions = useMemo(() => ({ enabled: hasLoadedOnce }), [hasLoadedOnce]);
  const websocketCallbacks = useMemo(() => ({}), []);
  const { connected: wsConnected, error: wsError } = useTransactionWebSocket(
    websocketOptions,
    websocketCallbacks,
  );

  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      if (hasLoadedOnceRef.current) {
        setIsRefetching(true);
      } else {
        setLoading(true);
      }
      setFetchError(null);

      try {
        const [ds, txs] = (await Promise.all([api.getDatasets(), api.getTransactions()])) as [
          PaginatedDatasets,
          Transaction[],
        ];
        if (cancelled) {
          return;
        }

        setDatasets(ds.data);
        setTransactions(txs);
        setHasLoadedOnce(true);
        hasLoadedOnceRef.current = true;
      } catch (err) {
        if (cancelled) {
          return;
        }

        setFetchError(err instanceof Error ? err.message : t('dashboard.loadError'));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setIsRefetching(false);
        }
      }
    };

    void loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [t]);

  const selectedWallet = walletFilter || datasets[0]?.sellerWallet || '';
  useEffect(() => {
    if (!selectedWallet) return;
    api
      .getSellerAnalytics(selectedWallet)
      .then(setAnalytics)
      .catch(() => setAnalytics(null));
  }, [selectedWallet]);

  const exportCsv = () => {
    const rows = [
      ['id', 'datasetId', 'txHash', 'amount', 'timestamp'],
      ...transactions.map(tx => [
        tx.id,
        tx.datasetId,
        tx.txHash,
        tx.amount.toString(),
        tx.timestamp,
      ]),
    ];
    const csv = rows
      .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hazina-transactions.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 640px)');
    const handleMobileChange = () => setIsMobile(mobileQuery.matches);

    handleMobileChange();
    mobileQuery.addEventListener('change', handleMobileChange);

    return () => {
      mobileQuery.removeEventListener('change', handleMobileChange);
    };
  }, []);

  const totalEarned = datasets.reduce((s, d) => s + d.totalEarned, 0);
  const totalQueries = datasets.reduce((s, d) => s + d.queriesServed, 0);
  const chartData = buildChartData(transactions, locale);

  const revenueData =
    analytics?.revenueSeries.map(point => ({ day: point.date.slice(5), earned: point.usdc })) ??
    chartData;
  const queryData =
    analytics?.queryVolumeSeries.map(point => ({
      day: point.date.slice(5),
      queries: point.count,
    })) ?? chartData;

  // Compare last 3 days vs preceding 4 days for trend indicators
  const recentEarned = chartData.slice(-3).reduce((s, d) => s + d.earned, 0);
  const prevEarned = chartData.slice(0, 4).reduce((s, d) => s + d.earned, 0);
  const earnedTrend = safePctChange(recentEarned, prevEarned);

  const recentQueries = chartData.slice(-3).reduce((s, d) => s + d.queries, 0);
  const prevQueries = chartData.slice(0, 4).reduce((s, d) => s + d.queries, 0);
  const queriesTrend = safePctChange(recentQueries, prevQueries);

  const recentTx = [...transactions]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 8);

  // Filter by seller wallet
  const uniqueWallets = [...new Set(datasets.map(d => d.sellerWallet))];
  const filteredDatasets = walletFilter
    ? datasets.filter(d => d.sellerWallet === walletFilter)
    : datasets;

  if (loading && !hasLoadedOnce) {
    return (
      <div className="min-h-screen pt-28 pb-20">
        <div className="max-w-7xl mx-auto px-4">
          {/* Header skeleton */}
          <div className="mb-10">
            <Skeleton variant="text" width={128} height={16} className="mb-2" />
            <Skeleton variant="text" width={256} height={40} className="mb-2" />
            <Skeleton variant="text" width={384} height={20} />
          </div>

          {/* Stats row skeleton */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>

          {/* Charts row skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 overflow-x-hidden">
            <div className="lg:col-span-2">
              <ChartSkeleton />
            </div>
            <ChartSkeleton />
          </div>

          {/* Bottom section skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="glass-card p-6">
              <Skeleton variant="text" width={160} height={24} className="mb-5" />
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} variant="rounded" width="100%" height={80} />
                ))}
              </div>
            </div>
            <div className="glass-card p-6">
              <Skeleton variant="text" width={192} height={24} className="mb-5" />
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <TransactionRowSkeleton key={i} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (fetchError && !hasLoadedOnce) {
    return (
      <div className="min-h-screen pt-28 flex items-center justify-center px-4">
        <div className="glass-card max-w-md w-full p-8 text-center">
          <p className="font-display text-xl font-semibold text-foreground mb-3">
            {t('dashboard.loadError')}
          </p>
          <p className="text-sm text-foreground-muted font-body mb-6">{fetchError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-gold px-6 py-2.5 text-sm"
          >
            {t('common.actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-28 pb-20">
      <div className="max-w-7xl mx-auto px-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-10">
          <div>
            <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
              {t('dashboard.eyebrow')}
            </p>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
                {t('dashboard.title')}
              </h1>
              {isRefetching && (
                <span
                  className="inline-flex items-center gap-2 rounded-full border border-gold/20 bg-gold/10 px-3 py-1 text-xs font-body font-medium text-gold"
                  aria-live="polite"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  {t('dashboard.refreshing')}
                </span>
              )}
              {hasLoadedOnce && <WebSocketStatus connected={wsConnected} error={wsError} />}
            </div>
            <p className="text-foreground-muted font-body">{t('dashboard.subtitle')}</p>
          </div>
          <Link
            to="/sell"
            className="hidden md:flex btn-gold items-center gap-2 text-sm px-5 py-2.5"
          >
            <Database className="w-4 h-4" />
            {t('common.actions.listNewDataset')}
          </Link>
        </div>

        {/* Wallet filter */}
        {uniqueWallets.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-6">
            <button
              onClick={() => setWalletFilter('')}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-body font-medium transition-all',
                !walletFilter
                  ? 'bg-gold text-void'
                  : 'bg-surface-2 text-foreground-muted hover:text-foreground',
              )}
            >
              {t('dashboard.allSellers')}
            </button>
            {uniqueWallets.map(w => (
              <button
                key={w}
                onClick={() => setWalletFilter(w)}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all',
                  walletFilter === w
                    ? 'bg-gold text-void'
                    : 'bg-surface-2 text-foreground-muted hover:text-foreground',
                )}
              >
                {truncateAddress(w)}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
          <div
            className="inline-flex rounded-xl border border-border/40 bg-surface-2/40 p-1"
            role="tablist"
            aria-label="Dashboard sections"
          >
            {(['overview', 'analytics'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={clsx(
                  'px-4 py-2 rounded-lg text-sm font-body font-medium capitalize transition-all',
                  activeTab === tab
                    ? 'bg-gold text-void shadow-gold-sm'
                    : 'text-foreground-muted hover:text-foreground',
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <button type="button" onClick={exportCsv} className="btn-gold text-sm px-4 py-2">
            Export CSV
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={DollarSign}
            label={t('dashboard.stats.totalEarned')}
            value={totalEarned}
            prefix="$"
            decimals={4}
            color="text-gold"
            trend={earnedTrend}
            locale={locale}
          />
          <StatCard
            icon={Zap}
            label={t('dashboard.stats.totalQueries')}
            value={totalQueries}
            suffix={t('common.units.queries')}
            trend={queriesTrend}
            locale={locale}
          />
          <StatCard
            icon={Database}
            label={t('dashboard.stats.activeDatasets')}
            value={filteredDatasets.length}
            suffix={t('common.units.listed')}
            locale={locale}
          />
          <StatCard
            icon={Activity}
            label={t('dashboard.stats.transactions')}
            value={transactions.length}
            suffix={t('common.units.total')}
            locale={locale}
          />
        </div>

        {activeTab === 'analytics' && (
          <section role="tabpanel" aria-label="Analytics">
            {/* Charts row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 overflow-x-hidden">
              {/* Earnings area chart */}
              <div className="lg:col-span-2 glass-card p-6 min-w-0">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="font-display font-semibold text-foreground">
                      {t('dashboard.charts.earningsTitle')}
                    </h3>
                    <p className="text-xs text-foreground-muted font-body mt-0.5">
                      {t('dashboard.charts.earningsSubtitle')}
                    </p>
                  </div>
                  <TrendingUp className="w-5 h-5 text-gold" />
                </div>
                <div className="h-[220px] w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={revenueData}
                      margin={{ top: 5, right: 5, left: isMobile ? -16 : 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#C9A84C" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#C9A84C" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis
                        dataKey="day"
                        tick={{ fill: '#6B7280', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={isMobile ? 24 : 12}
                      />
                      <YAxis
                        tick={{ fill: '#6B7280', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      {!isMobile && (
                        <Tooltip
                          content={
                            <ChartTooltip
                              locale={locale}
                              earnedLabel={t('dashboard.charts.earnedSeries')}
                              queriesLabel={t('common.units.queries')}
                            />
                          }
                        />
                      )}
                      <Area
                        type="monotone"
                        dataKey="earned"
                        name={t('dashboard.charts.earnedSeries')}
                        stroke="#C9A84C"
                        strokeWidth={2}
                        fill="url(#goldGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Queries bar chart */}
              <div className="glass-card p-6 min-w-0">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="font-display font-semibold text-foreground">
                      {t('dashboard.charts.queriesTitle')}
                    </h3>
                    <p className="text-xs text-foreground-muted font-body mt-0.5">
                      {t('dashboard.charts.queriesSubtitle')}
                    </p>
                  </div>
                  <Activity className="w-5 h-5 text-gold" />
                </div>
                <div className="h-[220px] w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={queryData}
                      margin={{ top: 5, right: 5, left: isMobile ? -16 : 0, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis
                        dataKey="day"
                        tick={{ fill: '#6B7280', fontSize: 9 }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={isMobile ? 24 : 12}
                      />
                      <YAxis
                        tick={{ fill: '#6B7280', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      {!isMobile && (
                        <Tooltip
                          content={
                            <ChartTooltip
                              locale={locale}
                              earnedLabel={t('dashboard.charts.earnedSeries')}
                              queriesLabel={t('common.units.queries')}
                            />
                          }
                        />
                      )}
                      <Bar
                        dataKey="queries"
                        name={t('dashboard.charts.queriesSeries')}
                        radius={[4, 4, 0, 0]}
                      >
                        {queryData.map((_, i) => (
                          <Cell
                            key={i}
                            fill={i === queryData.length - 1 ? '#C9A84C' : 'rgba(201,168,76,0.35)'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'overview' && (
          <section role="tabpanel" aria-label="Overview">
            {/* Datasets + Transactions */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Dataset performance */}
              <div className="glass-card p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="font-display font-semibold text-foreground">
                    {t('dashboard.datasets.title')}
                  </h3>
                  <Link
                    to="/marketplace"
                    className="text-xs text-gold hover:text-gold-light font-body flex items-center gap-1 transition-colors"
                  >
                    {t('common.actions.viewAll')} <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="space-y-3">
                  {filteredDatasets.length === 0 ? (
                    <div className="text-center py-8">
                      <Database className="w-8 h-8 text-muted mx-auto mb-2" />
                      <p className="text-sm text-foreground-muted font-body">
                        {t('dashboard.datasets.empty')}
                      </p>
                      <Link
                        to="/sell"
                        className="text-xs text-gold hover:text-gold-light font-body mt-1 inline-block"
                      >
                        {t('common.actions.listFirstDataset')} →
                      </Link>
                    </div>
                  ) : (
                    filteredDatasets.map(ds => {
                      const typeMeta = getTypeMeta(ds.type);
                      const maxEarned = Math.max(...filteredDatasets.map(d => d.totalEarned), 1);
                      return (
                        <div
                          key={ds.id}
                          className="group p-4 rounded-xl bg-surface-2/50 hover:bg-surface-2 border border-border/30 hover:border-border-gold/20 transition-all duration-200"
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex-1 min-w-0">
                              <span
                                className={clsx(
                                  'type-badge text-xs mb-1 inline-flex',
                                  typeMeta.color,
                                  typeMeta.bg,
                                )}
                              >
                                {typeMeta.labelKey ? t(typeMeta.labelKey) : typeMeta.label}
                              </span>
                              <p className="text-sm font-body font-medium text-foreground truncate group-hover:text-gold transition-colors">
                                {ds.name}
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-sm font-display font-bold text-gold">
                                ${formatUSDC(ds.totalEarned, locale)}
                              </p>
                              <p className="text-xs text-muted-2 font-body">
                                {ds.queriesServed.toLocaleString(locale)}{' '}
                                {t('common.units.queries')}
                              </p>
                            </div>
                          </div>
                          {/* Progress bar */}
                          <div className="h-1 bg-border/40 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${(ds.totalEarned / maxEarned) * 100}%`,
                                background: 'linear-gradient(90deg, #C9A84C, #E8C96A)',
                                transition: 'width 1s ease-out',
                              }}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Recent transactions */}
              <div className="glass-card p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="font-display font-semibold text-foreground">
                    {t('dashboard.transactions.title')}
                  </h3>
                  <Clock className="w-4 h-4 text-muted" />
                </div>
                {recentTx.length === 0 ? (
                  <div className="text-center py-8">
                    <Activity className="w-8 h-8 text-muted mx-auto mb-2" />
                    <p className="text-sm text-foreground-muted font-body">
                      {t('dashboard.transactions.empty')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {recentTx.map(tx => {
                      const ds = datasets.find(d => d.id === tx.datasetId);
                      return (
                        <div
                          key={tx.id}
                          className="flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 hover:bg-surface-2/70 border border-border/20 transition-all duration-200"
                        >
                          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
                            <DollarSign className="w-4 h-4 text-emerald-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-body font-medium text-foreground truncate">
                              {ds?.name ?? t('dashboard.datasets.unknownDataset')}
                            </p>
                            <p className="text-xs text-muted-2 font-mono truncate">
                              {tx.txHash.startsWith('demo')
                                ? t('dashboard.transactions.demoMode')
                                : tx.txHash.slice(0, 20) + '...'}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-display font-bold text-gold">
                              +${(tx.sellerReceived ?? tx.amount).toFixed(4)}
                            </p>
                            <p className="text-xs text-muted-2 font-body">
                              {formatTimeAgo(tx.timestamp, locale)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {analytics && (
              <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="glass-card p-6">
                  <h3 className="font-display font-semibold text-foreground mb-4">
                    Dataset leaderboard
                  </h3>
                  <div className="space-y-2">
                    {analytics.datasetBreakdown.slice(0, 5).map(item => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between rounded-xl bg-surface-2/40 p-3"
                      >
                        <span className="text-sm text-foreground truncate">{item.name}</span>
                        <span className="text-xs text-gold">
                          ${formatUSDC(item.earned, locale)} · {item.queries} queries
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="glass-card p-6">
                  <h3 className="font-display font-semibold text-foreground mb-4">
                    Top buyer wallets
                  </h3>
                  <div className="space-y-2">
                    {analytics.topBuyers.map(buyer => (
                      <div
                        key={buyer.wallet}
                        className="flex items-center justify-between rounded-xl bg-surface-2/40 p-3"
                      >
                        <span className="font-mono text-xs text-gold">
                          {truncateAddress(buyer.wallet)}
                        </span>
                        <span className="text-xs text-foreground-muted">
                          {buyer.count.toLocaleString(locale)} queries
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Bottom banner */}
        <div className="mt-6 glass-card-gold p-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <h3 className="font-display font-semibold text-foreground text-lg mb-1">
              Ready to list more data?
            </h3>
            <p className="text-sm text-foreground-muted font-body">
              Every dataset you list is a new passive income stream — running 24/7 on Stellar.
            </p>
          </div>
          <Link
            to="/sell"
            className="btn-gold flex items-center gap-2 text-sm px-6 py-3 flex-shrink-0"
          >
            <Database className="w-4 h-4" />
            List New Dataset
          </Link>
        </div>
      </div>
    </div>
  );
}
