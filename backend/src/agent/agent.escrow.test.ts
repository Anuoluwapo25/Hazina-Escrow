import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dataset, Transaction } from '../common/storage';

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

vi.mock('../lib/stellar.config', () => ({
  isEscrowContractConfigured: vi.fn(() => true),
}));

vi.mock('../lib/escrow.client', () => ({
  lockAsAgent: vi.fn(),
  releaseEscrow: vi.fn(),
  refundEscrow: vi.fn(),
}));

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
    datasetQueried: vi.fn(),
    agentJobCompleted: vi.fn(),
    agentDatasetPurchase: vi.fn(),
    agentBudgetInsufficient: vi.fn(),
    agentHumanPaymentVerified: vi.fn(),
  },
}));

vi.mock('../common/storage', () => {
  const pending = new Set<string>();
  const transactions: Transaction[] = [];
  return {
    getAllDatasets: vi.fn(),
    getDataset: vi.fn(),
    updateDataset: vi.fn(() => Promise.resolve(null)),
    addTransaction: vi.fn((tx: Transaction) => {
      transactions.push(tx);
      return Promise.resolve();
    }),
    getTransactionByHash: vi.fn((hash: string) =>
      Promise.resolve(transactions.find(tx => tx.txHash === hash)),
    ),
    getAgentJobByTxHash: vi.fn((hash: string) =>
      Promise.resolve(transactions.find(tx => tx.txHash === hash && tx.datasetId === 'agent-job')),
    ),
    reserveTxHash: vi.fn((hash: string) => {
      pending.add(hash);
      return () => pending.delete(hash);
    }),
    txHashUsed: vi.fn(async (hash: string) => {
      await new Promise(r => setTimeout(r, 5));
      return pending.has(hash) || transactions.some(tx => tx.txHash === hash);
    }),
    __transactions: transactions,
  };
});

import { runResearchAgent, runResearchAgentDemo, SELLER_TYPES } from './agent.service';
import { lockAsAgent, releaseEscrow, refundEscrow } from '../lib/escrow.client';
import * as storage from '../common/storage';

const SELLER_WALLET = `G${'A'.repeat(55)}`;

function makeDatasets(): Dataset[] {
  return SELLER_TYPES.map((seller, index) => ({
    id: `ds-${seller.type}`,
    name: `${seller.description} Dataset`,
    description: seller.description,
    type: seller.type,
    pricePerQuery: 0.1,
    sellerWallet: SELLER_WALLET,
    data: { rows: [index] },
    queriesServed: index,
    totalEarned: index,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

describe('agent escrow settlement (#550)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ESCROW_WALLET = 'G_ESCROW';

    const datasets = makeDatasets();
    vi.mocked(storage.getAllDatasets).mockResolvedValue(datasets);
    vi.mocked(storage.getDataset).mockImplementation(async (id: string) =>
      datasets.find(d => d.id === id),
    );
    (storage as unknown as { __transactions: Transaction[] }).__transactions.length = 0;

    vi.mocked(lockAsAgent).mockImplementation(async ({ datasetId }) => ({
      txHash: `lock-${datasetId}`,
      escrowId: Math.floor(Math.random() * 100000),
    }));
    vi.mocked(releaseEscrow).mockResolvedValue('release-tx-hash');
    vi.mocked(refundEscrow).mockResolvedValue('refund-tx-hash');
  });

  it('only marks sellerPaid true after release confirms on-chain', async () => {
    const job = await runResearchAgent('best low risk strategy', 'human-tx-1');
    expect('idempotent' in job).toBe(false);
    if ('idempotent' in job) return;

    expect(job.purchases).toHaveLength(SELLER_TYPES.length);
    expect(lockAsAgent).toHaveBeenCalledTimes(SELLER_TYPES.length);
    expect(releaseEscrow).toHaveBeenCalledTimes(SELLER_TYPES.length);
    expect(refundEscrow).not.toHaveBeenCalled();

    for (const p of job.purchases) {
      expect(p.refunded).toBe(false);
      expect(p.escrowId).toEqual(expect.any(Number));
    }

    const datasetTxs = (
      storage as unknown as { __transactions: Transaction[] }
    ).__transactions.filter(tx => tx.datasetId !== 'agent-job');
    expect(datasetTxs).toHaveLength(SELLER_TYPES.length);
    for (const tx of datasetTxs) {
      expect(tx.sellerPaid).toBe(true);
      expect(tx.sellerAmount).toBeCloseTo(0.095, 5);
    }
  });

  it('refunds instead of releasing when release fails, and never marks sellerPaid', async () => {
    vi.mocked(releaseEscrow).mockRejectedValue(new Error('release simulation failed'));

    const job = await runResearchAgent('best low risk strategy', 'human-tx-2');
    if ('idempotent' in job) throw new Error('expected a fresh job');

    expect(lockAsAgent).toHaveBeenCalledTimes(SELLER_TYPES.length);
    expect(releaseEscrow).toHaveBeenCalledTimes(SELLER_TYPES.length);
    expect(refundEscrow).toHaveBeenCalledTimes(SELLER_TYPES.length);

    for (const p of job.purchases) {
      expect(p.refunded).toBe(true);
    }
    // Refunded amounts must not count against the agent's spend/profit.
    expect(job.totalSpent).toBe(0);

    const datasetTxs = (
      storage as unknown as { __transactions: Transaction[] }
    ).__transactions.filter(tx => tx.datasetId !== 'agent-job');
    for (const tx of datasetTxs) {
      expect(tx.sellerPaid).toBe(false);
      expect(tx.sellerAmount).toBeUndefined();
      expect(tx.status).toBe('refunded');
    }
  });

  it('refunds when purchased data cannot be retrieved after locking', async () => {
    vi.mocked(storage.getDataset).mockResolvedValue(undefined);

    const job = await runResearchAgent('best low risk strategy', 'human-tx-3');
    if ('idempotent' in job) throw new Error('expected a fresh job');

    expect(releaseEscrow).not.toHaveBeenCalled();
    expect(refundEscrow).toHaveBeenCalledTimes(SELLER_TYPES.length);
    for (const p of job.purchases) {
      expect(p.refunded).toBe(true);
    }
  });

  it('does not create duplicate escrows when a humanTxHash is replayed concurrently', async () => {
    const txHash = 'replayed-tx-hash';

    const [res1, res2] = await Promise.all([
      runResearchAgent('query 1', txHash),
      runResearchAgent('query 2', txHash),
    ]);

    const results = [res1, res2];
    expect(results.some(r => 'idempotent' in r)).toBe(true);
    expect(results.some(r => !('idempotent' in r))).toBe(true);

    // Exactly one job's worth of escrow locks should have been created — a
    // replay must never double the number of on-chain escrows (#550).
    expect(lockAsAgent).toHaveBeenCalledTimes(SELLER_TYPES.length);
    expect(releaseEscrow).toHaveBeenCalledTimes(SELLER_TYPES.length);
  });

  it('demo mode never touches the escrow contract', async () => {
    await runResearchAgentDemo('best low risk strategy');
    expect(lockAsAgent).not.toHaveBeenCalled();
    expect(releaseEscrow).not.toHaveBeenCalled();
    expect(refundEscrow).not.toHaveBeenCalled();
  });
});
