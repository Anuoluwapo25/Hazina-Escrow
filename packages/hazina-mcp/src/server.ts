/**
 * server.ts — builds the Hazina MCP server: five tools plus two resource
 * templates, wired against a real HazinaApiClient and SpendTracker.
 *
 * Factored out from index.ts so tests can connect a real McpServer to a
 * real Client over an in-memory transport pair, with no stdio/HTTP/network
 * involved (see src/__tests__/server.test.ts).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HazinaApiClient, HazinaApiClientLike } from './apiClient.js';
import { HazinaMcpConfig } from './config.js';
import { SpendTracker } from './spendTracker.js';
import { sendPayment } from './wallet.js';
import {
  searchDatasetsInputShape,
  searchDatasetsDescription,
  createSearchDatasetsHandler,
} from './tools/searchDatasets.js';
import {
  getDatasetInputShape,
  getDatasetDescription,
  createGetDatasetHandler,
} from './tools/getDataset.js';
import {
  quotePurchaseInputShape,
  quotePurchaseDescription,
  createQuotePurchaseHandler,
} from './tools/quotePurchase.js';
import {
  purchaseDatasetInputShape,
  purchaseDatasetDescription,
  createPurchaseDatasetHandler,
} from './tools/purchaseDataset.js';
import {
  getPurchaseHistoryDescription,
  createGetPurchaseHistoryHandler,
} from './tools/getPurchaseHistory.js';

export interface HazinaMcpServerHandle {
  server: McpServer;
  spendTracker: SpendTracker;
}

export function createHazinaMcpServer(
  config: HazinaMcpConfig,
  api: HazinaApiClientLike = new HazinaApiClient(config),
): HazinaMcpServerHandle {
  const server = new McpServer({ name: 'hazina-mcp', version: '0.1.0' });
  const spendTracker = new SpendTracker(config.maxSpendPerCall, config.maxSpendPerSession);

  server.registerTool(
    'search_datasets',
    { description: searchDatasetsDescription, inputSchema: searchDatasetsInputShape },
    createSearchDatasetsHandler(api),
  );

  server.registerTool(
    'get_dataset',
    { description: getDatasetDescription, inputSchema: getDatasetInputShape },
    createGetDatasetHandler(api),
  );

  server.registerTool(
    'quote_purchase',
    { description: quotePurchaseDescription, inputSchema: quotePurchaseInputShape },
    createQuotePurchaseHandler(api),
  );

  server.registerTool(
    'purchase_dataset',
    { description: purchaseDatasetDescription, inputSchema: purchaseDatasetInputShape },
    createPurchaseDatasetHandler({ api, config, spendTracker, sendPayment }),
  );

  server.registerTool(
    'get_purchase_history',
    { description: getPurchaseHistoryDescription },
    createGetPurchaseHistoryHandler(spendTracker),
  );

  server.registerResource(
    'dataset',
    new ResourceTemplate('hazina://datasets/{id}', { list: undefined }),
    { description: 'A Hazina dataset listing, by id.', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables.id);
      const dataset = await api.getDataset(id);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(dataset) }],
      };
    },
  );

  server.registerResource(
    'receipt',
    new ResourceTemplate('hazina://receipts/{txHash}', { list: undefined }),
    {
      description: 'Proof of a purchase this server made, by transaction hash.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const txHash = String(variables.txHash);
      const entry = spendTracker.findByTxHash(txHash);
      if (!entry) {
        throw new Error(
          `No receipt found for transaction hash ${txHash} in this session's purchase log.`,
        );
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(entry) }],
      };
    },
  );

  return { server, spendTracker };
}
