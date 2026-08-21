import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  computeLeafHash,
  computeReceiptHash,
  serializeReceiptPreimage,
  verifyProof,
  verifyReceiptAgainstPayload,
  verifyReceiptWithLeaf,
  type ReceiptData,
} from './verify.js';
import { canonicalize, contentHash } from './canonical.js';

const testPayload = {
  data: [
    { id: 1, name: 'Alice', value: 100 },
    { id: 2, name: 'Bob', value: 200 },
  ],
  meta: {
    source: 'test',
    version: '1.0',
  },
};

function makeReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    id: 'rcpt_test',
    datasetId: 'test-dataset-1',
    buyer: 'GBUYER123456789012345678901234567890123456789012345678901234',
    seller: 'GSELLER123456789012345678901234567890123456789012345678901234',
    amount: 10.5,
    paymentToken: 'USDC',
    txHash: 'tx-test',
    leafHash: computeLeafHash(testPayload).toString('hex'),
    receiptHash: computeReceiptHash({
      leaf: computeLeafHash(testPayload),
      datasetId: 'test-dataset-1',
      buyer: 'GBUYER123456789012345678901234567890123456789012345678901234',
      amount: 10.5,
      seller: 'GSELLER123456789012345678901234567890123456789012345678901234',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    }).toString('hex'),
    anchorMode: 'direct',
    anchorStatus: 'NOT_ANCHORED_YET',
    deliveredAt: '2026-08-20T12:00:00.000Z',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('canonicalize', () => {
  it('sorts object keys by code unit order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces deterministic output for same payload', () => {
    const payload1 = { b: 1, a: 2 };
    const payload2 = { a: 2, b: 1 };
    expect(canonicalize(payload1)).toBe(canonicalize(payload2));
  });

  it('is independent of key order in nested objects', () => {
    const a = { meta: { version: '1.0', source: 'test' }, data: [{ id: 1 }] };
    const b = { data: [{ id: 1 }], meta: { source: 'test', version: '1.0' } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves -0 per RFC 8785', () => {
    expect(canonicalize({ x: -0 })).toBe('{"x":-0}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ x: NaN })).toThrow(TypeError);
  });

  it('escapes control characters', () => {
    expect(canonicalize({ s: 'a\nb' })).toBe('{"s":"a\\nb"}');
  });

  it('contentHash matches SHA256 of canonical UTF-8', () => {
    const canonical = '{"a":1}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(contentHash({ a: 1 })).toBe(expected);
  });
});

describe('serializeReceiptPreimage', () => {
  it('is deterministic', () => {
    const leaf = Buffer.alloc(32, 0xab);
    const params = {
      leaf,
      datasetId: 'dataset-1',
      buyer: 'GBUYER...',
      amount: 10.5,
      seller: 'GSELLER...',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    };
    expect(serializeReceiptPreimage(params).toString('hex')).toBe(
      serializeReceiptPreimage(params).toString('hex'),
    );
  });

  it('differs when amount changes', () => {
    const leaf = Buffer.alloc(32, 0xab);
    const base = {
      leaf,
      datasetId: 'dataset-1',
      buyer: 'GBUYER...',
      amount: 10.5,
      seller: 'GSELLER...',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    };
    expect(serializeReceiptPreimage(base).toString('hex')).not.toBe(
      serializeReceiptPreimage({ ...base, amount: 11.5 }).toString('hex'),
    );
  });

  it('length-prefixes string fields and appends amount last', () => {
    const leaf = Buffer.alloc(32, 0xab);
    const preimage = serializeReceiptPreimage({
      leaf,
      datasetId: 'dataset-1',
      buyer: 'GBUYER...',
      amount: 10.5,
      seller: 'GSELLER...',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    });
    expect(preimage.length).toBeGreaterThan(32);
    expect(preimage.subarray(0, 32).equals(leaf)).toBe(true);
  });
});

describe('computeReceiptHash', () => {
  it('returns a 64-char hex', () => {
    const leaf = computeLeafHash(testPayload);
    const hash = computeReceiptHash({
      leaf,
      datasetId: 'test-dataset-1',
      buyer: 'GBUYER...',
      amount: 10.5,
      seller: 'GSELLER...',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    });
    expect(hash.length).toBe(32);
    expect(hash.toString('hex')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any field changes', () => {
    const leaf = computeLeafHash(testPayload);
    const base = {
      leaf,
      datasetId: 'dataset-1',
      buyer: 'GBUYER...',
      amount: 10.5,
      seller: 'GSELLER...',
      deliveredAt: '2026-08-20T12:00:00.000Z',
    };
    const reference = computeReceiptHash(base).toString('hex');
    expect(computeReceiptHash({ ...base, amount: 11.5 }).toString('hex')).not.toBe(reference);
    expect(computeReceiptHash({ ...base, datasetId: 'other' }).toString('hex')).not.toBe(reference);
    expect(computeReceiptHash({ ...base, deliveredAt: '2026-08-21T12:00:00.000Z' }).toString('hex')).not.toBe(reference);
  });
});

describe('verifyProof', () => {
  it('verifies a valid proof', () => {
    const leaves = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
    const root = computeRootFromLeaves(leaves);
    // Leaf 2 (index 2) is the odd leaf: promoted at level 0 (null sibling),
    // then paired with hash(leaf0, leaf1) at level 1.
    const h01 = createHash('sha256')
      .update(Buffer.concat([Buffer.from(leaves[0]!, 'hex'), Buffer.from(leaves[1]!, 'hex')]))
      .digest('hex');
    const proof = {
      leafIndex: 2,
      leafHash: leaves[2]!,
      siblings: [null, h01],
      root,
    };
    expect(verifyProof(proof)).toBe(true);
  });

  it('rejects a tampered proof', () => {
    const leaves = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
    const root = computeRootFromLeaves(leaves);
    const h01 = createHash('sha256')
      .update(Buffer.concat([Buffer.from(leaves[0]!, 'hex'), Buffer.from(leaves[1]!, 'hex')]))
      .digest('hex');
    const proof = {
      leafIndex: 2,
      leafHash: 'ff'.repeat(32),
      siblings: [null, h01],
      root,
    };
    expect(verifyProof(proof)).toBe(false);
  });

  it('rejects a proof for the wrong root', () => {
    const leaves = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
    const h01 = createHash('sha256')
      .update(Buffer.concat([Buffer.from(leaves[0]!, 'hex'), Buffer.from(leaves[1]!, 'hex')]))
      .digest('hex');
    const proof = {
      leafIndex: 2,
      leafHash: leaves[2]!,
      siblings: [null, h01],
      root: '00'.repeat(32),
    };
    expect(verifyProof(proof)).toBe(false);
  });
});

describe('verifyReceiptAgainstPayload', () => {
  it('passes for a matching payload and stored hashes', () => {
    const receipt = makeReceipt();
    const result = verifyReceiptAgainstPayload(receipt, testPayload);
    expect(result.valid).toBe(true);
    expect(result.leafHashMatches).toBe(true);
    expect(result.receiptHashMatches).toBe(true);
    expect(result.merkleProofValid).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('fails when the payload does not match', () => {
    const receipt = makeReceipt();
    const result = verifyReceiptAgainstPayload(receipt, { data: [] });
    expect(result.valid).toBe(false);
    expect(result.leafHashMatches).toBe(false);
    expect(result.receiptHashMatches).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails when stored receipt hash is tampered', () => {
    const receipt = makeReceipt({ receiptHash: '00'.repeat(32) });
    const result = verifyReceiptAgainstPayload(receipt, testPayload);
    expect(result.valid).toBe(false);
    expect(result.receiptHashMatches).toBe(false);
  });

  it('passes when anchored with a valid merkle proof', () => {
    const leaf = computeLeafHash(testPayload).toString('hex');
    const root = computeRootFromLeaves([leaf]);
    const receipt = makeReceipt({
      anchorStatus: 'ANCHORED',
      anchorTxHash: 'tx-anchor',
      merkleRoot: root,
      merkleIndex: 0,
      merkleProof: [],
    });
    const result = verifyReceiptAgainstPayload(receipt, testPayload);
    expect(result.merkleProofValid).toBe(true);
    expect(result.anchorVerified).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('fails when an invalid merkle proof is stored', () => {
    const receipt = makeReceipt({
      anchorStatus: 'ANCHORED',
      anchorTxHash: 'tx-anchor',
      merkleRoot: '11'.repeat(32),
      merkleIndex: 0,
      merkleProof: ['ff'.repeat(32), 'ff'.repeat(32)],
    });
    const result = verifyReceiptAgainstPayload(receipt, testPayload);
    expect(result.merkleProofValid).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Merkle proof invalid');
  });

  it('fails when anchor status is failed', () => {
    const receipt = makeReceipt({ anchorStatus: 'ANCHOR_FAILED' });
    const result = verifyReceiptAgainstPayload(receipt, testPayload);
    expect(result.valid).toBe(false);
  });
});

describe('verifyReceiptWithLeaf', () => {
  it('passes when the supplied leaf hash matches', () => {
    const receipt = makeReceipt();
    const leaf = computeLeafHash(testPayload).toString('hex');
    const result = verifyReceiptWithLeaf(receipt, leaf);
    expect(result.valid).toBe(true);
    expect(result.leafHashMatches).toBe(true);
    expect(result.receiptHashMatches).toBe(true);
  });

  it('fails when the supplied leaf hash does not match', () => {
    const receipt = makeReceipt();
    const result = verifyReceiptWithLeaf(receipt, 'ff'.repeat(32));
    expect(result.valid).toBe(false);
    expect(result.leafHashMatches).toBe(false);
    expect(result.receiptHashMatches).toBe(false);
  });

  it('checks the merkle proof against the supplied leaf', () => {
    const receipt = makeReceipt({
      anchorStatus: 'ANCHORED',
      anchorTxHash: 'tx-anchor',
      merkleRoot: '11'.repeat(32),
      merkleIndex: 0,
      merkleProof: ['ff'.repeat(32), 'ff'.repeat(32)],
    });
    const leaf = computeLeafHash(testPayload).toString('hex');
    const result = verifyReceiptWithLeaf(receipt, leaf);
    expect(result.merkleProofValid).toBe(false);
    expect(result.valid).toBe(false);
  });
});

function computeRootFromLeaves(leaves: string[]): string {
  let current: Buffer<ArrayBufferLike>[] = leaves.map(l => Buffer.from(l, 'hex'));
  while (current.length > 1) {
    const next: Buffer<ArrayBufferLike>[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(
          createHash('sha256')
            .update(Buffer.concat([current[i]!, current[i + 1]!]))
            .digest(),
        );
      } else {
        next.push(current[i]!);
      }
    }
    current = next;
  }
  return current[0]!.toString('hex');
}