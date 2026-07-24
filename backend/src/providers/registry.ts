import type { DataProvider } from './provider.types';
import { defillamaProvider } from './defillama.provider';
import { coingeckoProvider } from './coingecko.provider';
import { stellarWhaleProvider } from './stellar-horizon.provider';
import { riskProvider } from './risk.provider';

/**
 * Central registry of live data providers. Datasets reference a provider by its
 * `id` (persisted on the dataset row); the refresh scheduler looks providers up
 * here to refresh live datasets, and the seed uses it to bootstrap initial
 * snapshots. The set of `type`s here is the source of truth for which dataset
 * types are provider-backed / live.
 */
export const PROVIDERS: DataProvider[] = [
  defillamaProvider,
  coingeckoProvider,
  stellarWhaleProvider,
  riskProvider,
];

const byId = new Map<string, DataProvider>(PROVIDERS.map(p => [p.id, p]));
const byType = new Map<string, DataProvider>(PROVIDERS.map(p => [p.type, p]));

export function getProviderById(id: string): DataProvider | undefined {
  return byId.get(id);
}

export function getProviderByType(type: string): DataProvider | undefined {
  return byType.get(type);
}

/** Dataset types that have a live provider backing them. */
export const LIVE_TYPES: string[] = PROVIDERS.map(p => p.type);
