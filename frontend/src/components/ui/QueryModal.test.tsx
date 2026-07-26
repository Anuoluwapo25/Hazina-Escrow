import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QueryModal from './QueryModal';
import { I18nProvider } from '../../i18n';
import { api } from '../../lib/api';
import * as env from '../../lib/env';
import { ToastProvider } from './ToastProvider';

vi.mock('../../lib/api', () => ({
  api: {
    initiateQuery: vi.fn(),
    demoQuery: vi.fn(),
    verifyPayment: vi.fn(),
  },
}));

vi.mock('../../lib/stellarWallets', async () => {
  const actual = await vi.importActual<typeof import('../../lib/stellarWallets')>(
    '../../lib/stellarWallets',
  );
  return {
    ...actual,
    detectWallets: vi.fn(() => Promise.resolve({ freighter: false, albedo: false })),
    launchStellarWalletProvider: vi.fn(() => Promise.resolve(null)),
  };
});

const dataset = {
  id: 'ds-query-1',
  name: 'Whale Wallet Dataset',
  description: 'Wallet and transfer intelligence',
  type: 'whale-wallets',
  pricePerQuery: 0.05,
  sellerWallet: `G${'A'.repeat(55)}`,
  queriesServed: 12,
  totalEarned: 3.5,
  createdAt: new Date().toISOString(),
};

function renderModal(overrides?: {
  onClose?: () => void;
  onSuccess?: (updated: Partial<typeof dataset> & { id: string }) => void;
}) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onSuccess = overrides?.onSuccess ?? vi.fn();

  render(
    <ToastProvider>
      <I18nProvider initialLocale="en">
        <QueryModal dataset={dataset} onClose={onClose} onSuccess={onSuccess} />
      </I18nProvider>
    </ToastProvider>,
  );

  return { onClose, onSuccess };
}

describe('QueryModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(env, 'isDemoModeEnabled').mockReturnValue(false);
    vi.mocked(api.initiateQuery).mockResolvedValue({
      payment: {
        paymentAddress: `G${'B'.repeat(55)}`,
        amount: dataset.pricePerQuery,
        memo: 'haz-memo-1',
      },
    } as never);
  });

  it('runs the happy-path payment flow in demo mode', async () => {
    const onSuccess = vi.fn();
    vi.mocked(env.isDemoModeEnabled).mockReturnValue(true);
    vi.mocked(api.demoQuery).mockResolvedValueOnce({
      success: true,
      demo: true,
      data: { rows: [1, 2] },
      ai: {
        summary: 'Summary text',
        answer: 'Answer text',
      },
      transaction: {
        hash: 'demo-hash',
        status: 'success',
        deliveryStatus: 'delivered',
        amount: 0.05,
        sellerReceived: 0.0475,
        platformFee: 0.0025,
      },
    });

    renderModal({ onSuccess });
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1');
    });

    // Demo mode is OFF by default — check it to enable demo mode
    fireEvent.click(screen.getByLabelText(/Demo mode/i));

    // Now in demo mode — button reads "Get AI Analysis"
    const analyzeButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Get AI Analysis' }),
    );
    fireEvent.click(analyzeButton);

    await waitFor(() => {
      expect(screen.getByText('Payment Verified')).toBeTruthy();
    });

    expect(api.demoQuery).toHaveBeenCalledWith('ds-query-1', '');
    expect(onSuccess).toHaveBeenCalledWith({
      id: 'ds-query-1',
      queriesServed: 13,
      totalEarned: 3.5,
    });
  });

  it('revokes the Object URL after downloading JSON', async () => {
    vi.mocked(env.isDemoModeEnabled).mockReturnValue(true);
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });

    vi.mocked(api.demoQuery).mockResolvedValueOnce({
      success: true,
      demo: true,
      data: { rows: [1, 2] },
      ai: {
        summary: 'Summary text',
        answer: 'Answer text',
      },
      transaction: {
        hash: 'demo-hash',
        status: 'success',
        deliveryStatus: 'delivered',
        amount: 0.05,
        sellerReceived: 0.0475,
        platformFee: 0.0025,
      },
    });

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1');
    });

    // Check demo mode to enable it
    fireEvent.click(screen.getByLabelText(/Demo mode/i));

    fireEvent.click(screen.getByRole('button', { name: 'Get AI Analysis' }));

    await waitFor(() => {
      expect(screen.getByText('Payment Verified')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));

    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('resets state when reopened after a failed payment attempt', async () => {
    vi.mocked(api.verifyPayment).mockRejectedValueOnce(new Error('Network timeout'));

    const { rerender } = render(
      <ToastProvider>
        <I18nProvider initialLocale="en">
          <QueryModal isOpen={true} dataset={dataset} onClose={vi.fn()} onSuccess={vi.fn()} />
        </I18nProvider>
      </ToastProvider>,
    );

    // Advance to the payment step
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));
    await waitFor(() => expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1'));

    // Enter a tx hash and trigger a failed verification
    fireEvent.change(screen.getByPlaceholderText('Paste your Stellar transaction hash...'), {
      target: { value: 'tx-stale-hash' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Get Data' }));

    await waitFor(() => expect(screen.getByText('Verification Failed')).toBeTruthy());

    // Simulate close: set isOpen=false (component stays mounted, state preserved)
    rerender(
      <ToastProvider>
        <I18nProvider initialLocale="en">
          <QueryModal isOpen={false} dataset={dataset} onClose={vi.fn()} onSuccess={vi.fn()} />
        </I18nProvider>
      </ToastProvider>,
    );

    // Reopen: set isOpen=true — the useEffect should reset all state
    rerender(
      <ToastProvider>
        <I18nProvider initialLocale="en">
          <QueryModal isOpen={true} dataset={dataset} onClose={vi.fn()} onSuccess={vi.fn()} />
        </I18nProvider>
      </ToastProvider>,
    );

    // Modal should be back at the details step with no stale error or tx hash
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Proceed to Payment' })).toBeTruthy(),
    );
    // Scope to the dialog — an error toast from the earlier failure may still
    // be visible on its own timer, independent of the modal's internal state.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText('Verification Failed')).toBeNull();
    expect(within(dialog).queryByText('Network timeout')).toBeNull();
  });

  it('shows error state for failed verification and allows retry', async () => {
    vi.mocked(api.verifyPayment).mockRejectedValueOnce(new Error('Verification failed'));

    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalled();
    });

    // Demo mode is OFF by default — button is "Verify & Get Data" and disabled (no tx hash)
    const verifyButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Verify & Get Data' }),
    );
    expect(verifyButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByPlaceholderText('Paste your Stellar transaction hash...'), {
      target: { value: 'tx-hash-123' },
    });
    expect(verifyButton).toHaveProperty('disabled', false);

    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(screen.getByText('Verification failed')).toBeTruthy();
      expect(screen.getByText('Verification Failed')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByText('Transaction Hash')).toBeTruthy();
  });

  it('hides the demo mode toggle when the feature flag is disabled', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed to Payment' }));

    await waitFor(() => {
      expect(api.initiateQuery).toHaveBeenCalledWith('ds-query-1');
    });

    expect(screen.queryByLabelText(/Demo mode/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Verify & Get Data' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
