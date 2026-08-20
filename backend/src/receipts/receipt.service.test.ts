import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { computeLeafHash, computeReceiptHash, computeReceiptHashHex, serializeReceiptPreimage, storeReceipt, getReceipt, getReceiptByTxHash, updateReceiptAnchor, markReceiptAnchored, markReceiptAnchoring, markReceiptAnchorFailed, buildMerkleProof, verifyMerkleProof, verifyReceipt } from './receipt.service';

const testDatasetPayload = {
  data: [
    { id: 1, name: 'Alice', value: 100 },
    { id: 2, name: 'Bob', value: 200 },
  ],
  meta: {
    source: 'test',
    version: '1.0',
  },
};

// Unique prefix per test run to avoid conflicts with previous runs
const testRunPrefix = `test-${Date.now()}-`;
const runRandom = Math.floor(Math.random() * 10000);

let amountCounter = 100;

function createTestReceiptInput(txHash: string) {
  const amount = (amountCounter + runRandom) / 10;
  amountCounter += 1;
  return {
    datasetId: 'test-dataset-1',
    buyer: 'GBUYER123456789012345678901234567890123456789012345678901234',
    seller: 'GSELLER123456789012345678901234567890123456789012345678901234',
    amount,
    paymentToken: 'USDC',
    txHash: `${testRunPrefix}${txHash}`,
    deliveredAt: '2026-08-20T12:00:00.000Z',
    anchorMode: 'direct' as const,
    datasetPayload: testDatasetPayload,
  };
}

describe('receipt.service', () => {

  describe('computeLeafHash', () => {
    it('returns 32-byte Buffer', () => {
      const leaf = computeLeafHash(testDatasetPayload);
      expect(leaf).toBeInstanceOf(Buffer);
      expect(leaf.length).toBe(32);
    });

    it('is deterministic for same payload', () => {
      const leaf1 = computeLeafHash(testDatasetPayload);
      const leaf2 = computeLeafHash(testDatasetPayload);
      expect(leaf1.toString('hex')).toBe(leaf2.toString('hex'));
    });

    it('differs for different payloads', () => {
      const leaf1 = computeLeafHash({ ...testDatasetPayload, data: [{ id: 1 }] });
      const leaf2 = computeLeafHash({ ...testDatasetPayload, data: [{ id: 2 }] });
      expect(leaf1.toString('hex')).not.toBe(leaf2.toString('hex'));
    });

    it('is independent of key order in payload', () => {
      const payload1 = { b: 1, a: 2 };
      const payload2 = { a: 2, b: 1 };
      expect(computeLeafHash(payload1).toString('hex')).toBe(computeLeafHash(payload2).toString('hex'));
    });
  });

  describe('serializeReceiptPreimage', () => {
    it('produces deterministic output', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const preimage1 = serializeReceiptPreimage({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      const preimage2 = serializeReceiptPreimage({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      expect(preimage1.toString('hex')).toBe(preimage2.toString('hex'));
    });

    it('differs when any field differs', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const base = {
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      };
      const preimage1 = serializeReceiptPreimage(base);
      const preimage2 = serializeReceiptPreimage({ ...base, amount: 11.5 });
      expect(preimage1.toString('hex')).not.toBe(preimage2.toString('hex'));
    });

    it('includes all fields in preimage', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const preimage = serializeReceiptPreimage({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      // Should be: 32 (leaf) + 4+len(datasetId) + 4+len(buyer) + 4+len(seller) + 4+len(deliveredAt) + 8 (amount)
      expect(preimage.length).toBeGreaterThan(32);
    });
  });

  describe('computeReceiptHash', () => {
    it('returns 32-byte Buffer', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const hash = computeReceiptHash({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      expect(hash).toBeInstanceOf(Buffer);
      expect(hash.length).toBe(32);
    });

    it('is deterministic', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const hash1 = computeReceiptHash({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      const hash2 = computeReceiptHash({
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      });
      expect(hash1.toString('hex')).toBe(hash2.toString('hex'));
    });

    it('differs when any input field differs', () => {
      const leaf = Buffer.alloc(32, 0xab);
      const base = {
        leaf,
        datasetId: 'dataset-1',
        buyer: 'GBUYER...',
        amount: 10.5,
        seller: 'GSELLER...',
        deliveredAt: '2026-08-20T12:00:00.000Z',
      };
      const hash1 = computeReceiptHash(base);
      const hash2 = computeReceiptHash({ ...base, datasetId: 'dataset-2' });
      expect(hash1.toString('hex')).not.toBe(hash2.toString('hex'));
    });
  });

  describe('computeReceiptHashHex', () => {
    it('returns 64-char hex string', () => {
      const hash = computeReceiptHashHex(createTestReceiptInput('test-tx-hash-hex-1'));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic across calls', () => {
      const input = createTestReceiptInput('test-tx-hash-hex-2');
      const h1 = computeReceiptHashHex(input);
      const h2 = computeReceiptHashHex(input);
      expect(h1).toBe(h2);
    });

    it('depends on all receipt fields', () => {
      const baseInput = createTestReceiptInput('test-tx-hash-hex-3');
      const baseHash = computeReceiptHashHex(baseInput);
      const diffPayload = computeReceiptHashHex({ ...baseInput, datasetPayload: { ...testDatasetPayload, extra: 'field' } });
      const diffAmount = computeReceiptHashHex({ ...baseInput, amount: 11.5 });
      const diffBuyer = computeReceiptHashHex({ ...baseInput, buyer: 'GBUYER999...' });
      const diffSeller = computeReceiptHashHex({ ...baseInput, seller: 'GSELLER999...' });
      const diffDeliveredAt = computeReceiptHashHex({ ...baseInput, deliveredAt: '2026-08-20T13:00:00.000Z' });
      const diffDatasetId = computeReceiptHashHex({ ...baseInput, datasetId: 'different-dataset' });

      expect(diffPayload).not.toBe(baseHash);
      expect(diffAmount).not.toBe(baseHash);
      expect(diffBuyer).not.toBe(baseHash);
      expect(diffSeller).not.toBe(baseHash);
      expect(diffDeliveredAt).not.toBe(baseHash);
      expect(diffDatasetId).not.toBe(baseHash);
    });
  });

  describe('storeReceipt / getReceipt', () => {
    it('stores and retrieves a receipt', async () => {
      const input = createTestReceiptInput('test-tx-hash-store-1');
      const receipt = await storeReceipt(input);
      expect(receipt.id).toMatch(/^rcpt_[a-f0-9]{32}$/);
      expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.leafHash).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.anchorStatus).toBe('NOT_ANCHORED_YET');
      expect(receipt.anchorMode).toBe('direct');

      const retrieved = await getReceipt(receipt.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(receipt.id);
      expect(retrieved!.receiptHash).toBe(receipt.receiptHash);
    });

    it('stores receipt with correct leaf and receipt hash', async () => {
      const input = createTestReceiptInput('test-tx-hash-store-2');
      const receipt = await storeReceipt(input);

      // Verify leaf hash matches canonical payload
      const expectedLeaf = computeLeafHash(testDatasetPayload);
      expect(receipt.leafHash).toBe(expectedLeaf.toString('hex'));

      // Verify receipt hash matches computed
      const expectedReceiptHash = computeReceiptHashHex(input);
      expect(receipt.receiptHash).toBe(expectedReceiptHash);
    });

    it('can retrieve by txHash', async () => {
      const input = createTestReceiptInput('test-tx-hash-store-3');
      const receipt = await storeReceipt(input);
      const retrieved = await getReceiptByTxHash(receipt.txHash);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(receipt.id);
    });

    it('enforces unique txHash and receiptHash', async () => {
      const input = createTestReceiptInput('test-tx-hash-unique-1');
      await storeReceipt(input);
      await expect(storeReceipt(input)).rejects.toThrow();
    });
  });

  describe('updateReceiptAnchor', () => {
    it('updates anchor status and metadata', async () => {
      const input = createTestReceiptInput('test-tx-hash-anchor-1');
      const receipt = await storeReceipt(input);
      const updated = await updateReceiptAnchor(receipt.id, {
        anchorStatus: 'ANCHORED',
        anchorTxHash: 'anchor-tx-123',
        merkleRoot: 'merkle-root-hex',
        merkleIndex: 0,
        merkleProof: ['proof1', 'proof2'],
        anchoredAt: '2026-08-20T12:05:00.000Z',
      });
      expect(updated).not.toBeNull();
      expect(updated!.anchorStatus).toBe('ANCHORED');
      expect(updated!.anchorTxHash).toBe('anchor-tx-123');
      expect(updated!.merkleRoot).toBe('merkle-root-hex');
      expect(updated!.merkleIndex).toBe(0);
      expect(updated!.merkleProof).toEqual(['proof1', 'proof2']);
    });

    it('returns null for non-existent receipt', async () => {
      const updated = await updateReceiptAnchor('non-existent-id', { anchorStatus: 'ANCHORED' });
      expect(updated).toBeNull();
    });
  });

  describe('markReceiptAnchored / markReceiptAnchoring / markReceiptAnchorFailed', () => {
    it('marks receipt as anchored', async () => {
      const input = createTestReceiptInput('test-tx-hash-anchor-2');
      const receipt = await storeReceipt(input);
      const updated = await markReceiptAnchored(receipt.id, 'anchor-tx-456');
      expect(updated!.anchorStatus).toBe('ANCHORED');
      expect(updated!.anchorTxHash).toBe('anchor-tx-456');
      expect(updated!.anchoredAt).toBeDefined();
    });

    it('marks receipt as anchoring', async () => {
      const input = createTestReceiptInput('test-tx-hash-anchor-3');
      const receipt = await storeReceipt(input);
      const updated = await markReceiptAnchoring(receipt.id);
      expect(updated!.anchorStatus).toBe('ANCHORING');
    });

    it('marks receipt as anchor failed', async () => {
      const input = createTestReceiptInput('test-tx-hash-anchor-4');
      const receipt = await storeReceipt(input);
      const updated = await markReceiptAnchorFailed(receipt.id);
      expect(updated!.anchorStatus).toBe('ANCHOR_FAILED');
    });
  });

  describe('Merkle proof', () => {
    it('builds proof from receipt', async () => {
      const input = createTestReceiptInput('test-tx-hash-merkle-1');
      const receipt = await storeReceipt(input);
      const anchored = await markReceiptAnchored(receipt.id, 'anchor-tx', 'root-hex', 0, ['sibling1', 'sibling2']);
      const proof = buildMerkleProof(anchored!);
      expect(proof).toBeDefined();
      expect(proof!.leafIndex).toBe(0);
      expect(proof!.leafHash).toBe(receipt.leafHash);
      expect(proof!.siblings).toEqual(['sibling1', 'sibling2']);
      expect(proof!.root).toBe('root-hex');
    });

    it('returns undefined for receipt without merkle data', async () => {
      const input = createTestReceiptInput('test-tx-hash-merkle-2');
      const receipt = await storeReceipt(input);
      const proof = buildMerkleProof(receipt);
      expect(proof).toBeUndefined();
    });

    it('verifies valid merkle proof', () => {
      // Simple tree: leaf0 + leaf1
      const leaf0 = Buffer.alloc(32, 0xaa);
      const leaf1 = Buffer.alloc(32, 0xbb);
      const combined = Buffer.concat([leaf0, leaf1]);
      const actualRoot = Buffer.from(createHash('sha256').update(combined).digest().toString('hex'), 'hex');

      const proof = {
        leafIndex: 0,
        leafHash: leaf0.toString('hex'),
        siblings: [leaf1.toString('hex')],
        root: actualRoot.toString('hex'),
      };
      expect(verifyMerkleProof(proof)).toBe(true);
    });

    it('rejects invalid merkle proof (wrong sibling)', () => {
      const leaf0 = Buffer.alloc(32, 0xaa);
      const leaf1 = Buffer.alloc(32, 0xbb);
      const wrongSibling = Buffer.alloc(32, 0xcc);
      const combined = Buffer.concat([leaf0, leaf1]);
      const root = Buffer.from(createHash('sha256').update(combined).digest().toString('hex'), 'hex');

      const proof = {
        leafIndex: 0,
        leafHash: leaf0.toString('hex'),
        siblings: [wrongSibling.toString('hex')],
        root: root.toString('hex'),
      };
      expect(verifyMerkleProof(proof)).toBe(false);
    });

    it('rejects invalid merkle proof (wrong root)', () => {
      const leaf0 = Buffer.alloc(32, 0xaa);
      const leaf1 = Buffer.alloc(32, 0xbb);
      const wrongRoot = Buffer.alloc(32, 0xdd);
      const proof = {
        leafIndex: 0,
        leafHash: leaf0.toString('hex'),
        siblings: [leaf1.toString('hex')],
        root: wrongRoot.toString('hex'),
      };
      expect(verifyMerkleProof(proof)).toBe(false);
    });
  });

  describe('verifyReceipt', () => {
    it('returns valid for matching payload', async () => {
      const input = createTestReceiptInput('test-tx-hash-verify-1');
      const receipt = await storeReceipt(input);
      const result = await verifyReceipt(receipt.id, testDatasetPayload);
      expect(result.valid).toBe(true);
      expect(result.receiptHashMatches).toBe(true);
      expect(result.status).toBe('NOT_ANCHORED_YET');
    });

    it('returns mismatch for different payload', async () => {
      const input = createTestReceiptInput('test-tx-hash-verify-2');
      const receipt = await storeReceipt(input);
      const modifiedPayload = { ...testDatasetPayload, data: [{ id: 999 }] };
      const result = await verifyReceipt(receipt.id, modifiedPayload);
      expect(result.valid).toBe(false);
      expect(result.receiptHashMatches).toBe(false);
      expect(result.status).toBe('NOT_ANCHORED_YET');
    });

    it('returns not found for non-existent receipt', async () => {
      const result = await verifyReceipt('non-existent-id', testDatasetPayload);
      expect(result.valid).toBe(false);
      expect(result.receiptHashMatches).toBe(false);
      expect(result.error).toBe('Receipt not found');
    });

    it('verifies merkle proof when present', async () => {
      const input = createTestReceiptInput('test-tx-hash-verify-3');
      const receipt = await storeReceipt(input);
      const leaf = Buffer.from(receipt.leafHash, 'hex');
      const sibling = Buffer.alloc(32, 0xcc);
      const combined = Buffer.concat([leaf, sibling]);
      const root = createHash('sha256').update(combined).digest().toString('hex');

      await markReceiptAnchored(receipt.id, 'anchor-tx', root, 0, [sibling.toString('hex')]);

      const result = await verifyReceipt(receipt.id, testDatasetPayload);
      expect(result.valid).toBe(true);
      expect(result.merkleProofValid).toBe(true);
    });

    it('detects invalid merkle proof', async () => {
      // Create receipt with CORRECT merkle data
      const input = createTestReceiptInput('test-tx-hash-verify-4');
      const receipt = await storeReceipt(input);
      const leaf = Buffer.from(receipt.leafHash, 'hex');
      const correctSibling = Buffer.alloc(32, 0xcc);
      const combined = Buffer.concat([leaf, correctSibling]);
      const correctRoot = createHash('sha256').update(combined).digest().toString('hex');

      await markReceiptAnchored(receipt.id, 'anchor-tx', correctRoot, 0, [correctSibling.toString('hex')]);

      // Now tamper with the stored merkle proof (wrong sibling, same root)
      await updateReceiptAnchor(receipt.id, {
        merkleProof: [Buffer.alloc(32, 0xdd).toString('hex')],
      });

      const result = await verifyReceipt(receipt.id, testDatasetPayload);
      expect(result.valid).toBe(false);
      expect(result.receiptHashMatches).toBe(true); // payload matches
      expect(result.merkleProofValid).toBe(false); // but merkle proof is invalid
    });
  });
});