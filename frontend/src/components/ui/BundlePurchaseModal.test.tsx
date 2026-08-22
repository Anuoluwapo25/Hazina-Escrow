import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BundlePurchaseModal from './BundlePurchaseModal';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from './ToastProvider';
import type { Bundle, BundlePurchase } from '../../lib/api';

vi.mock('../../lib/bundle', () => ({
  purchaseBundle: vi.fn(),
  confirmBundleDelivery: vi.fn(),
}));

import { purchaseBundle, confirmBundleDelivery } from '../../lib/bundle';

const CURATOR = `G${'C'.repeat(55)}`;
const BUYER = `G${'B'.repeat(55)}`;

const bundle: Bundle = {
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
};

function makePurchase(overrides: Partial<BundlePurchase> = {}): BundlePurchase {
  return {
    id: 'purchase-1',
    bundleId: 'bundle-1',
    buyerWallet: BUYER,
    firstEscrowId: 100,
    escrowIds: [100, 101, 102, 103],
    totalAmount: 0.12,
    status: 'delivered',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderModal(onClose = vi.fn()) {
  return render(
    <I18nProvider initialLocale="en">
      <ToastProvider>
        <BundlePurchaseModal bundle={bundle} onClose={onClose} />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('BundlePurchaseModal', () => {
  it('shows the split breakdown and total price before purchase', () => {
    renderModal();
    expect(screen.getByText('$0.12 USDC')).toBeTruthy();
    expect(screen.getByText('ds-whale')).toBeTruthy();
  });

  it('walks the happy path: purchase -> delivered -> confirm -> released', async () => {
    vi.mocked(purchaseBundle).mockResolvedValue({
      purchase: makePurchase({ status: 'delivered' }),
      buyer: BUYER,
    });
    vi.mocked(confirmBundleDelivery).mockResolvedValue(
      makePurchase({
        status: 'released',
        releaseTxHash: 'release-tx',
        aiSummary: 'Whale accumulation aligns with bullish sentiment across the bundle.',
      }),
    );

    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Buy Bundle/i }));

    const confirmButton = await screen.findByRole('button', { name: /Confirm Receipt/i });
    expect(purchaseBundle).toHaveBeenCalledWith('bundle-1');

    fireEvent.click(confirmButton);

    await screen.findByText('Purchase complete — every seller paid atomically');
    expect(screen.getByText('release-tx')).toBeTruthy();
    expect(
      screen.getByText('Whale accumulation aligns with bullish sentiment across the bundle.'),
    ).toBeTruthy();
    expect(confirmBundleDelivery).toHaveBeenCalledWith('purchase-1', expect.any(Function));
  });

  it('shows the refund message when a component fails to deliver', async () => {
    vi.mocked(purchaseBundle).mockResolvedValue({
      purchase: makePurchase({
        status: 'refunded',
        failureReason:
          'Component dataset ds-sentiment failed to deliver (delisted) — full refund issued',
      }),
      buyer: BUYER,
    });

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Buy Bundle/i }));

    await screen.findByText(
      'Component dataset ds-sentiment failed to deliver (delisted) — full refund issued',
    );
    expect(
      screen.getByText('A component could not be delivered — you were refunded in full'),
    ).toBeTruthy();
  });

  it('shows an inline error and lets the buyer retry when the purchase call throws', async () => {
    vi.mocked(purchaseBundle).mockRejectedValue(new Error('Freighter not installed'));

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Buy Bundle/i }));

    await screen.findByText('Freighter not installed');
    expect(screen.getByRole('button', { name: /Try Again/i })).toBeTruthy();
  });

  it('calls onClose when the close (X) button is clicked', () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
