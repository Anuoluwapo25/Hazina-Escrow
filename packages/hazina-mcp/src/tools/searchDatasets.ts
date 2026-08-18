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
  'Free — does not spend money. Search the live Hazina dataset marketplace by ' +
  'text query, category, and/or max price per query (USDC). Returns id, name, ' +
  'description, category, price, and freshness for each match.';

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
        datasets: result.data.map(d => ({
          id: d.id,
          name: d.name,
          description: d.description,
          type: d.type,
          category: d.category,
          pricePerQuery: d.pricePerQuery,
          currency: d.paymentToken ?? 'USDC',
          queriesServed: d.queriesServed,
          live: d.live ?? false,
          lastRefreshedAt: d.lastRefreshedAt,
          tags: d.tags,
        })),
      });
    });
}
