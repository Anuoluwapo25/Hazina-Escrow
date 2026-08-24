/**
 * marketplace.ts — deterministic marketplace seed.
 *
 * The datasets are hand-written rather than faker-generated. `backend/src/seed.ts`
 * uses faker, which is fine for a demo but useless here: the acceptance criterion
 * is byte-identical output across resets, and a chain test that asserts on a
 * dataset price cannot have that price change between runs.
 *
 * Output shape matches what `backend/src/db/seed.ts` reads, so the same file
 * drives both the devnet summary and the backend database.
 */

import { writeFile } from 'node:fs/promises';
import type { DevnetAccount, DevnetRole } from './accounts.ts';

export interface SeedDataset {
  id: string;
  name: string;
  description: string;
  type: string;
  category: string;
  pricePerQuery: number;
  sellerWallet: string;
  data: Record<string, unknown>;
  queriesServed: number;
  totalEarned: number;
  createdAt: string;
  tags: string[];
  live: false;
}

/**
 * A fixed instant for every seeded record. Real timestamps would break the
 * byte-identical guarantee for no benefit — nothing in the devnet reasons about
 * dataset age.
 */
export const SEED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

interface SeedSpec {
  id: string;
  name: string;
  description: string;
  type: string;
  category: string;
  /** Price in whole USDC. */
  pricePerQuery: number;
  seller: DevnetRole;
  tags: string[];
  data: Record<string, unknown>;
}

/**
 * Three datasets, each pinned to a role the chain tests need:
 *   • devnet-whale-flows  → `seller`, the happy-path 95/5 release fixture.
 *   • devnet-yield-curve  → `seller`, the refund/dispute fixture.
 *   • devnet-orphan-feed  → `sellerNoTrustline`, the payout-failure fixture.
 */
const SPECS: readonly SeedSpec[] = [
  {
    id: 'devnet-whale-flows',
    name: 'Devnet Whale Flows',
    description: 'Deterministic whale movement feed for local escrow testing.',
    type: 'whale-wallets',
    category: 'on-chain-flows',
    pricePerQuery: 100,
    seller: 'seller',
    tags: ['devnet', 'whales', 'on-chain'],
    data: {
      source: 'devnet-fixture',
      movements: [
        { amount: 42_000, asset: 'XLM', at: SEED_TIMESTAMP },
        { amount: 17_500, asset: 'USDC', at: SEED_TIMESTAMP },
      ],
    },
  },
  {
    id: 'devnet-yield-curve',
    name: 'Devnet Yield Curve',
    description: 'Deterministic yield snapshot for refund and dispute scenarios.',
    type: 'yield-data',
    category: 'defi-yields',
    pricePerQuery: 50,
    seller: 'seller',
    tags: ['devnet', 'yield', 'defi'],
    data: {
      source: 'devnet-fixture',
      opportunities: [
        { protocol: 'DevnetPool', symbol: 'USDC', apy: 4.25, tvlUsd: 1_000_000 },
        { protocol: 'DevnetVault', symbol: 'USDC', apy: 6.5, tvlUsd: 2_500_000 },
      ],
    },
  },
  {
    id: 'devnet-orphan-feed',
    name: 'Devnet Orphan Feed',
    description: 'Sold by an account with no USDC trustline — payout-failure fixture.',
    type: 'trading-signals',
    category: 'trading-signals',
    pricePerQuery: 25,
    seller: 'sellerNoTrustline',
    tags: ['devnet', 'signals', 'payout-failure'],
    data: {
      source: 'devnet-fixture',
      signals: [{ asset: 'XLM', signal: 'hold', strength: 0.5 }],
    },
  },
] as const;

/** Builds the seed records, resolving each spec's seller to a real devnet address. */
export function buildDatasets(accounts: Record<DevnetRole, DevnetAccount>): SeedDataset[] {
  return SPECS.map(spec => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    type: spec.type,
    category: spec.category,
    pricePerQuery: spec.pricePerQuery,
    sellerWallet: accounts[spec.seller].publicKey,
    data: spec.data,
    queriesServed: 0,
    totalEarned: 0,
    createdAt: SEED_TIMESTAMP,
    tags: spec.tags,
    live: false as const,
  }));
}

export interface MarketplaceSeed {
  datasets: SeedDataset[];
  transactions: never[];
}

export function buildMarketplaceSeed(accounts: Record<DevnetRole, DevnetAccount>): MarketplaceSeed {
  return { datasets: buildDatasets(accounts), transactions: [] };
}

export async function writeMarketplaceSeed(
  path: string,
  accounts: Record<DevnetRole, DevnetAccount>,
): Promise<string[]> {
  const seed = buildMarketplaceSeed(accounts);
  await writeFile(path, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  return seed.datasets.map(d => d.id);
}
