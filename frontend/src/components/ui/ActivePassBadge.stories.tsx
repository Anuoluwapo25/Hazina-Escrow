import type { Meta, StoryObj } from '@storybook/react';
import ActivePassBadge from './ActivePassBadge';
import { I18nProvider } from '../../i18n';

const meta: Meta<typeof ActivePassBadge> = {
  title: 'UI/ActivePassBadge',
  component: ActivePassBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <I18nProvider initialLocale="en">
        <Story />
      </I18nProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ActivePassBadge>;

export const Active: Story = {
  args: {
    status: 'active',
    expiry: Math.floor(Date.now() / 1000) + 12 * 24 * 3600,
  },
};

export const ExpiringSoon: Story = {
  args: {
    status: 'active',
    expiry: Math.floor(Date.now() / 1000) + 5 * 3600,
  },
};

export const Expired: Story = {
  args: { status: 'expired' },
};

export const Unavailable: Story = {
  args: { status: 'unavailable' },
};
