import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HazinaApiClientLike } from '../apiClient.js';
import { guarded, jsonResult } from '../mcpHelpers.js';

export const quotePurchaseInputShape = {
  id: z.string().min(1).describe('Dataset id, from search_datasets'),
};

export const quotePurchaseDescription =
  'Free — does not spend money and does not commit to a purchase. Returns the ' +
  'exact price (USDC) and payment instructions for a dataset, so the cost can be ' +
  'checked before calling purchase_dataset.';

export function createQuotePurchaseHandler(api: HazinaApiClientLike) {
  return async (args: { id: string }): Promise<CallToolResult> =>
    guarded(async () => {
      const quote = await api.initiateQuery(args.id);
      return jsonResult({
        datasetId: quote.dataset.id,
        datasetName: quote.dataset.name,
        amount: quote.payment.amount,
        currency: quote.payment.currency,
        mode: quote.payment.mode,
        instructions: quote.payment.instructions,
        expiresIn: quote.payment.expiresIn,
      });
    });
}
