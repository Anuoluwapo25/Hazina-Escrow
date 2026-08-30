import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarketplacePage from './MarketplacePage';
import { I18nProvider } from '../i18n';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getDatasets: vi.fn(),
    search: vi.fn(),
  },
}));

vi.mock('../hooks/useTransactionWebSocket', () => ({
  useTransactionWebSocket: vi.fn(() => ({
    connected: false,
    error: null,
    subscribe: vi.fn(),
  })),
}));

type DatasetResponse = Awaited<ReturnType<typeof api.getDatasets>>;

const defaultDatasets: DatasetResponse = {
  data: [
    {
      id: 'ds-1',
      name: 'Test Dataset 1',
      description: 'A sample dataset',
      type: 'whale-wallets',
      pricePerQuery: 0.05,
      sellerWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      queriesServed: 10,
      totalEarned: 0.5,
      createdAt: new Date().toISOString(),
    },
  ],
  total: 1,
  page: 1,
  totalPages: 1,
};

function renderMarketplacePage(initialEntries: string[] = ['/marketplace']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={initialEntries}>
            <MarketplacePage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </HelmetProvider>,
  );
}

type SearchResponse = Awaited<ReturnType<typeof api.search>>;

const emptySearchResponse: SearchResponse = {
  query: 'whale',
  results: [],
  total: 0,
  page: 1,
  limit: 12,
  mode: 'hybrid',
  reranked: false,
};

describe('MarketplacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDatasets).mockResolvedValue(defaultDatasets);
    vi.mocked(api.search).mockResolvedValue(emptySearchResponse);
  });

  it('shows dataset skeletons while the initial fetch is pending', async () => {
    let resolveDatasets!: (value: DatasetResponse) => void;
    vi.mocked(api.getDatasets).mockReturnValue(
      new Promise<DatasetResponse>(resolve => {
        resolveDatasets = resolve;
      }),
    );

    const { container } = renderMarketplacePage(['/marketplace']);

    expect(container.querySelectorAll('.glass-card.p-6.animate-pulse')).toHaveLength(8);

    resolveDatasets(defaultDatasets);

    await screen.findByText('Test Dataset 1');
  });

  it('initializes pagination from the URL query string', async () => {
    renderMarketplacePage(['/marketplace?page=2']);

    await waitFor(() => {
      expect(api.getDatasets).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 12 }));
    });
  });

  it('calls api.getDatasets (not api.search) when there is no search term', async () => {
    renderMarketplacePage(['/marketplace']);

    await waitFor(() => {
      expect(api.getDatasets).toHaveBeenCalled();
    });
    expect(api.search).not.toHaveBeenCalled();
  });

  it('calls api.search (not api.getDatasets) when a search term is present in the URL', async () => {
    vi.mocked(api.search).mockResolvedValue({
      ...emptySearchResponse,
      results: [
        {
          id: 'ds-whale',
          name: 'Whale Wallet Movements',
          description: 'Tracks large transfers',
          type: 'whale-wallets',
          pricePerQuery: 1,
          queriesServed: 5,
          score: 0.82,
          matchedBecause: 'Semantically related to "large holder activity"',
        },
      ],
      total: 1,
    });

    renderMarketplacePage(['/marketplace?q=large%20holder%20activity']);

    await waitFor(() => {
      expect(api.search).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'large holder activity', explain: true }),
      );
    });
    expect(api.getDatasets).not.toHaveBeenCalled();
  });

  it('renders matchedBecause on a card when the search result includes it', async () => {
    vi.mocked(api.search).mockResolvedValue({
      ...emptySearchResponse,
      results: [
        {
          id: 'ds-whale',
          name: 'Whale Wallet Movements',
          description: 'Tracks large transfers',
          type: 'whale-wallets',
          pricePerQuery: 1,
          queriesServed: 5,
          score: 0.82,
          matchedBecause: 'Semantically related to "large holder activity"',
        },
      ],
      total: 1,
    });

    renderMarketplacePage(['/marketplace?q=large%20holder%20activity']);

    await screen.findByText('Whale Wallet Movements');
    expect(screen.getByText('Semantically related to "large holder activity"')).toBeTruthy();
  });

  it('shows the honest search empty state (not the generic filter empty state) when a search returns nothing', async () => {
    vi.mocked(api.search).mockResolvedValue(emptySearchResponse);

    renderMarketplacePage(['/marketplace?q=nonexistent%20query']);

    await screen.findByText('No matches for your search');
    expect(screen.queryByText('No datasets found')).toBeNull();
  });

  it('shows the generic filter empty state (not the search empty state) when browsing with no results', async () => {
    vi.mocked(api.getDatasets).mockResolvedValue({ data: [], total: 0, page: 1, totalPages: 1 });

    renderMarketplacePage(['/marketplace']);

    await screen.findByText('No datasets found');
    expect(screen.queryByText('No matches for your search')).toBeNull();
  });

  it.skip('updates the page query string when the user navigates pages', async () => {
    vi.mocked(api.getDatasets)
      .mockResolvedValueOnce(defaultDatasets)
      .mockResolvedValueOnce(defaultDatasets);

    renderMarketplacePage(['/marketplace?page=1']);

    const nextButton = await screen.findByRole('button', { name: /Next/i });
    fireEvent.click(nextButton);

    await waitFor(() => {
      expect(window.location.search).toContain('page=2');
      expect(api.getDatasets).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, limit: 12 }),
      );
    });
  });
});
