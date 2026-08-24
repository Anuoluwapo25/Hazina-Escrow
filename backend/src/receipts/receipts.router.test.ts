import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetReceipt, mockBuildMerkleProof, mockVerifyReceipt } = vi.hoisted(() => ({
  mockGetReceipt: vi.fn<(id: string) => Promise<unknown>>(),
  mockBuildMerkleProof: vi.fn<(receipt: unknown) => unknown>(),
  mockVerifyReceipt: vi.fn<(id: string) => Promise<unknown>>(),
}));

vi.mock('./receipt.service', () => ({
  getReceipt: mockGetReceipt,
  buildMerkleProof: mockBuildMerkleProof,
  verifyReceipt: mockVerifyReceipt,
}));

import { receiptsRouter } from './receipts.router';
import { buildMerkleProof, verifyReceipt } from './receipt.service';
import type { Receipt, ReceiptMerkleProof } from './types';

let app: Express;

const anchoredReceipt: Receipt = {
  id: 'rcpt_anchor',
  datasetId: 'ds-test-1',
  buyer: `G${'A'.repeat(55)}`,
  seller: `G${'B'.repeat(55)}`,
  amount: 1,
  paymentToken: 'USDC',
  txHash: 'tx-anchored',
  leafHash: '11'.repeat(32),
  receiptHash: '22'.repeat(32),
  anchorMode: 'direct',
  anchorStatus: 'ANCHORED',
  anchorTxHash: 'tx-anchor-hash',
  deliveredAt: '2026-01-01T00:00:00.000Z',
  anchoredAt: '2026-01-01T00:01:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
};

const pendingReceipt: Receipt = {
  ...anchoredReceipt,
  id: 'rcpt_pending',
  txHash: 'tx-pending',
  anchorStatus: 'NOT_ANCHORED_YET',
  anchoredAt: undefined,
};

const merkleProof: ReceiptMerkleProof = {
  leafIndex: 0,
  leafHash: '11'.repeat(32),
  siblings: [null, '33'.repeat(32)],
  root: '44'.repeat(32),
};

beforeEach(() => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/receipts', receiptsRouter);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /receipts/:id', () => {
  it('returns 400 when id is missing', async () => {
    const res = await request(app).get('/receipts/');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the receipt does not exist', async () => {
    mockGetReceipt.mockResolvedValue(undefined);
    const res = await request(app).get('/receipts/rcpt_missing');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Receipt not found');
  });

  it('returns the receipt, merkle proof, and verification for an anchored receipt', async () => {
    mockGetReceipt.mockResolvedValue(anchoredReceipt);
    mockBuildMerkleProof.mockReturnValue(merkleProof);
    mockVerifyReceipt.mockResolvedValue({
      valid: true,
      receiptHashMatches: true,
      merkleProofValid: true,
      anchorVerified: true,
      anchorTxHash: 'tx-anchor-hash',
      status: 'ANCHORED',
    });

    const res = await request(app).get('/receipts/rcpt_anchor');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.receipt.id).toBe('rcpt_anchor');
    expect(res.body.merkleProof).toEqual(merkleProof);
    expect(res.body.verification.valid).toBe(true);
    expect(res.body.verification.anchorVerified).toBe(true);
    expect(buildMerkleProof).toHaveBeenCalledWith(anchoredReceipt);
    expect(verifyReceipt).toHaveBeenCalledWith('rcpt_anchor');
  });

  it('omits the merkle proof when the receipt is not yet anchored', async () => {
    mockGetReceipt.mockResolvedValue(pendingReceipt);
    mockBuildMerkleProof.mockReturnValue(undefined);
    mockVerifyReceipt.mockResolvedValue({
      valid: true,
      receiptHashMatches: true,
      merkleProofValid: undefined,
      anchorVerified: false,
      status: 'NOT_ANCHORED_YET',
    });

    const res = await request(app).get('/receipts/rcpt_pending');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.receipt.anchorStatus).toBe('NOT_ANCHORED_YET');
    expect(res.body.merkleProof).toBeUndefined();
    expect(res.body.verification.anchorVerified).toBe(false);
  });

  it('returns 502 when the service throws', async () => {
    mockGetReceipt.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/receipts/rcpt_boom');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Failed to load receipt');
  });
});
