import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CuratorBundlePage from './CuratorBundlePage';
import { I18nProvider } from '../i18n';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getDatasets: vi.fn(),
    createBundle: vi.fn(),
  },
}));

const SELLER_A = `G${'A'.repeat(55)}`;
const SELLER_B = `G${'B'.repeat(55)}`;
const CURATOR = `G${'C'.repeat(55)}`;

const catalog = {
  data: [
    {
      id: 'ds-whale',
      name: 'Whale Movements',
      description: 'Whale wallet flows',
      type: 'whale-wallets',
      pricePerQuery: 0.05,
      sellerWallet: SELLER_A,
      queriesServed: 10,
      totalEarned: 1,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'ds-risk',
      name: 'Wallet Risk Scores',
      description: 'Risk scoring',
      type: 'risk-scores',
      pricePerQuery: 0.03,
      sellerWallet: SELLER_B,
      queriesServed: 5,
      totalEarned: 0.5,
      createdAt: new Date().toISOString(),
    },
  ],
  total: 2,
  page: 1,
  totalPages: 1,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <MemoryRouter>
            <CuratorBundlePage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </HelmetProvider>,
  );
}

describe('CuratorBundlePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDatasets).mockResolvedValue(catalog);
  });

  it('disables submit until required fields and at least one dataset are set', async () => {
    renderPage();
    await screen.findByText('Whale Movements');

    const submit = screen.getByRole('button', { name: /Publish Bundle/i });
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('e.g. DeFi Risk Pack'), {
      target: { value: 'DeFi Risk Pack' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Describe what buyers get and why these datasets belong together...',
      ),
      { target: { value: 'A great combo of datasets.' } },
    );
    fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
      target: { value: CURATOR },
    });

    // Still disabled — no dataset picked yet.
    expect(submit.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByText('Whale Movements'));

    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('adding a dataset always keeps the split summing to exactly 100%', async () => {
    renderPage();
    await screen.findByText('Whale Movements');

    expect(screen.getByText('Splits sum to exactly 100%')).toBeTruthy();

    fireEvent.click(screen.getByText('Whale Movements'));
    expect(screen.getByText('Splits sum to exactly 100%')).toBeTruthy();

    fireEvent.click(screen.getByText('Wallet Risk Scores'));
    expect(screen.getByText('Splits sum to exactly 100%')).toBeTruthy();
  });

  it('removing a dataset takes it out of the picker-selected list and rebalances to 100%', async () => {
    renderPage();
    await screen.findByText('Whale Movements');

    fireEvent.click(screen.getByText('Whale Movements'));
    await screen.findByLabelText('Remove Whale Movements');

    fireEvent.click(screen.getByLabelText('Remove Whale Movements'));

    expect(screen.queryByLabelText('Remove Whale Movements')).toBeNull();
    expect(screen.getByText('Splits sum to exactly 100%')).toBeTruthy();
    // It's back in the "available to add" picker list.
    expect(screen.getByText('Whale Movements')).toBeTruthy();
  });

  it('submits the bundle with the curator wallet, price, and component shares', async () => {
    vi.mocked(api.createBundle).mockResolvedValue({
      id: 'bundle-1',
      name: 'DeFi Risk Pack',
      description: 'A great combo of datasets.',
      curatorWallet: CURATOR,
      totalPrice: 0.12,
      curatorFeeBps: 5000,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      components: [
        {
          id: 'c1',
          bundleId: 'bundle-1',
          datasetId: 'ds-whale',
          shareBps: 5000,
          position: 0,
          createdAt: '',
        },
      ],
    });

    renderPage();
    await screen.findByText('Whale Movements');

    fireEvent.change(screen.getByPlaceholderText('e.g. DeFi Risk Pack'), {
      target: { value: 'DeFi Risk Pack' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Describe what buyers get and why these datasets belong together...',
      ),
      { target: { value: 'A great combo of datasets.' } },
    );
    fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
      target: { value: CURATOR },
    });
    fireEvent.click(screen.getByText('Whale Movements'));

    fireEvent.click(screen.getByRole('button', { name: /Publish Bundle/i }));

    await waitFor(() => expect(api.createBundle).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.createBundle).mock.calls[0];
    if (!call) throw new Error('Expected api.createBundle to have been called');
    const payload = call[0];
    expect(payload.name).toBe('DeFi Risk Pack');
    expect(payload.curatorWallet).toBe(CURATOR);
    expect(payload.components).toEqual([{ datasetId: 'ds-whale', shareBps: 5000 }]);
    expect(payload.curatorFeeBps).toBe(5000);

    await screen.findByText('Bundle published!');
  });

  it('shows an inline error when creation fails', async () => {
    vi.mocked(api.createBundle).mockRejectedValue(
      new Error('curatorWallet does not match request body'),
    );

    renderPage();
    await screen.findByText('Whale Movements');

    fireEvent.change(screen.getByPlaceholderText('e.g. DeFi Risk Pack'), {
      target: { value: 'DeFi Risk Pack' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Describe what buyers get and why these datasets belong together...',
      ),
      { target: { value: 'A great combo of datasets.' } },
    );
    fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
      target: { value: CURATOR },
    });
    fireEvent.click(screen.getByText('Whale Movements'));
    fireEvent.click(screen.getByRole('button', { name: /Publish Bundle/i }));

    await screen.findByText('curatorWallet does not match request body');
  });
});
