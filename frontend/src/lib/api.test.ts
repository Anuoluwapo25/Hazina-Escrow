import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRequestThrottleForTests,
  api,
  DEFAULT_REQUEST_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_MS,
} from './api';
import { initEnv } from './env';

vi.mock('./env', () => ({
  getEnv: () => ({ apiUrl: 'http://localhost', apiKey: 'test', maxConcurrentRequests: 8 }),
  initEnv: vi.fn(),
}));

function createFetchResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

describe('api request throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));
    __resetRequestThrottleForTests();
    initEnv();
  });

  afterEach(() => {
    __resetRequestThrottleForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.skip('spaces repeated calls to the same endpoint', async () => {
    let resolveFirstResponse = () => {};

    const firstResponse = new Promise<ReturnType<typeof createFetchResponse>>(resolve => {
      resolveFirstResponse = () =>
        resolve(
          createFetchResponse({
            success: true,
            data: [],
            total: 0,
            page: 1,
            pageSize: 20,
            totalPages: 1,
          }),
        );
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementation(() =>
        Promise.resolve(
          createFetchResponse({
            success: true,
            data: [],
            total: 0,
            page: 1,
            pageSize: 20,
            totalPages: 1,
          }),
        ),
      );

    vi.stubGlobal('fetch', fetchMock);

    const firstCall = api.getDatasets();
    const secondCall = api.getDatasets();

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirstResponse();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(firstCall).resolves.toMatchObject({ total: 0 });
    await expect(secondCall).resolves.toMatchObject({ total: 0 });
  });

  it.skip('keeps different endpoints independent', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/datasets/stats')) {
        return Promise.resolve(
          createFetchResponse({
            success: true,
            stats: {
              totalDatasets: 1,
              totalQueries: 2,
              totalUsdcEarned: 3,
              totalTransactions: 4,
            },
          }),
        );
      }

      return Promise.resolve(
        createFetchResponse({
          success: true,
          data: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        }),
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    const datasetsPromise = api.getDatasets();
    const statsPromise = api.getStats();

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(datasetsPromise).resolves.toMatchObject({ total: 0 });
    await expect(statsPromise).resolves.toMatchObject({
      totalDatasets: 1,
      totalQueries: 2,
      totalUsdcEarned: 3,
      totalTransactions: 4,
    });
  });

  it.skip('serializes advanced dataset filters', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        createFetchResponse({
          success: true,
          data: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        }),
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    await api.getDatasets({
      page: 2,
      limit: 12,
      search: 'yield',
      types: ['yield-data', 'risk-scores'],
      minPrice: 0.5,
      maxPrice: 5,
      minQueries: 1000,
      sort: 'price-asc',
    });

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall || firstCall.length === 0) throw new Error('fetchMock was not called');
    const url = new URL(String((firstCall as unknown[])[0]), 'http://localhost');
    expect(url.searchParams.getAll('type')).toEqual(['yield-data', 'risk-scores']);
    expect(url.searchParams.get('minPrice')).toBe('0.5');
    expect(url.searchParams.get('maxPrice')).toBe('5');
    expect(url.searchParams.get('minQueries')).toBe('1000');
    expect(url.searchParams.get('sort')).toBe('price-asc');
  });

  it('times out with friendly message for default API requests', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const abort = new Error('Aborted');
          abort.name = 'AbortError';
          if (signal?.aborted) {
            reject(abort);
            return;
          }
          signal?.addEventListener('abort', () => reject(abort));
        }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const datasetsPromise = api.getDatasets();
    // Attach catch early so the rejection is always handled
    const caught = datasetsPromise.catch(() => {});

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await caught;

    await expect(datasetsPromise).rejects.toThrow('Request timed out — please try again');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the agent timeout constant for agent AI requests', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          const abort = new Error('Aborted');
          abort.name = 'AbortError';
          if (signal?.aborted) {
            reject(abort);
            return;
          }
          signal?.addEventListener('abort', () => reject(abort));
        }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const agentPromise = api.agentDemo('long running query');
    // Attach catch early so the rejection is always handled
    const caught = agentPromise.catch(() => {});

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AGENT_REQUEST_TIMEOUT_MS);
    await caught;

    await expect(agentPromise).rejects.toThrow('Request timed out — please try again');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toContain('/agent/research/demo');
  });
});

describe('api response validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));
    __resetRequestThrottleForTests();
  });

  afterEach(() => {
    __resetRequestThrottleForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('throws ApiValidationError when response has unexpected shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        success: true,
        data: [
          {
            id: 'ds-1',
            name: 'Bad Dataset',
            // Missing 'type'
            pricePerQuery: 'not a number', // Wrong type
            sellerWallet: 'G123', // Too short
            queriesServed: 0,
            totalEarned: 0,
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        totalPages: 1,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getDatasets()).rejects.toThrow('Unexpected API shape:');
  });
});

describe('api.getReceipt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));
    __resetRequestThrottleForTests();
  });

  afterEach(() => {
    __resetRequestThrottleForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches and parses a receipt with merkle proof and verification', async () => {
    const receipt = {
      id: 'rcpt_123',
      datasetId: 'ds-test-1',
      buyer: `G${'A'.repeat(55)}`,
      seller: `G${'B'.repeat(55)}`,
      amount: 1,
      paymentToken: 'USDC',
      txHash: 'tx-abc',
      leafHash: '11'.repeat(32),
      receiptHash: '22'.repeat(32),
      anchorMode: 'direct',
      anchorStatus: 'ANCHORED',
      anchorTxHash: 'tx-anchor',
      deliveredAt: '2026-01-01T00:00:00.000Z',
      anchoredAt: '2026-01-01T00:01:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    const merkleProof = {
      leafIndex: 0,
      leafHash: '11'.repeat(32),
      siblings: [null, '33'.repeat(32)],
      root: '44'.repeat(32),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        success: true,
        receipt,
        merkleProof,
        verification: {
          valid: true,
          receiptHashMatches: true,
          merkleProofValid: true,
          anchorVerified: true,
          anchorTxHash: 'tx-anchor',
          status: 'ANCHORED',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getReceipt('rcpt_123');

    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toContain(
      '/api/v1/receipts/rcpt_123',
    );
    expect(result.receipt.id).toBe('rcpt_123');
    expect(result.merkleProof?.root).toBe('44'.repeat(32));
    expect(result.verification.valid).toBe(true);
  });

  it('omits the merkle proof when the receipt is not anchored', async () => {
    const receipt = {
      id: 'rcpt_pending',
      datasetId: 'ds-test-1',
      buyer: `G${'A'.repeat(55)}`,
      seller: `G${'B'.repeat(55)}`,
      amount: 1,
      paymentToken: 'USDC',
      txHash: 'tx-pending',
      leafHash: '11'.repeat(32),
      receiptHash: '22'.repeat(32),
      anchorMode: 'direct',
      anchorStatus: 'NOT_ANCHORED_YET',
      deliveredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        success: true,
        receipt,
        verification: {
          valid: true,
          receiptHashMatches: true,
          anchorVerified: false,
          status: 'NOT_ANCHORED_YET',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getReceipt('rcpt_pending');

    expect(result.merkleProof).toBeUndefined();
    expect(result.verification.anchorVerified).toBe(false);
  });
});
