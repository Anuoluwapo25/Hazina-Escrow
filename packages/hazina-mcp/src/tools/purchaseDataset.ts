import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HazinaApiClientLike } from '../apiClient.js';
import { HazinaMcpConfig } from '../config.js';
import { guarded, errorResult, jsonResult } from '../mcpHelpers.js';
import { SpendLimitError, SpendTracker } from '../spendTracker.js';
import type { SentPayment, WalletConfig } from '../wallet.js';

export const purchaseDatasetInputShape = {
  id: z.string().min(1).describe('Dataset id, from search_datasets'),
  question: z
    .string()
    .max(500)
    .optional()
    .describe('Optional natural-language question for Hazina to answer against the purchased data'),
};

/** Cost is stated in the description itself so a model can tell a paid tool from a free one before calling it. */
export const purchaseDatasetDescription =
  '⚠️ SPENDS MONEY. Pays for and retrieves a dataset in USDC on Stellar, subject to ' +
  'HAZINA_MCP_MAX_SPEND_PER_CALL/_PER_SESSION. Call quote_purchase first to see the exact ' +
  'price. In demo mode (HAZINA_MCP_DEMO=1) this never signs a real transaction. Returns the ' +
  'dataset data, an AI summary, and the on-chain (or demo) transaction hash.';

export interface PurchaseDatasetDeps {
  api: HazinaApiClientLike;
  config: HazinaMcpConfig;
  spendTracker: SpendTracker;
  sendPayment: (
    config: WalletConfig,
    params: {
      destinationAddress: string;
      amount: number;
      memo: string;
      tokenCode?: string;
    },
  ) => Promise<SentPayment>;
}

export function createPurchaseDatasetHandler(deps: PurchaseDatasetDeps) {
  const { api, config, spendTracker, sendPayment } = deps;

  return async (args: { id: string; question?: string }): Promise<CallToolResult> =>
    guarded(async () => {
      const quote = await api.initiateQuery(args.id);
      const { amount, mode, memo } = quote.payment;

      if (mode === 'escrow') {
        return errorResult(
          `Dataset ${args.id} is served by an escrow-mode Hazina backend, which this MCP server ` +
            'does not yet pay automatically (it only signs the classic memo-based flow). ' +
            'Use demo mode, or the Hazina web checkout, to purchase this dataset.',
        );
      }

      try {
        spendTracker.assertWithinLimits(amount);
      } catch (err) {
        if (err instanceof SpendLimitError) return errorResult(err.message);
        throw err;
      }

      if (config.demo) {
        const result = await api.verifyDemo(args.id, args.question);
        spendTracker.record({
          datasetId: args.id,
          amount,
          txHash: result.transaction.hash,
          demo: true,
        });
        return jsonResult(result);
      }

      if (!config.walletSecret) {
        return errorResult(
          'No wallet is configured for real purchases — set HAZINA_WALLET_SECRET, or set ' +
            'HAZINA_MCP_DEMO=1 to try this in dry-run mode.',
        );
      }
      if (!quote.payment.paymentAddress) {
        return errorResult(
          `Dataset ${args.id}'s quote did not include a payment address — cannot pay automatically.`,
        );
      }

      const sent = await sendPayment(
        { secret: config.walletSecret },
        {
          destinationAddress: quote.payment.paymentAddress,
          amount,
          memo,
          tokenCode: quote.payment.currency,
        },
      );

      const result = await api.verifyPayment(args.id, sent.txHash, args.question);
      spendTracker.record({
        datasetId: args.id,
        amount,
        txHash: sent.txHash,
        demo: false,
      });
      return jsonResult(result);
    });
}
