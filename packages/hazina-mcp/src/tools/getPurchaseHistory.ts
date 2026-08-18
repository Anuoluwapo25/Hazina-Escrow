import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { guarded, jsonResult } from '../mcpHelpers.js';
import { SpendTracker } from '../spendTracker.js';

export const getPurchaseHistoryInputShape = {};

export const getPurchaseHistoryDescription =
  'Free — does not spend money. Lists every purchase this server has made this session: ' +
  'dataset id, amount (USDC), transaction hash, and whether it was a demo (non-real) purchase.';

export function createGetPurchaseHistoryHandler(spendTracker: SpendTracker) {
  return async (): Promise<CallToolResult> =>
    guarded(async () =>
      jsonResult({
        purchases: spendTracker.getLog(),
        sessionTotalUsdc: spendTracker.getSessionTotal(),
      }),
    );
}
