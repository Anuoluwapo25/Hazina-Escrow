import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HazinaApiClientLike } from '../apiClient.js';
import { guarded, jsonResult } from '../mcpHelpers.js';

export const getDatasetInputShape = {
  id: z.string().min(1).describe('Dataset id, from search_datasets'),
};

export const getDatasetDescription =
  'Free — does not spend money. Full detail for one dataset: description, price, ' +
  'seller wallet, freshness/provider, schema fields, and a redacted sample preview.';

export function createGetDatasetHandler(api: HazinaApiClientLike) {
  return async (args: { id: string }): Promise<CallToolResult> =>
    guarded(async () => {
      const dataset = await api.getDataset(args.id);
      return jsonResult(dataset);
    });
}
