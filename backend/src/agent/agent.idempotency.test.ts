import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

import { runResearchAgent } from './agent.service';
import { sendUsdcPayment } from './agent.wallet';
import { verifyStellarPayment } from '../payments/stellar.service';

vi.mock('../common/storage', () => {
  const pending = new Set<string>();
  const transactions: Array<{ txHash: string; datasetId: string }> = [];
  const SELLER_TYPES = [
    { type: 'yield-data' },
    { type: 'whale-wallets' },
    { type: 'risk-scores' },
    { type: 'sentiment' },
  ];
  return {
    getAllDatasets: vi.fn(() =>
      Promise.resolve(
        SELLER_TYPES.map(t => ({
          id: `ds-${t.type}`,
          type: t.type,
          pricePerQuery: 0.1,
          sellerWallet: 'G_SELLER',
        })),
      ),
    ),
    getDataset: vi.fn(id => Promise.resolve({ id, pricePerQuery: 0.1, sellerWallet: 'G_SELLER' })),
    updateDataset: vi.fn(() => Promise.resolve(null)),
    addTransaction: vi.fn(tx => {
      transactions.push(tx);
      return Promise.resolve();
    }),
    getTransactionByHash: vi.fn(hash => {
      return Promise.resolve(transactions.find(tx => tx.txHash === hash));
    }),
    getAgentJobByTxHash: vi.fn(hash => {
      const found = transactions.find(tx => tx.txHash === hash && tx.datasetId === 'agent-job');
      return Promise.resolve(found);
    }),
    reserveTxHash: vi.fn(hash => {
      pending.add(hash);
      return () => {
        pending.delete(hash);
      };
    }),
    txHashUsed: vi.fn(async hash => {
      // Simulate a small delay to allow concurrent calls to overlap
      await new Promise(r => setTimeout(r, 10));
      const isPending = pending.has(hash);
      const isStored = transactions.some(tx => tx.txHash === hash);
      return isPending || isStored;
    }),
  };
});

vi.mock('../payments/stellar.service', () => ({
  verifyStellarPayment: vi.fn(() => Promise.resolve({ valid: true })),
}));

vi.mock('./agent.wallet', () => ({
  getAgentPublicKey: vi.fn(() => 'GAGENT'),
  sendUsdcPayment: vi.fn(() => Promise.resolve({ txHash: 'seller-payment-hash' })),
}));

vi.mock('../ai/research.service', () => ({
  parseBudget: vi.fn(() => 500),
  parseRiskTolerance: vi.fn(() => 'low'),
  synthesizeResearch: vi.fn(() =>
    Promise.resolve({
      topOpportunity: {
        protocol: 'Aave',
        vault: 'USDC Stable Pool',
        chain: 'Ethereum',
        apy: 7.2,
        riskLevel: 'Low',
        whaleConfidence: 'High',
        sentimentScore: 'Bullish',
      },
      reasoning: 'Reasoning text',
      alternatives: ['Alt 1'],
      warnings: [],
      rawAnalysis: 'Raw analysis text',
    }),
  ),
}));

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn(() => Promise.resolve()),
}));

vi.mock('../common/datadog', () => ({
  domainMetrics: {
    paymentVerified: vi.fn(),
    datasetQueried: vi.fn(),
    agentJobCompleted: vi.fn(),
    agentDatasetPurchase: vi.fn(),
    agentHumanPaymentVerified: vi.fn(),
  },
}));

describe('runResearchAgent Idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESCROW_WALLET = 'G_ESCROW';
  });

  it('reproves the race condition: concurrent requests with same hash result in duplicate payments', async () => {
    const txHash = 'shared-tx-hash';

    // Fire two concurrent requests
    const [res1, res2] = await Promise.all([
      runResearchAgent('query 1', txHash),
      runResearchAgent('query 2', txHash),
    ]);

    // One should be an AgentJob, the other should be an IdempotentJobResult
    const results = [res1, res2];
    const idempotentResult = results.find(r => 'idempotent' in r);
    const normalResult = results.find(r => !('idempotent' in r));

    expect(normalResult).toBeDefined();
    expect(idempotentResult).toBeDefined();
    expect(idempotentResult?.idempotent).toBe(true);

    // verifyStellarPayment should be called ONLY ONCE
    expect(verifyStellarPayment).toHaveBeenCalledTimes(1);

    // sendUsdcPayment should be called once for each SELLER_TYPE (4 times)
    // if it was called twice (the bug), it would be 8 times.
    expect(sendUsdcPayment).toHaveBeenCalledTimes(4);
  });
});
