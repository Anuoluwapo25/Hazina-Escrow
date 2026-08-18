import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Navbar from './components/layout/Navbar';
import OnboardingTour from './components/OnboardingTour';
import LandingPage from './pages/LandingPage';
import MarketplacePage from './pages/MarketplacePage';
import DatasetDetailPage from './pages/DatasetDetailPage';
import SellPage from './pages/SellPage';
import DashboardPage from './pages/DashboardPage';
import AgentPage from './pages/AgentPage';
import TermsPage from './pages/TermsPage';
import ClaimPage from './pages/ClaimPage';
import AdminClaimablesPage from './pages/AdminClaimablesPage';
import SolvencyPage from './pages/SolvencyPage';
import { useI18n } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ui/ToastProvider';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

import { Helmet } from 'react-helmet-async';

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Helmet defaultTitle="Hazina — Data Escrow Marketplace" titleTemplate="%s | Hazina">
          <meta
            name="description"
            content="Decentralized data escrow and research platform using Stellar micropayments."
          />
        </Helmet>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-gold focus:text-void focus:rounded-lg focus:font-semibold focus:outline-none focus:ring-2 focus:ring-gold-light"
        >
          Skip to content
        </a>
        <ScrollToTop />
        <Navbar />
        <OnboardingTour />
        <main id="main-content" tabIndex={-1}>
          <Routes>
            <Route
              path="/"
              element={
                <RouteBoundary label="Landing">
                  <LandingPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/marketplace/:datasetId"
              element={
                <RouteBoundary label="Dataset detail">
                  <DatasetDetailPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/marketplace"
              element={
                <RouteBoundary label="Marketplace">
                  <MarketplacePage />
                </RouteBoundary>
              }
            />
            <Route
              path="/sell"
              element={
                <RouteBoundary label="Sell">
                  <SellPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/dashboard"
              element={
                <RouteBoundary label="Dashboard">
                  <DashboardPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/terms"
              element={
                <RouteBoundary label="Terms">
                  <TermsPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/agent"
              element={
                <RouteBoundary label="Agent">
                  <AgentPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/claim"
              element={
                <RouteBoundary label="Claim">
                  <ClaimPage />
                </RouteBoundary>
              }
            />
            <Route
              path="/admin/claimables"
              element={
                <RouteBoundary label="Admin claimables">
                  <AdminClaimablesPage />
              path="/solvency"
              element={
                <RouteBoundary label="Solvency">
                  <SolvencyPage />
                </RouteBoundary>
              }
            />
            <Route
              path="*"
              element={
                <RouteBoundary>
                  <NotFound />
                </RouteBoundary>
              }
            />
          </Routes>
        </main>
      </BrowserRouter>
    </ToastProvider>
  );
}

function RouteBoundary({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ErrorBoundary label={label} onReset={() => window.location.reload()}>
      {children}
    </ErrorBoundary>
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen pt-28 flex items-center justify-center text-center px-4">
      <div>
        <p className="font-display text-8xl font-bold text-gold/20 mb-4">404</p>
        <h1 className="font-display text-3xl font-bold text-foreground mb-3">
          {t('notFound.title')}
        </h1>
        <p className="text-foreground-muted font-body mb-8">{t('notFound.body')}</p>
        <a href="/" className="btn-gold px-8 py-3 text-sm inline-block">
          {t('common.actions.goHome')}
        </a>
      </div>
    </div>
  );
}
