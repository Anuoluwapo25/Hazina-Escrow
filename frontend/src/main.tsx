import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HelmetProvider } from 'react-helmet-async';
import App from './App';
import './index.css';
import { I18nProvider } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './context/ThemeProvider';
import { initEnv } from './lib/env';

// Validate required environment variables before mounting the app.
// If any are missing this throws immediately with a descriptive message
// rather than causing cryptic runtime errors later.
try {
  initEnv();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  document.body.innerHTML = `<pre style="font-family:monospace;padding:2rem;color:#ef4444;white-space:pre-wrap">${message}</pre>`;
  throw err;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <HelmetProvider>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </I18nProvider>
        </QueryClientProvider>
      </HelmetProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
