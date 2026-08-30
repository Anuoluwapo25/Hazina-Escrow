import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from './ToastProvider';
import { useToastContext } from './useToastContext';
import type { AccessPassPlan } from '../../lib/api';

const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

const subscribeToDataset = vi.fn();
const renewSubscription = vi.fn();
vi.mock('../../lib/accessPass', () => ({
  subscribeToDataset: (...args: unknown[]) => subscribeToDataset(...args),
  renewSubscription: (...args: unknown[]) => renewSubscription(...args),
}));

vi.mock('./useToastContext', async () => {
  const actual = await vi.importActual<typeof import('./useToastContext')>('./useToastContext');
  return {
    ...actual,
    useToastContext: vi.fn(),
  };
});

const PLAN: AccessPassPlan = {
  planId: 0,
  datasetId: 'ds-subs',
  seller: `G${'S'.repeat(55)}`,
  pricePerPeriodStroops: '500000',
  pricePerPeriod: 0.05,
  periodSeconds: 604_800,
  maxSeats: 25,
  active: true,
  seatsUsed: 24,
  seatsLeft: 1,
};

function renderCard(props: Partial<Parameters<typeof SubscriptionPlanCard>[0]> = {}) {
  return render(
    <I18nProvider initialLocale="en">
      <ToastProvider>
        <SubscriptionPlanCard plans={[PLAN]} passStatus="none" {...props} />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('SubscriptionPlanCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useToastContext as ReturnType<typeof vi.fn>).mockReturnValue({
      success: vi.fn(),
      error: vi.fn(),
      toast: vi.fn(),
    });
    subscribeToDataset.mockResolvedValue({ txHash: 'a'.repeat(64), buyer: 'G', planId: 0 });
    renewSubscription.mockResolvedValue({ txHash: 'b'.repeat(64), buyer: 'G' });
  });

  it('renders nothing when the dataset has no plans', () => {
    const { container } = renderCard({ plans: [] });
    expect(container.querySelector('[data-testid="subscription-plan-card"]')).toBeNull();
  });

  it('lists price, period and remaining seats', () => {
    renderCard();
    expect(screen.getByText('$0.05')).toBeTruthy();
    expect(screen.getByText(/week/i)).toBeTruthy();
    expect(screen.getByText(/1 of 25 seats left/)).toBeTruthy();
  });

  it('disables the CTA when the plan is sold out', () => {
    renderCard({ plans: [{ ...PLAN, seatsUsed: 25, seatsLeft: 0 }] });
    const cta = screen.getByRole('button', { name: /sold out/i }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('disables the CTA when the plan is inactive', () => {
    renderCard({ plans: [{ ...PLAN, active: false }] });
    expect(
      (screen.getByRole('button', { name: /unavailable/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('runs the sign+submit flow exactly once on click and refreshes access state', async () => {
    const onSubscribed = vi.fn();
    renderCard({ onSubscribed });

    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => {
      expect(subscribeToDataset).toHaveBeenCalledTimes(1);
    });
    expect(subscribeToDataset).toHaveBeenCalledWith('ds-subs', 0);
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['access-pass'] });
    });
    expect(onSubscribed).toHaveBeenCalled();
  });

  it('offers a Renew action while a pass is active', async () => {
    renderCard({ passStatus: 'active' });

    const renew = screen.getByRole('button', { name: /renew/i });
    fireEvent.click(renew);

    await waitFor(() => {
      expect(renewSubscription).toHaveBeenCalledTimes(1);
    });
    expect(renewSubscription).toHaveBeenCalledWith('ds-subs');
  });

  it('labels the CTA as resubscribe when the previous pass expired', () => {
    renderCard({ passStatus: 'expired' });
    expect(
      (screen.getByRole('button', { name: /resubscribe/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('surfaces failures through an error toast without crashing', async () => {
    const errorToast = vi.fn();
    (useToastContext as ReturnType<typeof vi.fn>).mockReturnValue({
      success: vi.fn(),
      error: errorToast,
      toast: vi.fn(),
    });
    subscribeToDataset.mockRejectedValue(new Error('All seats for this plan are taken'));

    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        expect.anything(),
        'All seats for this plan are taken',
      );
    });
  });
});
