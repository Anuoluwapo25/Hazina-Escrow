import { afterEach, describe, expect, it, vi } from 'vitest';
import { HazinaApiClient } from '../apiClient.js';
import { HazinaApiError } from '../errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function firstCall(mock: ReturnType<typeof vi.fn>): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('expected fetch to have been called');
  return call;
}

describe('HazinaApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searches datasets and builds the right query string', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });
    await client.searchDatasets({ query: 'yield', category: 'defi', maxPrice: 2 });

    const [url] = firstCall(fetchMock);
    expect(String(url)).toContain('search=yield');
    expect(String(url)).toContain('category=defi');
    expect(String(url)).toContain('maxPrice=2');
  });

  it('maps a 404 on get_dataset to a clear HazinaApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse(404, { error: 'not found' })),
    );
    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });

    await expect(client.getDataset('missing')).rejects.toThrow(HazinaApiError);
    await expect(client.getDataset('missing')).rejects.toThrow(/dataset not found/i);
  });

  it('treats a 402 response from initiateQuery as the expected quote, not an error', async () => {
    const quote = {
      error: 'Payment Required',
      x402: true,
      mode: 'custodial-demo',
      dataset: { id: 'ds-1', name: 'Test', type: 'yield-data' },
      payment: {
        mode: 'custodial-demo',
        amount: 0.05,
        currency: 'USDC',
        network: 'Stellar Testnet',
        memo: 'haz-ds-1',
        expiresIn: 300,
        paymentAddress: 'GABC',
        instructions: ['pay', 'verify'],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(402, quote)));
    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });

    const result = await client.initiateQuery('ds-1');
    expect(result.payment.amount).toBe(0.05);
  });

  it('sends the API key as a bearer token on payments endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        error: 'Payment Required',
        x402: true,
        mode: 'custodial-demo',
        dataset: { id: 'ds-1', name: 'Test', type: 'yield-data' },
        payment: {
          mode: 'custodial-demo',
          amount: 0.05,
          currency: 'USDC',
          network: 'Stellar Testnet',
          memo: 'm',
          expiresIn: 300,
          instructions: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new HazinaApiClient({ apiUrl: 'http://api.test', apiKey: 'secret-key' });
    await client.initiateQuery('ds-1');

    const [, init] = firstCall(fetchMock) as [unknown, { headers: { Authorization: string } }];
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  it('maps a 409 on verifyPayment to a replay-specific message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { error: 'tx already used' })),
    );
    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });

    await expect(client.verifyPayment('ds-1', 'tx-1')).rejects.toThrow(/already used/i);
  });

  it('maps a 429 to a rate-limit message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'slow down' })));
    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });

    await expect(client.verifyDemo('ds-1')).rejects.toThrow(/rate limited/i);
  });

  it('parses a successful demo verification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          success: true,
          demo: true,
          data: { foo: 'bar' },
          ai: { summary: 'a summary' },
          transaction: {
            hash: 'demo-hash',
            status: 'completed',
            deliveryStatus: 'delivered',
            amount: 0.05,
            sellerReceived: 0.0475,
            platformFee: 0.0025,
          },
        }),
      ),
    );
    const client = new HazinaApiClient({ apiUrl: 'http://api.test' });

    const result = await client.verifyDemo('ds-1', 'what is this?');
    expect(result.transaction.hash).toBe('demo-hash');
    expect(result.ai?.summary).toBe('a summary');
  });
});
