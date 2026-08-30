import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HazinaApiClientLike } from '../apiClient.js';
import { guarded, jsonResult } from '../mcpHelpers.js';

export const searchDatasetsInputShape = {
  query: z.string().max(200).optional().describe('Free-text search over dataset name/description'),
  category: z.string().max(100).optional().describe('Filter to one dataset category'),
  maxPrice: z
    .number()
    .positive()
    .optional()
    .describe('Only datasets priced at or below this, in USDC'),
};

export const searchDatasetsDescription =
  'Free — does not spend money. Semantically search the live Hazina dataset marketplace ' +
  'by natural-language query, category, and/or max price per query (USDC) — matches ' +
  'go beyond keyword overlap (e.g. "large holder activity" finds a dataset titled ' +
  '"Whale Wallet Movements"). Returns id, name, description, category, price, freshness, ' +
  'and a one-line reason each result matched.';

export function createSearchDatasetsHandler(api: HazinaApiClientLike) {
  return async (args: {
    query?: string;
    category?: string;
    maxPrice?: number;
  }): Promise<CallToolResult> =>
    guarded(async () => {
      const result = await api.searchDatasets(args);
      return jsonResult({
        total: result.total,
        mode: result.mode,
        datasets: result.results.map(r => ({
          id: r.id,
          name: r.name,
          description: r.description,
          type: r.type,
          category: r.category,
          pricePerQuery: r.pricePerQuery,
          currency: r.paymentToken ?? 'USDC',
          queriesServed: r.queriesServed,
          live: r.live ?? false,
          lastRefreshedAt: r.lastRefreshedAt,
          tags: r.tags,
          matchedBecause: r.matchedBecause,
        })),
      });
    });
}
