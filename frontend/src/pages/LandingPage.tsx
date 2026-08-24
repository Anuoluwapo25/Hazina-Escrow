import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Database,
  Shield,
  Zap,
  TrendingUp,
  Lock,
  ChevronRight,
  Star,
  Globe,
  Activity,
  Upload,
} from 'lucide-react';
import { api, DatasetMeta } from '../lib/api';
import { useCountUp } from '../hooks/useCountUp';
import DatasetCard from '../components/ui/DatasetCard';
import { DatasetCardSkeleton } from '../components/ui/SkeletonLoader';
import clsx from 'clsx';
import { useI18n } from '../i18n';

const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const PARTICLE_COUNT =
  typeof window !== 'undefined' && window.matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches ? 0 : 30;
const PARTICLE_SIZE = 4;
const PARTICLE_ANIMATION_MIN_DURATION = 6;
const PARTICLE_ANIMATION_DURATION_RANGE = 6;
const PARTICLE_ANIMATION_DELAY_MAX = 5;
const PARTICLE_OPACITY_BASE = 0.3;
const PARTICLE_OPACITY_VARIANCE = 0.5;
const HERO_FADE_IN_DELAY_MS = 100;
const FEATURED_DATASET_COUNT = 3;
const ORBIT_DOT_DEGREES = [0, 60, 120, 180, 240, 300];
const ORBIT_DOT_RADIUS = 130;
const ORBIT_DOT_BASE_DURATION = 2;
const ORBIT_DOT_STAGGER = 0.3;
const ORBIT_DOT_SIZE = 3;

function Particle({ style }: { style: React.CSSProperties }) {
  return (
    <div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: PARTICLE_SIZE,
        height: PARTICLE_SIZE,
        background: 'rgba(201,168,76,0.6)',
        boxShadow: '0 0 8px rgba(201,168,76,0.8)',
        animation: `float ${PARTICLE_ANIMATION_MIN_DURATION + Math.random() * PARTICLE_ANIMATION_DURATION_RANGE}s ease-in-out infinite`,
        animationDelay: `${Math.random() * PARTICLE_ANIMATION_DELAY_MAX}s`,
        ...style,
      }}
    />
  );
}

/* ── Animated stat card ── */
function StatCard({
  value,
  label,
  prefix = '',
  suffix = '',
  decimals = 0,
  locale = 'en-US',
}: {
  value: number;
  label: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  locale?: string;
}) {
  const animated = useCountUp(value, 2200, decimals);
  return (
    <div className="glass-card-gold px-8 py-6 text-center flex-1 min-w-[160px]">
      <div className="stat-number text-3xl md:text-4xl text-gold-gradient mb-1">
        {prefix}
        {decimals > 0 ? animated.toFixed(decimals) : Math.round(animated).toLocaleString(locale)}
        {suffix}
      </div>
      <p className="text-sm text-foreground-muted font-body">{label}</p>
    </div>
  );
}

/* ── How it works step ── */
function Step({
  number,
  title,
  desc,
  icon: Icon,
}: {
  number: string;
  title: string;
  desc: string;
  icon: React.ElementType;
}) {
  return (
    <div className="flex flex-col items-center text-center group">
      <div className="relative mb-6">
        <div className="w-16 h-16 rounded-2xl bg-gold/10 border border-gold/25 flex items-center justify-center group-hover:border-gold/50 group-hover:shadow-gold transition-all duration-300">
          <Icon className="w-7 h-7 text-gold" />
        </div>
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-gold text-void text-xs font-bold font-body flex items-center justify-center">
          {number}
        </div>
      </div>
      <h3 className="font-display font-semibold text-lg text-foreground mb-2">{title}</h3>
      <p className="text-sm text-foreground-muted font-body leading-relaxed max-w-[220px]">
        {desc}
      </p>
    </div>
  );
}

export default function LandingPage() {
  const { locale, t } = useI18n();
  const [stats, setStats] = useState({
    totalDatasets: 0,
    totalQueries: 0,
    totalUsdcEarned: 0,
  });
  const [featured, setFeatured] = useState<DatasetMeta[]>([]);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = () => setRetryCount(c => c + 1);

  useEffect(() => {
    setFeaturedLoading(true);
    api
      .getStats()
      .then(data => {
        setStats(data as { totalDatasets: number; totalQueries: number; totalUsdcEarned: number });
        setStatsError(null);
      })
      .catch((err: unknown) => {
        setStatsError(err instanceof Error ? err.message : 'Failed to load statistics.');
      });
    api
      .getDatasets()
      .then(ds => {
        setFeatured(
          (
            ds as {
              data: {
                id: string;
                name: string;
                description: string;
                type: string;
                pricePerQuery: number;
                priceCurrency: 'USDC' | 'USD';
                paymentToken: 'USDC' | 'EURC' | 'XLM';
                sellerWallet: string;
                queriesServed: number;
                totalEarned: number;
                createdAt: string;
                thumbnail?: string | undefined;
              }[];
            }
          ).data.slice(0, FEATURED_DATASET_COUNT),
        );
        setFeaturedError(null);
      })
      .catch((err: unknown) => {
        setFeaturedError(err instanceof Error ? err.message : 'Failed to load featured datasets.');
      })
      .finally(() => setFeaturedLoading(false));
    const timer = setTimeout(() => setLoaded(true), HERO_FADE_IN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retryCount]);

  // Generate particles positions once
  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    key: i,
    style: {
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      opacity: PARTICLE_OPACITY_BASE + Math.random() * PARTICLE_OPACITY_VARIANCE,
    },
  }));

  return (
    <div className="min-h-screen">
      {/* ── HERO ── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-24 pb-20">
        {/* Background patterns */}
        <div className="absolute inset-0 pattern-kente" />
        <div className="absolute inset-0 bg-gradient-to-b from-void via-void/95 to-void-2" />

        {/* Radial glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 50% at 50% 40%, rgba(201,168,76,0.07) 0%, transparent 70%)',
          }}
        />

        {/* Floating particles */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {particles.map(p => (
            <Particle key={p.key} style={p.style} />
          ))}
        </div>

        {/* Hero content */}
        <div
          className={clsx(
            'relative z-10 text-center px-4 max-w-5xl mx-auto transition-all duration-700',
            loaded ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8',
          )}
        >
          {/* Eyebrow */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-gold/25 bg-gold/5 mb-8">
            <Star className="w-3.5 h-3.5 text-gold" />
            <span className="text-xs font-body font-medium text-gold tracking-widest uppercase">
              {t('landing.eyebrow')}
            </span>
          </div>

          {/* Headline */}
          <h1 className="font-display text-5xl md:text-7xl lg:text-8xl font-bold text-foreground mb-6 leading-[1.05]">
            {t('landing.headline.lineOne')}
            <br />
            <span className="text-gold-gradient">{t('landing.headline.lineTwo')}</span>
            <br />
            {t('landing.headline.lineThree')}
          </h1>

          {/* Sub */}
          <p className="text-lg md:text-xl text-foreground-muted font-body max-w-2xl mx-auto mb-12 leading-relaxed">
            {t('landing.subheading')}
          </p>

          {/* CTAs */}
          <div
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
            data-tour="hero-cta"
          >
            <Link
              to="/sell"
              className="btn-gold text-base px-8 py-4 flex items-center gap-2 shadow-gold-md"
            >
              {t('common.actions.listData')}
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/marketplace"
              className="btn-ghost text-base px-8 py-4 flex items-center gap-2"
            >
              {t('common.actions.browseMarketplace')}
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>

          {/* Stats error notice */}
          {statsError && (
            <div className="flex flex-col items-center gap-2 mb-2">
              <p className="text-xs text-red-400 font-body text-center opacity-75">{statsError}</p>
              <button onClick={retry} className="text-xs text-gold hover:underline font-body">
                Retry
              </button>
            </div>
          )}

          {/* Stats bar */}
          <div className="flex flex-wrap justify-center gap-4">
            <StatCard
              value={stats.totalDatasets}
              label={t('landing.stats.datasetsListed')}
              locale={locale}
            />
            <StatCard
              value={stats.totalQueries}
              label={t('landing.stats.queriesSold')}
              locale={locale}
            />
            <StatCard
              value={stats.totalUsdcEarned}
              label={t('landing.stats.usdcEarned')}
              prefix="$"
              decimals={2}
              locale={locale}
            />
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-bounce">
          <div className="w-px h-8 bg-gradient-to-b from-transparent to-gold/50" />
          <div className="w-1.5 h-1.5 rounded-full bg-gold/50" />
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="py-24 relative">
        <div className="absolute inset-0 pattern-bg" />
        <div className="relative max-w-6xl mx-auto px-4">
          <div className="text-center mb-16">
            <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-3">
              {t('landing.flow.eyebrow')}
            </p>
            <h2 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-4">
              {t('landing.flow.title')}
            </h2>
            <p className="text-foreground-muted font-body max-w-xl mx-auto">
              {t('landing.flow.body')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative">
            {/* Connector lines */}
            <div className="hidden md:block absolute top-8 left-1/3 right-1/3 h-px bg-gradient-to-r from-transparent via-gold/30 to-transparent" />

            <Step
              number="1"
              icon={Upload}
              title={t('landing.flow.steps.upload.title')}
              desc={t('landing.flow.steps.upload.description')}
            />
            <Step
              number="2"
              icon={Shield}
              title={t('landing.flow.steps.escrow.title')}
              desc={t('landing.flow.steps.escrow.description')}
            />
            <Step
              number="3"
              icon={TrendingUp}
              title={t('landing.flow.steps.earn.title')}
              desc={t('landing.flow.steps.earn.description')}
            />
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="py-24 bg-void-2">
        <div className="max-w-6xl mx-auto px-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-3">
                {t('landing.features.eyebrow')}
              </p>
              <h2 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-6 leading-tight">
                {t('landing.features.titleStart')}{' '}
                <em className="text-gold not-italic">{t('landing.features.titleAccent')}</em>
              </h2>
              <p className="text-foreground-muted font-body text-lg leading-relaxed mb-8">
                {t('landing.features.body')}
              </p>
              <div className="flex flex-col gap-4">
                {[
                  {
                    icon: Zap,
                    label: t('landing.features.items.micropayments.label'),
                    desc: t('landing.features.items.micropayments.description'),
                  },
                  {
                    icon: Shield,
                    label: t('landing.features.items.escrow.label'),
                    desc: t('landing.features.items.escrow.description'),
                  },
                  {
                    icon: Globe,
                    label: t('landing.features.items.marketplace.label'),
                    desc: t('landing.features.items.marketplace.description'),
                  },
                  {
                    icon: Activity,
                    label: t('landing.features.items.earnings.label'),
                    desc: t('landing.features.items.earnings.description'),
                  },
                ].map(({ icon: Icon, label, desc }) => (
                  <div key={label} className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon className="w-5 h-5 text-gold" />
                    </div>
                    <div>
                      <p className="font-body font-semibold text-foreground text-sm mb-0.5">
                        {label}
                      </p>
                      <p className="font-body text-sm text-foreground-muted">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Visual vault */}
            <div className="relative flex items-center justify-center">
              <div className="relative w-80 h-80">
                {/* Outer ring */}
                <div
                  className="absolute inset-0 rounded-full border border-gold/15 animate-spin-slow"
                  style={{ animationDuration: '20s' }}
                />
                {/* Middle ring */}
                <div
                  className="absolute inset-8 rounded-full border border-gold/20"
                  style={{ animation: 'spin 15s linear infinite reverse' }}
                />
                {/* Inner glow */}
                <div className="absolute inset-16 rounded-full bg-gold/5 border border-gold/30 flex items-center justify-center">
                  <div className="text-center">
                    <Lock className="w-10 h-10 text-gold mx-auto mb-2" />
                    <p className="text-xs text-gold font-body font-medium">
                      {t('landing.features.vaultSecured')}
                    </p>
                  </div>
                </div>
                {/* Orbiting dots */}
                {ORBIT_DOT_DEGREES.map((deg, i) => (
                  <div
                    key={i}
                    className="absolute w-3 h-3 rounded-full bg-gold/60"
                    style={{
                      top: `calc(50% + ${Math.sin((deg * Math.PI) / 180) * ORBIT_DOT_RADIUS}px - ${ORBIT_DOT_SIZE + 2}px)`,
                      left: `calc(50% + ${Math.cos((deg * Math.PI) / 180) * ORBIT_DOT_RADIUS}px - ${ORBIT_DOT_SIZE + 2}px)`,
                      boxShadow: '0 0 8px rgba(201,168,76,0.8)',
                      animation: `pulseGold ${ORBIT_DOT_BASE_DURATION + i * ORBIT_DOT_STAGGER}s ease-in-out infinite`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured datasets error notice */}
      {featuredError && (
        <section className="py-6">
          <div className="max-w-6xl mx-auto px-4 text-center flex flex-col items-center gap-2">
            <p className="text-sm text-red-400 font-body opacity-75">{featuredError}</p>
            <button onClick={retry} className="text-sm text-gold hover:underline font-body">
              Retry
            </button>
          </div>
        </section>
      )}

      {/* ── FEATURED DATASETS ── */}
      {!featuredError && (featuredLoading || featured.length > 0) && (
        <section className="py-24 relative">
          <div className="absolute inset-0 pattern-dense" />
          <div className="relative max-w-6xl mx-auto px-4">
            <div className="flex items-end justify-between mb-12">
              <div>
                <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-3">
                  {t('landing.featured.eyebrow')}
                </p>
                <h2 className="font-display text-4xl md:text-5xl font-bold text-foreground">
                  {t('landing.featured.title')}
                </h2>
              </div>
              <Link
                to="/marketplace"
                className="hidden md:flex btn-ghost items-center gap-2 text-sm"
              >
                {t('common.actions.viewAll')}
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {featuredLoading
                ? Array.from({ length: FEATURED_DATASET_COUNT }).map((_, i) => (
                    <DatasetCardSkeleton key={i} />
                  ))
                : featured.map(ds => <DatasetCard key={ds.id} dataset={ds} onBuy={() => {}} />)}
            </div>

            {!featuredLoading && (
              <div className="text-center mt-10">
                <Link
                  to="/marketplace"
                  className="btn-gold text-base px-8 py-4 inline-flex items-center gap-2"
                >
                  <Database className="w-5 h-5" />
                  {t('landing.featured.browseAll')}
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── CTA BANNER ── */}
      <section className="py-24 relative overflow-hidden">
        <div className="absolute inset-0 bg-void-2" />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 50%, rgba(201,168,76,0.08) 0%, transparent 70%)',
          }}
        />
        <div className="relative max-w-3xl mx-auto px-4 text-center">
          <h2 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-6">
            {t('landing.cta.titleStart')}{' '}
            <span className="text-gold-gradient">{t('landing.cta.titleAccent')}</span>
          </h2>
          <p className="text-foreground-muted font-body text-lg mb-10">{t('landing.cta.body')}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/sell"
              className="btn-gold text-base px-10 py-4 flex items-center justify-center gap-2 shadow-gold-lg"
            >
              {t('common.actions.startSellingNow')}
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/marketplace"
              className="btn-ghost text-base px-8 py-4 flex items-center justify-center gap-2"
            >
              {t('common.actions.exploreMarketplace')}
            </Link>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-border/40 py-12">
        <div className="max-w-6xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gold/10 border border-gold/30 flex items-center justify-center">
              <Database className="w-4 h-4 text-gold" />
            </div>
            <span className="font-display font-semibold text-foreground">{t('nav.brand')}</span>
          </div>
          <p className="text-xs text-muted-2 font-body">{t('landing.footer.tagline')}</p>
          <div className="flex gap-6">
            <Link
              to="/marketplace"
              className="text-xs text-foreground-muted hover:text-gold transition-colors font-body"
            >
              {t('nav.marketplace')}
            </Link>
            <Link
              to="/sell"
              className="text-xs text-foreground-muted hover:text-gold transition-colors font-body"
            >
              {t('nav.sell')}
            </Link>
            <Link
              to="/dashboard"
              className="text-xs text-foreground-muted hover:text-gold transition-colors font-body"
            >
              {t('nav.dashboard')}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
