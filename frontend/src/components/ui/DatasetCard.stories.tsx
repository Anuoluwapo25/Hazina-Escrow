import type { Meta, StoryObj } from '@storybook/react';
import DatasetCard from './DatasetCard';
import { DatasetMeta } from '../../lib/api';

const meta: Meta<typeof DatasetCard> = {
  title: 'UI/DatasetCard',
  component: DatasetCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    Story => (
      <div style={{ width: '400px', padding: '20px' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DatasetCard>;

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
    onBuy: dataset => console.log('Buy clicked:', dataset),
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
      queriesServed: 892,
      totalEarned: 4238.0,
    },
    onBuy: dataset => console.log('Buy clicked:', dataset),
  },
};

export const YieldData: Story = {
  args: {
    dataset: {
      ...mockDataset,
      id: 'ds-3',
      name: 'DeFi Yield Opportunities',
      description: 'Curated list of high-yield DeFi protocols with APY tracking',
      type: 'yield-data',
      pricePerQuery: 1.5,
      queriesServed: 2341,
      totalEarned: 3326.42,
    },
    onBuy: dataset => console.log('Buy clicked:', dataset),
  },
};

export const LowActivity: Story = {
  args: {
    dataset: {
      ...mockDataset,
      queriesServed: 12,
      totalEarned: 30.0,
    },
    onBuy: dataset => console.log('Buy clicked:', dataset),
  },
};

export const HighActivity: Story = {
  args: {
    dataset: {
      ...mockDataset,
      queriesServed: 15789,
      totalEarned: 39472.5,
    },
    onBuy: dataset => console.log('Buy clicked:', dataset),
  },
};
