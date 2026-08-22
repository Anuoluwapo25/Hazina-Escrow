import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';
import { I18nProvider } from '../i18n';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getDatasets: vi.fn(),
    getTransactions: vi.fn(),
    getSellerAnalytics: vi.fn(),
    getSellerClaimables: vi.fn(),
    getCuratorBundleEarnings: vi.fn(),
    getSellerBundleDashboard: vi.fn(),
    updateDataset: vi.fn(),
    deleteDataset: vi.fn(),
  },
}));

vi.mock('../hooks/useTransactionWebSocket', () => ({
  useTransactionWebSocket: vi.fn(() => ({ connected: false, error: null, subscribe: vi.fn() })),
}));

const SELLER = `G${'A'.repeat(55)}`;

const dataset = {
  id: 'ds-1',
  name: 'Whale Movements',
  description: 'Whale wallet flows',
  type: 'whale-wallets',
  pricePerQuery: 0.05,
  sellerWallet: SELLER,
  queriesServed: 10,
  totalEarned: 1.5,
  createdAt: new Date().toISOString(),
};

function renderDashboard() {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('DashboardPage bundles sections (#615)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDatasets).mockResolvedValue({
      data: [dataset],
      total: 1,
      page: 1,
      totalPages: 1,
    });
    vi.mocked(api.getTransactions).mockResolvedValue([]);
    vi.mocked(api.getSellerAnalytics).mockResolvedValue({
      revenueSeries: [],
      queryVolumeSeries: [],
      datasetBreakdown: [],
      topBuyers: [],
    });
    vi.mocked(api.getSellerClaimables).mockResolvedValue([]);
    vi.mocked(api.getCuratorBundleEarnings).mockResolvedValue([]);
    vi.mocked(api.getSellerBundleDashboard).mockResolvedValue({ bundles: [], earnings: [] });
  });

  it('renders nothing for bundles when the wallet has none, once loaded', async () => {
    renderDashboard();
    await screen.findByText('Whale Movements');
    expect(screen.queryByText('Your Bundles')).toBeNull();
    expect(screen.queryByText('Bundles Including Your Data')).toBeNull();
  });

  it('shows curator earnings once this wallet has curated bundles', async () => {
    vi.mocked(api.getCuratorBundleEarnings).mockResolvedValue([
      {
        bundleId: 'bundle-1',
        bundleName: 'DeFi Risk Pack',
        active: true,
        totalPurchases: 3,
        releasedPurchases: 2,
        totalEarned: 0.024,
      },
    ]);

    renderDashboard();
    await screen.findByText('Your Bundles');

    expect(screen.getByText('DeFi Risk Pack')).toBeTruthy();
    expect(screen.getByText('$0.024')).toBeTruthy();
    expect(screen.getByText('3 purchases · 2 released')).toBeTruthy();
  });

  it("shows bundles that include this seller's data, with earnings summed per bundle", async () => {
    vi.mocked(api.getSellerBundleDashboard).mockResolvedValue({
      bundles: [
        {
          id: 'bundle-2',
          name: 'Sentiment Pack',
          description: 'desc',
          curatorWallet: `G${'C'.repeat(55)}`,
          totalPrice: 0.2,
          curatorFeeBps: 1000,
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          components: [],
        },
      ],
      earnings: [
        {
          bundleId: 'bundle-2',
          bundleName: 'Sentiment Pack',
          datasetId: 'ds-1',
          totalEarned: 0.03,
          purchaseCount: 2,
        },
      ],
    });

    renderDashboard();
    await screen.findByText('Bundles Including Your Data');

    expect(screen.getByText('Sentiment Pack')).toBeTruthy();
    expect(screen.getByText('$0.03')).toBeTruthy();
  });
});
