import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Database,
  BarChart3,
  Upload,
  ShoppingCart,
  Menu,
  X,
  Bot,
  Wallet,
  LogOut,
  Loader2,
} from 'lucide-react';
import { useEffect, useId, useCallback, useState } from 'react';
import clsx from 'clsx';
import { isConnected as freighterIsConnected, getPublicKey } from '@stellar/freighter-api';
import { connectFreighter } from '../../lib/stellarWallets';
import { useStellarAuth } from '../../hooks/useStellarAuth';
import { useToastContext } from '../../components/ui/useToastContext';
import { LocaleSwitcher, useI18n } from '../../i18n';

const NAV_LINKS = [
  {
    to: '/marketplace',
    key: 'nav.marketplace',
    icon: ShoppingCart,
    dataTour: 'marketplace-link',
  },
  { to: '/agent', key: 'nav.agent', icon: Bot, dataTour: 'agent-link' },
  { to: '/sell', key: 'nav.sell', icon: Upload, dataTour: 'sell-link' },
  {
    to: '/dashboard',
    key: 'nav.dashboard',
    icon: BarChart3,
    dataTour: 'dashboard-link',
  },
] as const;

export default function Navbar() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(localStorage.getItem('hazina_wallet'));
  const [signingIn, setSigningIn] = useState(false);
  const { isAuthenticated, signIn, signOut } = useStellarAuth();
  const { toast } = useToastContext();
  const mobileMenuId = useId();
  const desktopWalletLabelId = useId();

  const mobileMenuToggleLabel = mobileOpen ? t('nav.closeMobileMenu') : t('nav.openMobileMenu');

  const truncateAddress = (address: string) => {
    if (!address || address.length < 8) {
      return address;
    }

    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const handleConnect = async () => {
    try {
      const nextPublicKey = await connectFreighter();
      setPublicKey(nextPublicKey);
      localStorage.setItem('hazina_wallet', nextPublicKey);

      // After connecting, immediately run the SEP-10 sign-in so the seller is
      // authenticated for seller-scoped endpoints. If the backend has SEP-10
      // disabled or the wallet refuses, the connection stays (buyers need it)
      // but the session is not created.
      setSigningIn(true);
      try {
        await signIn(nextPublicKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sign-in failed';
        toast({
          title: t('common.actions.sellerSignInFailed'),
          description: message,
          variant: 'error',
        });
      } finally {
        setSigningIn(false);
      }
    } catch (error) {
      console.error('Connection failed:', error);
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  };

  const handleDisconnect = useCallback(() => {
    setPublicKey(null);
    localStorage.removeItem('hazina_wallet');
    signOut();
  }, [signOut]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  useEffect(() => {
    const verifyConnection = async () => {
      if (!publicKey) {
        return;
      }

      try {
        const connected = await freighterIsConnected();
        if (!connected) {
          handleDisconnect();
          return;
        }

        const currentKey = await getPublicKey();
        if (currentKey !== publicKey) {
          handleDisconnect();
        }
      } catch (error) {
        console.warn('Wallet reconnection check failed:', error);
        handleDisconnect();
      }
    };

    void verifyConnection();
  }, [publicKey, handleDisconnect]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="mx-3 mt-3 sm:mx-4 sm:mt-4">
        <nav className="glass-card-gold px-4 py-3 sm:px-5 sm:py-4 xl:px-6 flex items-center justify-between gap-3">
          <Link to="/" className="flex min-w-0 items-center gap-3 group" aria-label="Hazina Home">
            <div className="w-9 h-9 rounded-xl bg-gold/10 border border-gold/30 flex items-center justify-center group-hover:border-gold/60 transition-all duration-300 shrink-0">
              <Database className="w-5 h-5 text-gold" aria-hidden="true" />
            </div>
            <span className="font-display font-semibold text-lg sm:text-xl text-foreground group-hover:text-gold transition-colors duration-300 truncate">
              {t('nav.brand')}
            </span>
          </Link>

          <div className="hidden xl:flex items-center gap-1.5 flex-nowrap">
            {NAV_LINKS.map(({ to, key, icon: Icon, dataTour }) => (
              <NavLink
                key={to}
                to={to}
                data-tour={dataTour}
                className={({ isActive }) =>
                  clsx(
                    'flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2 rounded-xl text-sm font-medium font-body transition-all duration-200',
                    isActive
                      ? 'bg-gold/15 text-gold border border-gold/25'
                      : 'text-foreground-muted hover:text-foreground hover:bg-surface-2',
                  )
                }
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {t(key)}
              </NavLink>
            ))}
          </div>

          <div className="hidden xl:flex items-center gap-3 shrink-0">
            <LocaleSwitcher />

            {publicKey ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gold/10 border border-gold/25 text-gold text-sm font-medium">
                <Wallet className="w-4 h-4" aria-hidden="true" />
                <span id={desktopWalletLabelId} className="font-mono">
                  {truncateAddress(publicKey)}
                </span>
                {isAuthenticated && (
                  <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-semibold whitespace-nowrap">
                    {t('common.actions.sellerSignedIn')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="ml-1 hover:text-white transition-colors"
                  aria-label={t('common.actions.disconnect')}
                  aria-describedby={desktopWalletLabelId}
                  title={t('common.actions.disconnect')}
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={signingIn}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gold/30 text-gold hover:bg-gold/10 transition-all duration-200 text-sm font-medium disabled:opacity-60 disabled:cursor-wait"
              >
                {signingIn ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Wallet className="w-4 h-4" aria-hidden="true" />
                )}
                {signingIn
                  ? t('common.actions.sellerSigningIn')
                  : t('common.actions.connectWallet')}
              </button>
            )}

            <Link to="/marketplace" className="btn-gold text-sm px-4 py-2 whitespace-nowrap">
              {t('common.actions.browseData')}
            </Link>
          </div>

          <button
            type="button"
            className="xl:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gold/15 bg-surface/70 text-foreground-muted hover:text-foreground hover:border-gold/30 transition-colors"
            onClick={() => setMobileOpen(current => !current)}
            aria-expanded={mobileOpen}
            aria-controls={mobileMenuId}
            aria-label={mobileMenuToggleLabel}
          >
            {mobileOpen ? (
              <X className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        </nav>

        <div
          className={clsx(
            'xl:hidden fixed inset-0 z-40 transition-all duration-300',
            mobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          aria-hidden={!mobileOpen}
        >
          <button
            type="button"
            className={clsx(
              'absolute inset-0 bg-void/72 backdrop-blur-sm transition-opacity duration-300',
              mobileOpen ? 'opacity-100' : 'opacity-0',
            )}
            onClick={() => setMobileOpen(false)}
            aria-label={t('nav.closeMobileMenu')}
          />
          <div
            id={mobileMenuId}
            className={clsx(
              'absolute right-3 top-20 bottom-3 left-3 sm:left-auto sm:w-[420px] glass-card-gold p-5 sm:p-6 flex flex-col gap-5 overflow-y-auto transition-all duration-300',
              mobileOpen ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border-gold/15 pb-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.28em] text-gold/70 font-body mb-2">
                  Hazina
                </p>
                <p className="text-sm text-foreground-muted font-body leading-relaxed">
                  {t('common.actions.browseData')}
                </p>
              </div>
              <button
                type="button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gold/15 bg-surface/60 text-foreground-muted hover:text-foreground hover:border-gold/30 transition-colors"
                onClick={() => setMobileOpen(false)}
                aria-label={t('nav.closeMobileMenu')}
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-gold/10 bg-void/25 p-3">
              <LocaleSwitcher className="w-full" />

              {publicKey ? (
                <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 bg-gold/10 border border-gold/25 text-gold">
                  <div className="flex items-center gap-3">
                    <Wallet className="w-5 h-5 shrink-0" aria-hidden="true" />
                    <span className="text-sm font-mono font-medium truncate">
                      {truncateAddress(publicKey)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="p-1 hover:text-white transition-colors"
                    aria-label={t('common.actions.disconnect')}
                  >
                    <LogOut className="w-5 h-5" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={signingIn}
                  className="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-xl border border-gold/30 text-gold hover:bg-gold/10 transition-all text-sm font-medium disabled:opacity-60 disabled:cursor-wait"
                >
                  {signingIn ? (
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Wallet className="w-5 h-5" aria-hidden="true" />
                  )}
                  {signingIn
                    ? t('common.actions.sellerSigningIn')
                    : t('common.actions.connectWallet')}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {NAV_LINKS.map(({ to, key, icon: Icon, dataTour }) => (
                <NavLink
                  key={to}
                  to={to}
                  data-tour={dataTour}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-sm font-medium font-body transition-all duration-200',
                      isActive
                        ? 'bg-gold/15 text-gold border border-gold/25'
                        : 'text-foreground-muted hover:text-foreground hover:bg-surface-2 border border-transparent',
                    )
                  }
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{t(key)}</span>
                  </span>
                  <span className="text-gold/60 text-base" aria-hidden="true">
                    +
                  </span>
                </NavLink>
              ))}
            </div>

            <Link
              to="/marketplace"
              className="btn-gold text-sm text-center mt-auto whitespace-nowrap"
              onClick={() => setMobileOpen(false)}
            >
              {t('common.actions.browseData')}
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
