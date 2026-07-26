import type { Meta, StoryObj } from '@storybook/react';
import WalletConnectButton from './WalletConnectButton';

const meta: Meta<typeof WalletConnectButton> = {
  title: 'UI/WalletConnectButton',
  component: WalletConnectButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <div className="w-80 p-4 glass-card">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WalletConnectButton>;

const mockPayment = {
  paymentAddress: 'GAXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
  amount: 2.5,
  memo: 'haz-ds-123',
};

export const Default: Story = {
  args: {
    payment: mockPayment,
    onTxHash: hash => console.log('Tx hash received:', hash),
    onStatusChange: status => console.log('Status:', status),
    onError: error => console.log('Error:', error),
  },
};

export const SmallAmount: Story = {
  args: {
    payment: {
      ...mockPayment,
      amount: 0.05,
    },
    onTxHash: hash => console.log('Tx hash received:', hash),
    onStatusChange: status => console.log('Status:', status),
  },
};
