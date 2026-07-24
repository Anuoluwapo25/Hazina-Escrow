import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import {
  Search,
  SlidersHorizontal,
  TrendingUp,
  Clock,
  DollarSign,
  X,
  ChevronLeft,
  ChevronRight,
  Check,
  RotateCcw,
  Radio,
} from 'lucide-react';
import { api, DatasetMeta, PaginatedDatasets } from '../lib/api';
import { DATA_TYPE_META } from '../lib/utils';
import DatasetCard from '../components/ui/DatasetCard';
import QueryModal from '../components/ui/QueryModal';
import { DatasetCardSkeleton, Skeleton } from '../components/ui/SkeletonLoader';
import clsx from 'clsx';
import { useI18n } from '../i18n';
import { useTransactionWebSocket } from '../hooks/useTransactionWebSocket';
import { WebSocketStatus } from '../components/ui/WebSocketStatus';

export default function MarketplacePage() {
  const { locale, t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();

  // Initialize state from URL parameters
  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '');
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [selectedTypes, setSelectedTypes] = useState<string[]>(
    searchParams.get('types')?.split(',').filter(Boolean) || [],
  );
  const [minPrice, setMinPrice] = useState(searchParams.get('minPrice') || '');
  const [maxPrice, setMaxPrice] = useState(searchParams.get('maxPrice') || '');
  const [minQueries, setMinQueries] = useState(searchParams.get('minQueries') || '');
  const [sort, setSort] = useState(searchParams.get('sort') || 'popular');
  const [category, setCategory] = useState(searchParams.get('category') || '');
  const [liveOnly, setLiveOnly] = useState(searchParams.get('live') === 'true');

  const pageParam = parseInt(searchParams.get('page') || '1', 10);
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
  const setPage = (nextPage: number) => {
    const updatedParams = new URLSearchParams(searchParams);
    updatedParams.set('page', String(Math.max(1, Math.floor(nextPage))));
    setSearchParams(updatedParams);
  };
  const [selectedDataset, setSelectedDataset] = useState<DatasetMeta | null>(null);
  const requestedPageSize = 12;

  // Debounce: only update the query key 400 ms after the user stops typing.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Sync filter state to URL parameters
  useEffect(() => {
    const updatedParams = new URLSearchParams(searchParams);

    // Update search query
    if (search) {
      updatedParams.set('q', search);
    } else {
      updatedParams.delete('q');
    }

    // Update type filters
    if (selectedTypes.length > 0) {
      updatedParams.set('types', selectedTypes.join(','));
    } else {
      updatedParams.delete('types');
    }

    // Update price range
    if (minPrice) {
      updatedParams.set('minPrice', minPrice);
    } else {
      updatedParams.delete('minPrice');
    }
    if (maxPrice) {
      updatedParams.set('maxPrice', maxPrice);
    } else {
      updatedParams.delete('maxPrice');
    }

    // Update min queries
    if (minQueries) {
      updatedParams.set('minQueries', minQueries);
    } else {
      updatedParams.delete('minQueries');
    }

    // Update sort
    updatedParams.set('sort', sort);

    // Update category
    if (category) {
      updatedParams.set('category', category);
    } else {
      updatedParams.delete('category');
    }

    // Update live-only filter
    if (liveOnly) {
      updatedParams.set('live', 'true');
    } else {
      updatedParams.delete('live');
    }

    // Only update if params changed to avoid infinite loop
    const paramString = updatedParams.toString();
    if (paramString !== searchParams.toString()) {
      setSearchParams(updatedParams);
    }
  }, [
    search,
    selectedTypes,
    minPrice,
    maxPrice,
    minQueries,
    sort,
    category,
    liveOnly,
    searchParams,
    setSearchParams,
  ]);

  const {
    data,
    isLoading: loading,
    refetch,
  } = useQuery<PaginatedDatasets>({
    queryKey: [
      'datasets',
      page,
      search,
      selectedTypes,
      minPrice,
      maxPrice,
      minQueries,
      sort,
      category,
      liveOnly,
    ],
    queryFn: () =>
      api.getDatasets({
        page,
        limit: requestedPageSize,
        search,
        types: selectedTypes,
        category: category || undefined,
        live: liveOnly || undefined,
        minPrice: minPrice ? Number(minPrice) : undefined,
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        minQueries: minQueries ? Number(minQueries) : undefined,
        sort,
      }),
  });

  const datasets = data?.data || [];
  const total = data?.total || 0;
  const pageSize = requestedPageSize;
  const totalPages = data?.totalPages || 1;

  // WebSocket connection for real-time updates
  const { connected: wsConnected, error: wsError } = useTransactionWebSocket(
    {
      datasetIds: datasets.map((d: DatasetMeta) => d.id),
      enabled: datasets.length > 0,
    },
    {
      onDatasetQueried: () => {
        // Refetch when new queries come in
        refetch();
      },
    },
  );

  useEffect(() => {
    if (page !== 1) {
      const updatedParams = new URLSearchParams(searchParams);
      updatedParams.set('page', '1');
      setSearchParams(updatedParams);
    }
  }, [
    search,
    sort,
    selectedTypes,
    minPrice,
    maxPrice,
    minQueries,
    category,
    liveOnly,
    page,
    searchParams,
    setSearchParams,
  ]);

  const currentPage = Math.min(page, totalPages);

  const pageStart = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const pageEnd = total === 0 ? 0 : Math.min(currentPage * pageSize, total);

  const visiblePages = useMemo(() => {
    const start = Math.max(1, currentPage - 1);
    const end = Math.min(totalPages, start + 2);
    const normalizedStart = Math.max(1, end - 2);
    return Array.from({ length: end - normalizedStart + 1 }, (_, index) => normalizedStart + index);
  }, [currentPage, totalPages]);

  const typeFilters = [
    { value: 'whale-wallets', label: t('dataTypes.whaleWallets') },
    { value: 'trading-signals', label: t('dataTypes.tradingSignals') },
    { value: 'yield-data', label: t('dataTypes.yieldData') },
    { value: 'risk-scores', label: t('dataTypes.riskScores') },
    { value: 'nft-data', label: t('dataTypes.nftData') },
    { value: 'sentiment', label: t('dataTypes.sentiment') },
  ];

  const categoryFilters = [
    { value: 'defi-yields', label: t('marketplace.categories.defi-yields') },
    { value: 'market-sentiment', label: t('marketplace.categories.market-sentiment') },
    { value: 'on-chain-flows', label: t('marketplace.categories.on-chain-flows') },
    { value: 'risk-intelligence', label: t('marketplace.categories.risk-intelligence') },
    { value: 'trading-signals', label: t('marketplace.categories.trading-signals') },
    { value: 'nft-analytics', label: t('marketplace.categories.nft-analytics') },
  ];

  const hasActiveFilters =
    selectedTypes.length > 0 ||
    Boolean(minPrice || maxPrice || minQueries || searchInput || category || liveOnly);

  const toggleTypeFilter = (type: string) => {
    setSelectedTypes((current: string[]) =>
      current.includes(type)
        ? current.filter((value: string) => value !== type)
        : [...current, type],
    );
  };

  const resetFilters = () => {
    setSearchInput('');
    setSearch('');
    setSelectedTypes([]);
    setMinPrice('');
    setMaxPrice('');
    setMinQueries('');
    setSort('popular');
    setCategory('');
    setLiveOnly(false);
    setPage(1);
  };

  const sortOptions = [
    { value: 'popular', label: t('marketplace.sorts.popular'), icon: TrendingUp },
    { value: 'price-asc', label: t('marketplace.sorts.priceAsc'), icon: DollarSign },
    { value: 'price-desc', label: t('marketplace.sorts.priceDesc'), icon: DollarSign },
    { value: 'newest', label: t('marketplace.sorts.newest'), icon: Clock },
  ];

  return (
    <div className="min-h-screen pt-28 pb-20">
      <Helmet>
        <title>Marketplace | Premium Web3 Data</title>
        <meta
          name="description"
          content="Browse and buy premium on-chain intelligence datasets. Real-time whale movements, yield data, and sentiment analysis."
        />
        <meta property="og:title" content="Hazina Data Marketplace" />
        <meta
          property="og:description"
          content="Premium on-chain intelligence, priced per query."
        />
      </Helmet>

      <div className="max-w-7xl mx-auto px-4">
        {/* Header */}
        <div className="mb-10">
          <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
            {t('marketplace.eyebrow')}
          </p>
          <div className="flex items-center gap-3 mb-3">
            <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
              {t('marketplace.title')}
            </h1>
            {datasets.length > 0 && <WebSocketStatus connected={wsConnected} error={wsError} />}
          </div>
          <p className="text-foreground-muted font-body text-lg">{t('marketplace.subtitle')}</p>
        </div>

        {/* Category tabs + live toggle */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <button
            type="button"
            onClick={() => setCategory('')}
            aria-pressed={category === ''}
            className={clsx(
              'px-4 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200',
              category === ''
                ? 'bg-gold text-void'
                : 'bg-void/60 border border-border/60 text-foreground-muted hover:text-foreground hover:border-gold/30',
            )}
          >
            {t('marketplace.categories.all')}
          </button>
          {categoryFilters.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(current => (current === value ? '' : value))}
              aria-pressed={category === value}
              className={clsx(
                'px-4 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200',
                category === value
                  ? 'bg-gold text-void'
                  : 'bg-void/60 border border-border/60 text-foreground-muted hover:text-foreground hover:border-gold/30',
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setLiveOnly(current => !current)}
            aria-pressed={liveOnly}
            className={clsx(
              'ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200',
              liveOnly
                ? 'bg-emerald-400/15 border border-emerald-400/40 text-emerald-400'
                : 'bg-void/60 border border-border/60 text-foreground-muted hover:text-foreground hover:border-emerald-400/30',
            )}
          >
            <Radio
              className={clsx('w-3.5 h-3.5', liveOnly && 'animate-pulse')}
              aria-hidden="true"
            />
            {t('marketplace.live.liveOnly')}
          </button>
        </div>

        {/* Search + Filters */}
        <div className="glass-card p-5 mb-8">
          <div className="flex flex-col xl:flex-row gap-4">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input
                type="text"
                placeholder={t('marketplace.searchPlaceholder')}
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="w-full bg-void/60 border border-border/60 rounded-xl pl-11 pr-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
              />
              {searchInput && (
                <button
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                  aria-label={t('common.actions.resetSearch')}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Range filters */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 xl:w-[32rem]">
              <label className="relative">
                <span className="sr-only">{t('marketplace.filters.minPrice')}</span>
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={t('marketplace.filters.minPrice')}
                  value={minPrice}
                  onChange={e => setMinPrice(e.target.value)}
                  className="w-full bg-void/60 border border-border/60 rounded-xl pl-9 pr-3 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
                />
              </label>
              <label className="relative">
                <span className="sr-only">{t('marketplace.filters.maxPrice')}</span>
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={t('marketplace.filters.maxPrice')}
                  value={maxPrice}
                  onChange={e => setMaxPrice(e.target.value)}
                  className="w-full bg-void/60 border border-border/60 rounded-xl pl-9 pr-3 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
                />
              </label>
              <label className="relative">
                <span className="sr-only">{t('marketplace.filters.minQueries')}</span>
                <TrendingUp className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder={t('marketplace.filters.minQueries')}
                  value={minQueries}
                  onChange={e => setMinQueries(e.target.value)}
                  className="w-full bg-void/60 border border-border/60 rounded-xl pl-9 pr-3 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
                />
              </label>
            </div>

            {/* Sort */}
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-muted flex-shrink-0" />
              <select
                value={sort}
                onChange={e => setSort(e.target.value)}
                className="bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none focus:border-gold/40 transition-colors"
              >
                {sortOptions.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Type filter pills */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mt-4">
            <div className="flex flex-wrap gap-2">
              {typeFilters.map(({ value, label }) => {
                const meta = DATA_TYPE_META[value];
                const isSelected = selectedTypes.includes(value);
                return (
                  <button
                    key={value}
                    onClick={() => toggleTypeFilter(value)}
                    aria-label={t('marketplace.filterBy', { type: label })}
                    aria-pressed={isSelected}
                    className={clsx(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-body font-medium transition-all duration-200',
                      isSelected
                        ? 'bg-gold text-void'
                        : `${meta?.bg || ''} ${meta?.color || ''} hover:opacity-80`,
                    )}
                  >
                    {isSelected && <Check className="w-3 h-3" aria-hidden="true" />}
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              {selectedTypes.length > 0 && (
                <span className="text-xs font-body text-foreground-muted">
                  {t('marketplace.filters.selectedTypes', {
                    count: selectedTypes.length.toLocaleString(locale),
                  })}
                </span>
              )}
              <button
                type="button"
                onClick={resetFilters}
                disabled={!hasActiveFilters}
                className={clsx(
                  'btn-ghost px-3 py-1.5 text-xs inline-flex items-center gap-2',
                  !hasActiveFilters && 'opacity-50 cursor-not-allowed',
                )}
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                {t('marketplace.filters.reset')}
              </button>
            </div>
          </div>
        </div>

        {/* Results count */}
        <div className="flex items-center justify-between gap-4 mb-6" aria-busy={loading}>
          {loading ? (
            <div className="space-y-2">
              <Skeleton variant="text" width={240} height={16} />
              <Skeleton variant="text" width={160} height={12} />
            </div>
          ) : (
            <p className="text-sm text-foreground-muted font-body">
              {t('marketplace.pagination.showing', {
                start: pageStart.toLocaleString(locale),
                end: pageEnd.toLocaleString(locale),
                total: total.toLocaleString(locale),
              })}
            </p>
          )}
          {loading ? (
            <Skeleton variant="text" width={88} height={14} />
          ) : datasets.length > 0 ? (
            <p className="text-sm text-foreground-muted font-body">
              {t('marketplace.pagination.page', {
                current: currentPage.toLocaleString(locale),
                total: totalPages.toLocaleString(locale),
              })}
            </p>
          ) : null}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <DatasetCardSkeleton key={i} />
            ))}
          </div>
        ) : datasets.length === 0 ? (
          <div className="text-center py-24">
            <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-border flex items-center justify-center mx-auto mb-4">
              <Search className="w-8 h-8 text-muted" />
            </div>
            <h3 className="font-display text-xl text-foreground mb-2">
              {t('marketplace.noResultsTitle')}
            </h3>
            <p className="text-foreground-muted font-body text-sm">
              {t('marketplace.noResultsBody')}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {datasets.map((ds: DatasetMeta) => (
                <DatasetCard key={ds.id} dataset={ds} onBuy={setSelectedDataset} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  aria-label={t('marketplace.pagination.previous')}
                  className={clsx(
                    'btn-ghost px-4 py-2 text-sm flex items-center gap-2',
                    currentPage === 1 && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                  {t('marketplace.pagination.previous')}
                </button>

                <div className="flex items-center gap-2">
                  {visiblePages.map(pageNumber => (
                    <button
                      key={pageNumber}
                      type="button"
                      onClick={() => setPage(pageNumber)}
                      aria-label={t('marketplace.pagination.goToPage', { page: pageNumber })}
                      aria-current={currentPage === pageNumber ? 'page' : undefined}
                      className={clsx(
                        'w-10 h-10 rounded-xl text-sm font-body font-medium transition-all duration-200',
                        currentPage === pageNumber
                          ? 'bg-gold text-void'
                          : 'bg-surface-2 text-foreground-muted hover:text-foreground hover:bg-surface',
                      )}
                    >
                      {pageNumber.toLocaleString(locale)}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  aria-label={t('marketplace.pagination.next')}
                  className={clsx(
                    'btn-ghost px-4 py-2 text-sm flex items-center gap-2',
                    currentPage === totalPages && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {t('marketplace.pagination.next')}
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Query Modal */}
      {selectedDataset && (
        <QueryModal
          dataset={selectedDataset}
          onClose={() => setSelectedDataset(null)}
          onSuccess={() => {
            refetch();
            setSelectedDataset(null);
          }}
        />
      )}
    </div>
  );
}
