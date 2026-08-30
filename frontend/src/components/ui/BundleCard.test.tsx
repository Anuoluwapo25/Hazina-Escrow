import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import BundleCard from './BundleCard';
import { I18nProvider } from '../../i18n';
import type { Bundle } from '../../lib/api';

const CURATOR = `G${'C'.repeat(55)}`;

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'DeFi Risk Pack',
    description: 'Whale + risk + sentiment, one price.',
    curatorWallet: CURATOR,
    totalPrice: 0.12,
    curatorFeeBps: 1000,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    components: [
      {
        id: 'c1',
        bundleId: 'bundle-1',
        datasetId: 'ds-whale',
        shareBps: 4500,
        position: 0,
        createdAt: '',
      },
      {
        id: 'c2',
        bundleId: 'bundle-1',
        datasetId: 'ds-risk',
        shareBps: 3000,
        position: 1,
        createdAt: '',
      },
      {
        id: 'c3',
        bundleId: 'bundle-1',
        datasetId: 'ds-sentiment',
        shareBps: 1500,
        position: 2,
        createdAt: '',
      },
    ],
    degraded: false,
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof BundleCard>> = {}) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <BundleCard bundle={makeBundle()} {...props} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('BundleCard', () => {
  it('shows the bundle badge, price, and component count', () => {
    renderCard();
    expect(screen.getByText('Bundle')).toBeTruthy();
    expect(screen.getByText('$0.12')).toBeTruthy();
    expect(screen.getByText('3 datasets')).toBeTruthy();
  });

  it('reveals per-component splits and the curator fee when expanded', () => {
    renderCard();
    expect(screen.queryByText('45%')).toBeNull();

    fireEvent.click(screen.getByText('View splits'));

    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.getByText('30%')).toBeTruthy();
    expect(screen.getByText('15%')).toBeTruthy();
    expect(screen.getByText('10%')).toBeTruthy(); // curator fee
  });

  it('resolves dataset names when a lookup map is provided, falling back to the raw id otherwise', () => {
    renderCard({ datasetNames: { 'ds-whale': 'Whale Movements' } });
    fireEvent.click(screen.getByText('View splits'));

    expect(screen.getByText('Whale Movements')).toBeTruthy();
    expect(screen.getByText('ds-risk')).toBeTruthy(); // unresolved, falls back to id
  });

  it('shows a degraded banner and disables purchase when the bundle is unavailable', () => {
    renderCard({
      bundle: {
        ...makeBundle(),
        degraded: true,
        degradedReason: 'Component dataset "Whale Movements" has been delisted',
      },
    });

    expect(screen.getByText('Component dataset "Whale Movements" has been delisted')).toBeTruthy();
    const buyButton = screen.getByRole('button', { name: /Buy Bundle/i });
    expect(buyButton.hasAttribute('disabled')).toBe(true);
  });

  it('invokes onBuy with the bundle when the purchase button is clicked', () => {
    const onBuy = vi.fn();
    renderCard({ onBuy });

    fireEvent.click(screen.getByRole('button', { name: /Buy Bundle/i }));

    expect(onBuy).toHaveBeenCalledWith(expect.objectContaining({ id: 'bundle-1' }));
  });
});
