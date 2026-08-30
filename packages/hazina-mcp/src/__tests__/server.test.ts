/**
 * server.test.ts — end-to-end tool-call tests over a real MCP Client<->Server
 * pair connected by InMemoryTransport (no stdio/HTTP/network). Exercises the
 * five tools exactly as an MCP host would call them, against a fake
 * HazinaApiClientLike so no real backend is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHazinaMcpServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { HazinaApiClientLike } from '../apiClient.js';
import type {
  Dataset,
  DatasetDetail,
  QueryResult,
  QuotePayload,
  SearchResponse,
} from '../types.js';

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    name: 'Whale Wallets',
    description: 'Large Stellar holders',
    type: 'whale-wallets',
    category: 'onchain',
    pricePerQuery: 0.05,
    sellerWallet: `G${'A'.repeat(55)}`,
    queriesServed: 12,
    totalEarned: 0.6,
    createdAt: '2026-01-01T00:00:00.000Z',
    live: true,
    tags: ['stellar'],
    ...overrides,
  };
}

function makeQuote(overrides: Partial<QuotePayload['payment']> = {}): QuotePayload {
  return {
    error: 'Payment Required',
    x402: true,
    mode: 'custodial-demo',
    dataset: { id: 'ds-1', name: 'Whale Wallets', type: 'whale-wallets' },
    payment: {
      mode: 'custodial-demo',
      amount: 0.05,
      currency: 'USDC',
      network: 'Stellar Testnet',
      memo: 'haz-ds-1',
      expiresIn: 300,
      paymentAddress: `G${'B'.repeat(55)}`,
      instructions: ['Pay 0.05 USDC', 'Submit the tx hash'],
      ...overrides,
    },
  };
}

function makeQueryResult(hash: string): QueryResult {
  return {
    success: true,
    demo: true,
    data: { rows: [1, 2, 3] },
    ai: { summary: 'A concise summary.' },
    transaction: {
      hash,
      status: 'completed',
      deliveryStatus: 'delivered',
      amount: 0.05,
      sellerReceived: 0.0475,
      platformFee: 0.0025,
    },
  };
}

class FakeApiClient implements HazinaApiClientLike {
  demoCallCount = 0;

  async searchDatasets(): Promise<SearchResponse> {
    const dataset = makeDataset();
    return {
      success: true,
      query: 'whale',
      results: [{ ...dataset, score: 0.9, matchedBecause: 'Matches keywords: whale' }],
      total: 1,
      page: 1,
      limit: 20,
      mode: 'hybrid',
      reranked: false,
    };
  }

  async getDataset(id: string): Promise<DatasetDetail> {
    if (id === 'missing') throw new Error('get_dataset: dataset not found.');
    return {
      ...makeDataset({ id }),
      metadata: {
        type: 'whale-wallets',
        schemaFields: ['address', 'balance'],
        sampleSize: 10,
        lastUpdated: '2026-01-01',
      },
      preview: { address: 'G...', balance: 1000 },
    };
  }

  async initiateQuery(id: string): Promise<QuotePayload> {
    return makeQuote({ ...(id === 'escrow-ds' ? {} : {}) });
  }

  async verifyPayment(_id: string, txHash: string): Promise<QueryResult> {
    return makeQueryResult(txHash);
  }

  async verifyDemo(): Promise<QueryResult> {
    this.demoCallCount += 1;
    return makeQueryResult(`demo-hash-${this.demoCallCount}`);
  }
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
type ResourceResult = Awaited<ReturnType<Client['readResource']>>;

function toolText(result: ToolResult): string {
  const content = (result as { content?: unknown[] }).content;
  const first = content?.[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected a text content block');
  }
  return first.text;
}

function resourceText(result: ResourceResult): string {
  const first = result.contents[0] as { text?: string } | undefined;
  if (!first || typeof first.text !== 'string') {
    throw new Error('expected a text resource content block');
  }
  return first.text;
}

describe('Hazina MCP server (in-memory transport)', () => {
  let client: Client;
  let api: FakeApiClient;

  async function connect(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
    api = new FakeApiClient();
    const config = { ...loadConfig({ HAZINA_MCP_DEMO: '1' }), ...overrides };
    const { server } = createHazinaMcpServer(config, api);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  }

  beforeEach(async () => {
    await connect();
  });

  afterEach(async () => {
    await client.close();
  });

  it('lists all five tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'get_dataset',
      'get_purchase_history',
      'purchase_dataset',
      'quote_purchase',
      'search_datasets',
    ]);
  });

  it('states the cost of purchase_dataset in its own description', async () => {
    const { tools } = await client.listTools();
    const purchase = tools.find(t => t.name === 'purchase_dataset');
    const free = tools.find(t => t.name === 'search_datasets');
    expect(purchase?.description).toMatch(/spends money/i);
    expect(free?.description).toMatch(/free/i);
  });

  it('search_datasets returns matching datasets', async () => {
    const result = await client.callTool({
      name: 'search_datasets',
      arguments: { query: 'whale' },
    });
    const text = toolText(result);
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(1);
    expect(parsed.mode).toBe('hybrid');
    expect(parsed.datasets[0].id).toBe('ds-1');
    expect(parsed.datasets[0].matchedBecause).toBe('Matches keywords: whale');
  });

  it('get_dataset returns dataset detail', async () => {
    const result = await client.callTool({ name: 'get_dataset', arguments: { id: 'ds-1' } });
    const parsed = JSON.parse(toolText(result));
    expect(parsed.id).toBe('ds-1');
    expect(parsed.metadata.schemaFields).toContain('address');
  });

  it('get_dataset surfaces a not-found error without throwing across the transport', async () => {
    const result = await client.callTool({ name: 'get_dataset', arguments: { id: 'missing' } });
    expect(result.isError).toBe(true);
  });

  it('quote_purchase returns price and instructions without spending', async () => {
    const result = await client.callTool({ name: 'quote_purchase', arguments: { id: 'ds-1' } });
    const parsed = JSON.parse(toolText(result));
    expect(parsed.amount).toBe(0.05);
    expect(parsed.instructions.length).toBeGreaterThan(0);

    const history = await client.callTool({ name: 'get_purchase_history', arguments: {} });
    const log = JSON.parse(toolText(history));
    expect(log.purchases).toHaveLength(0);
  });

  it('purchase_dataset in demo mode never signs and logs the purchase', async () => {
    const result = await client.callTool({
      name: 'purchase_dataset',
      arguments: { id: 'ds-1', question: 'top holder?' },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(toolText(result));
    expect(parsed.transaction.hash).toMatch(/^demo-hash-/);
    expect(api.demoCallCount).toBe(1);

    const history = await client.callTool({ name: 'get_purchase_history', arguments: {} });
    const log = JSON.parse(toolText(history));
    expect(log.purchases).toHaveLength(1);
    expect(log.purchases[0].demo).toBe(true);
    expect(log.sessionTotalUsdc).toBeCloseTo(0.05);
  });

  it('blocks the 3rd purchase once the session spend cap is reached', async () => {
    await connect({ maxSpendPerCall: 1, maxSpendPerSession: 0.1 });

    const first = await client.callTool({ name: 'purchase_dataset', arguments: { id: 'ds-1' } });
    expect(first.isError).toBeFalsy();
    const second = await client.callTool({ name: 'purchase_dataset', arguments: { id: 'ds-1' } });
    expect(second.isError).toBeFalsy();

    const third = await client.callTool({ name: 'purchase_dataset', arguments: { id: 'ds-1' } });
    expect(third.isError).toBe(true);
    expect(toolText(third)).toMatch(/session limit/i);

    const history = await client.callTool({ name: 'get_purchase_history', arguments: {} });
    const log = JSON.parse(toolText(history));
    expect(log.purchases).toHaveLength(2);
  });

  it('rejects a single purchase over the per-call limit with an actionable message', async () => {
    await connect({ maxSpendPerCall: 0.01, maxSpendPerSession: 5 });

    const result = await client.callTool({ name: 'purchase_dataset', arguments: { id: 'ds-1' } });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(/per-call limit/i);
  });

  it('reads a dataset resource', async () => {
    const result = await client.readResource({ uri: 'hazina://datasets/ds-1' });
    const parsed = JSON.parse(resourceText(result));
    expect(parsed.id).toBe('ds-1');
  });

  it('reads a receipt resource after a purchase, and errors before one exists', async () => {
    await expect(client.readResource({ uri: 'hazina://receipts/tx-none' })).rejects.toThrow();

    const purchase = await client.callTool({ name: 'purchase_dataset', arguments: { id: 'ds-1' } });
    const { transaction } = JSON.parse(toolText(purchase));

    const receipt = await client.readResource({ uri: `hazina://receipts/${transaction.hash}` });
    const parsed = JSON.parse(resourceText(receipt));
    expect(parsed.datasetId).toBe('ds-1');
    expect(parsed.txHash).toBe(transaction.hash);
  });
});
