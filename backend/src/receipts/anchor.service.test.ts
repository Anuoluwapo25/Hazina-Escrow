import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

const { mockReceipts } = vi.hoisted(() => ({
  mockReceipts: [] as Array<{
    id: string;
    receiptHash: string;
    leafHash: string;
    anchorMode: 'direct' | 'batched';
    anchorStatus: string;
  }>,
}));

vi.mock('../receipts/receipt.service', () => ({
  getPendingReceipts: vi.fn(async (opts: { mode: 'direct' | 'batched'; limit?: number }) =>
    mockReceipts.filter(r => r.anchorMode === opts.mode).slice(0, opts.limit ?? 50),
  ),
  getReceipt: vi.fn(async (id: string) =>
    mockReceipts.find(r => r.id === id) ?? undefined,
  ),
  markReceiptAnchoring: vi.fn(async () => null),
  markReceiptAnchored: vi.fn(
    async (
      id: string,
      anchorTxHash: string,
      merkleRoot?: string,
      merkleIndex?: number,
      merkleProof?: (string | null)[],
    ) => {
      const r = mockReceipts.find(x => x.id === id);
      if (!r) return null;
      return { ...r, anchorTxHash, merkleRoot, merkleIndex, merkleProof };
    },
  ),
  markReceiptAnchorFailed: vi.fn(async () => null),
}));

const mockHorizon = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  keypairSign: vi.fn(),
  memoHashArg: null as null | string,
}));

const TEST_SECRET = 'SA3XVGJ5IC3NBTO3ILGF6LTNBTPTZC62AYFFGPD4NH6IRQ3PCDOYOU33';
const TEST_PUBLIC = 'GB7YPYYLJVPCBBV67IVJESPWSRRUSZKXFYGTG76A2OAB4BI7N35XZVRS';

vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  class MockServer {
    loadAccount = mockHorizon.loadAccount;
    submitTransaction = mockHorizon.submitTransaction;
  }
  class MockTransactionBuilder {
    private ops: unknown[] = [];
    private memo: unknown = null;
    constructor(
      _account: unknown,
      _opts: unknown,
    ) {}
    addOperation(op: unknown) {
      this.ops.push(op);
      return this;
    }
    addMemo(memo: unknown) {
      this.memo = memo;
      return this;
    }
    setTimeout(_seconds: number) {
      return this;
    }
    build() {
      return {
        ops: this.ops,
        memo: this.memo,
        sign: mockHorizon.keypairSign,
      };
    }
  }
  return {
    ...actual,
    BASE_FEE: '100',
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
    TransactionBuilder: MockTransactionBuilder,
    Operation: {
      ...actual.Operation,
      payment: vi.fn((opts: unknown) => ({ type: 'payment', opts })),
    },
    Asset: {
      ...actual.Asset,
      native: () => ({ type: 'native' }),
    },
    Memo: {
      ...actual.Memo,
      hash: (arg: Buffer) => {
        mockHorizon.memoHashArg = arg.toString('hex');
        return { type: 'hash', value: arg };
      },
    },
    Keypair: {
      ...actual.Keypair,
      fromSecret: vi.fn().mockImplementation(() => ({
        publicKey: () => TEST_PUBLIC,
        sign: mockHorizon.keypairSign,
      })),
    },
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  submitAnchorTransaction,
  anchorReceiptDirect,
  anchorReceiptBatch,
  runAnchorSweep,
  parseAnchorMode,
} from './anchor.service';
import {
  getPendingReceipts,
  markReceiptAnchored,
} from './receipt.service';

function makeReceipt(overrides: Partial<(typeof mockReceipts)[number]> = {}) {
  const receipt = {
    id: `rcpt_${Math.random().toString(36).slice(2)}`,
    receiptHash: 'a'.repeat(64),
    leafHash: 'b'.repeat(64),
    anchorMode: 'direct' as const,
    anchorStatus: 'NOT_ANCHORED_YET',
    ...overrides,
  };
  return receipt;
}

describe('anchor.service', () => {
  beforeEach(() => {
    mockReceipts.length = 0;
    vi.clearAllMocks();
    vi.mocked(mockHorizon.loadAccount).mockResolvedValue({
      accountId: () => TEST_PUBLIC,
      sequenceNumber: () => '1',
    } as never);
    vi.mocked(mockHorizon.submitTransaction).mockResolvedValue({ hash: 'anchor-tx-hash' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('submitAnchorTransaction', () => {
    it('requires AGENT_WALLET_SECRET', async () => {
      const prev = process.env.AGENT_WALLET_SECRET;
      delete process.env.AGENT_WALLET_SECRET;
      await expect(submitAnchorTransaction('a'.repeat(64))).rejects.toThrow(
        'AGENT_WALLET_SECRET',
      );
      if (prev !== undefined) process.env.AGENT_WALLET_SECRET = prev;
    });

    it('submits a payment with MEMO_HASH and returns the tx hash', async () => {
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;
      const hash = 'ab'.repeat(32);
      const txHash = await submitAnchorTransaction(hash);
      expect(txHash).toBe('anchor-tx-hash');
      expect(mockHorizon.loadAccount).toHaveBeenCalledTimes(1);
      expect(mockHorizon.submitTransaction).toHaveBeenCalledTimes(1);
      delete process.env.AGENT_WALLET_SECRET;
    });

    it('propagates submission failures', async () => {
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;
      vi.mocked(mockHorizon.submitTransaction).mockRejectedValue(new Error('horizon down'));
      await expect(submitAnchorTransaction('a'.repeat(64))).rejects.toThrow('horizon down');
      delete process.env.AGENT_WALLET_SECRET;
    });
  });

  describe('anchorReceiptDirect', () => {
    it('returns null when receipt not found', async () => {
      const result = await anchorReceiptDirect('missing');
      expect(result).toBeNull();
    });

    it('anchors a direct receipt and marks it anchored', async () => {
      const receipt = makeReceipt();
      mockReceipts.push(receipt);
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;

      const result = await anchorReceiptDirect(receipt.id);

      expect(result).toBeTruthy();
      expect(result!.anchorTxHash).toBe('anchor-tx-hash');
      expect(markReceiptAnchored).toHaveBeenCalledWith(
        receipt.id,
        'anchor-tx-hash',
      );
      delete process.env.AGENT_WALLET_SECRET;
    });

    it('marks receipt failed when submission throws', async () => {
      const receipt = makeReceipt();
      mockReceipts.push(receipt);
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;
      vi.mocked(mockHorizon.submitTransaction).mockRejectedValue(new Error('timeout'));

      const result = await anchorReceiptDirect(receipt.id);

      expect(result).toBeNull();
      delete process.env.AGENT_WALLET_SECRET;
    });
  });

  describe('anchorReceiptBatch', () => {
    it('returns empty for no receipts', async () => {
      const result = await anchorReceiptBatch([]);
      expect(result).toEqual([]);
    });

    it('anchors a batch and stores merkle proofs per receipt', async () => {
      const receipts = [
        makeReceipt({ id: 'rcpt_b1', anchorMode: 'batched', leafHash: '11'.repeat(32) }),
        makeReceipt({ id: 'rcpt_b2', anchorMode: 'batched', leafHash: '22'.repeat(32) }),
        makeReceipt({ id: 'rcpt_b3', anchorMode: 'batched', leafHash: '33'.repeat(32) }),
      ];
      for (const r of receipts) mockReceipts.push(r);
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;

      const result = await anchorReceiptBatch(receipts.map(r => r.id));

      expect(result.length).toBe(3);
      for (const r of result) {
        expect(r.anchorTxHash).toBe('anchor-tx-hash');
        expect(r.merkleRoot).toBeTruthy();
        expect(r.merkleProof).toBeDefined();
        expect(r.merkleIndex).toBeDefined();
      }
      // All proofs share the same root
      const roots = new Set(result.map(r => r.merkleRoot));
      expect(roots.size).toBe(1);
      // Indices are distinct
      const indices = result.map(r => r.merkleIndex).sort();
      expect(indices).toEqual([0, 1, 2]);
      delete process.env.AGENT_WALLET_SECRET;
    });

    it('marks all receipts failed when root submission throws', async () => {
      const receipts = [
        makeReceipt({ id: 'rcpt_f1', anchorMode: 'batched' }),
        makeReceipt({ id: 'rcpt_f2', anchorMode: 'batched' }),
      ];
      for (const r of receipts) mockReceipts.push(r);
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;
      vi.mocked(mockHorizon.submitTransaction).mockRejectedValue(new Error('network error'));

      const result = await anchorReceiptBatch(receipts.map(r => r.id));

      expect(result).toEqual([]);
      delete process.env.AGENT_WALLET_SECRET;
    });
  });

  describe('runAnchorSweep', () => {
    it('anchors direct and batched receipts and reports counts', async () => {
      mockReceipts.push(makeReceipt({ id: 'rcpt_d1', anchorMode: 'direct' }));
      mockReceipts.push(makeReceipt({ id: 'rcpt_d2', anchorMode: 'direct' }));
      mockReceipts.push(makeReceipt({ id: 'rcpt_b1', anchorMode: 'batched' }));
      mockReceipts.push(makeReceipt({ id: 'rcpt_b2', anchorMode: 'batched' }));
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;

      const result = await runAnchorSweep();

      expect(result.anchored).toBe(4);
      expect(result.directAnchored).toBe(2);
      expect(result.batchedAnchored).toBe(2);
      expect(result.failed).toBe(0);
      expect(getPendingReceipts).toHaveBeenCalledTimes(2);
      delete process.env.AGENT_WALLET_SECRET;
    });

    it('reports failures when anchoring fails', async () => {
      mockReceipts.push(makeReceipt({ id: 'rcpt_d1', anchorMode: 'direct' }));
      process.env.AGENT_WALLET_SECRET = TEST_SECRET;
      vi.mocked(mockHorizon.submitTransaction).mockRejectedValue(new Error('down'));

      const result = await runAnchorSweep();

      expect(result.anchored).toBe(0);
      expect(result.failed).toBe(1);
      delete process.env.AGENT_WALLET_SECRET;
    });
  });

  describe('parseAnchorMode', () => {
    it('maps "batched" to batched', () => {
      expect(parseAnchorMode('batched')).toBe('batched');
    });

    it('defaults anything else to direct', () => {
      expect(parseAnchorMode('direct')).toBe('direct');
      expect(parseAnchorMode('weird')).toBe('direct');
      expect(parseAnchorMode('')).toBe('direct');
    });
  });
});