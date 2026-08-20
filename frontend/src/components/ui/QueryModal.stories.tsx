import type { Meta, StoryObj } from '@storybook/react';
import QueryModal from './QueryModal';
import { DatasetMeta } from '../../lib/api';

const meta: Meta<typeof QueryModal> = {
  title: 'UI/QueryModal',
  component: QueryModal,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof QueryModal>;

const mockDataset: DatasetMeta = {
  id: 'ds-1',
  name: 'Ethereum Whale Wallets Q1 2024',
  description: 'Top 500 ETH holders with transaction patterns and risk scores',
  type: 'whale-wallets',
  pricePerQuery: 2.5,
  priceCurrency: 'USDC',
  paymentToken: 'USDC',
  sellerWallet: 'GAXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  queriesServed: 1247,
  totalEarned: 2967.25,
  createdAt: '2024-01-15T10:00:00Z',
};

export const Default: Story = {
  args: {
    dataset: mockDataset,
    onClose: () => console.log('Modal closed'),
    onSuccess: updated => console.log('Success:', updated),
  },
};

export const TradingSignals: Story = {
  args: {
    dataset: {
      ...mockDataset,
      id: 'ds-2',
      name: 'BTC/USD Trading Signals',
      description: 'Real-time trading signals with 78% accuracy rate',
      type: 'trading-signals',
      pricePerQuery: 5.0,
    },
    onClose: () => console.log('Modal closed'),
    onSuccess: updated => console.log('Success:', updated),
  },
};
