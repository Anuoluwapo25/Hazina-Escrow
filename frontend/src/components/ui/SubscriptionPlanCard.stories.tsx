import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SubscriptionPlanCard from './SubscriptionPlanCard';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from './ToastProvider';
import type { AccessPassPlan } from '../../lib/api';

const queryClient = new QueryClient();

const meta: Meta<typeof SubscriptionPlanCard> = {
  title: 'UI/SubscriptionPlanCard',
  component: SubscriptionPlanCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <ToastProvider>
            <div style={{ width: '22rem' }}>
              <Story />
            </div>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SubscriptionPlanCard>;

const WEEKLY: AccessPassPlan = {
  planId: 0,
  datasetId: 'ds-1',
  seller: 'GSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL4512',
  pricePerPeriodStroops: '500000',
  pricePerPeriod: 0.05,
  periodSeconds: 604_800,
  maxSeats: 25,
  active: true,
  seatsUsed: 11,
  seatsLeft: 14,
};

const MONTHLY: AccessPassPlan = {
  ...WEEKLY,
  planId: 1,
  pricePerPeriodStroops: '1500000',
  pricePerPeriod: 0.15,
  periodSeconds: 2_592_000,
};

export const AvailablePlans: Story = {
  args: {
    plans: [WEEKLY, MONTHLY],
    passStatus: 'none',
  },
};

export const SoldOut: Story = {
  args: {
    plans: [{ ...WEEKLY, seatsUsed: 25, seatsLeft: 0 }],
    passStatus: 'none',
  },
};

export const WithActivePassRenew: Story = {
  args: {
    plans: [WEEKLY],
    passStatus: 'active',
  },
};

export const ExpiredPassResubscribe: Story = {
  args: {
    plans: [WEEKLY],
    passStatus: 'expired',
  },
};
