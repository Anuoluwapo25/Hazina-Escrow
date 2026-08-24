/**
 * verify.ts — core receipt verification for the offline verifier.
 *
 * Recomputes the leaf hash and receipt hash from the delivered payload and
 * receipt metadata, then checks the Merkle proof against the anchored root.
 * This mirrors the backend's receipt.service.ts commit scheme exactly.
 */

import { createHash } from 'crypto';
import { contentHashBytes } from './canonical.js';

export interface ReceiptData {
  id: string;
  datasetId: string;
  buyer: string;
  seller: string;
  amount: number;
  paymentToken: string;
  txHash: string;
  leafHash: string;
  receiptHash: string;
  anchorMode: 'direct' | 'batched';
  anchorStatus: string;
  anchorTxHash?: string;
  merkleRoot?: string;
  merkleIndex?: number;
  merkleProof?: (string | null)[];
  deliveredAt: string;
  anchoredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerkleProofData {
  leafIndex: number;
  leafHash: string;
  siblings: (string | null)[];
  root: string;
}

/**
 * Deterministic serialization of the receipt preimage. Field order and
 * encoding must match the backend exactly: leaf (32 raw bytes), then
 * datasetId, buyer, seller, deliveredAt as 4-byte-BE-length-prefixed UTF-8,
 * then amount as 8-byte big-endian float64.
 */
export function serializeReceiptPreimage(params: {
  leaf: Buffer;
  datasetId: string;
  buyer: string;
  amount: number;
  seller: string;
  deliveredAt: string;
}): Buffer {
  const parts: Buffer[] = [];

  parts.push(params.leaf);

  for (const field of [params.datasetId, params.buyer, params.seller, params.deliveredAt]) {
    const buf = Buffer.from(field, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(buf.length, 0);
    parts.push(lenBuf);
    parts.push(buf);
  }

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeDoubleBE(params.amount, 0);
  parts.push(amountBuf);

  return Buffer.concat(parts);
}

/** Leaf hash: SHA256(JCS(datasetPayload)). Returns 32 raw bytes. */
export function computeLeafHash(payload: Record<string, unknown>): Buffer {
  return contentHashBytes(payload);
}

/** Receipt hash: SHA256 of the serialized preimage. Returns 32 raw bytes. */
export function computeReceiptHash(params: {
  leaf: Buffer;
  datasetId: string;
  buyer: string;
  amount: number;
  seller: string;
  deliveredAt: string;
}): Buffer {
  const preimage = serializeReceiptPreimage(params);
  return createHash('sha256').update(preimage).digest();
}

/** Verify a Merkle inclusion proof against the anchored root. */
export function verifyProof(proof: MerkleProofData): boolean {
  let currentHash: Buffer = Buffer.from(proof.leafHash, 'hex');
  let currentIndex = proof.leafIndex;

  for (const siblingHex of proof.siblings) {
    if (siblingHex !== null) {
      const sibling = Buffer.from(siblingHex, 'hex');
      const isRightNode = currentIndex % 2 === 1;
      if (isRightNode) {
        currentHash = hashPair(sibling, currentHash);
      } else {
        currentHash = hashPair(currentHash, sibling);
      }
    }
    currentIndex = Math.floor(currentIndex / 2);
  }

  return currentHash.toString('hex') === proof.root;
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.concat([left, right])).digest();
}

export interface VerificationResult {
  /** True when every check that could run passed. */
  valid: boolean;
  /** Recomputed leaf hash (hex). */
  computedLeafHash: string;
  /** Recomputed receipt hash (hex). */
  computedReceiptHash: string;
  /** True when the recomputed leaf hash matches the stored one. */
  leafHashMatches: boolean;
  /** True when the recomputed receipt hash matches the stored one. */
  receiptHashMatches: boolean;
  /** Undefined when the receipt has no anchored merkle proof. */
  merkleProofValid: boolean | undefined;
  /** Undefined when the receipt has no anchor transaction. */
  anchorVerified: boolean | undefined;
  errors: string[];
}

/**
 * Verify a receipt against a delivered payload. Payload must be the exact
 * dataset payload object that was delivered at purchase time.
 */
export function verifyReceiptAgainstPayload(
  receipt: ReceiptData,
  payload: Record<string, unknown>,
): VerificationResult {
  const leaf = computeLeafHash(payload);
  return verifyReceiptWithLeaf(receipt, leaf.toString('hex'));
}

/**
 * Verify a receipt against a pre-computed leaf hash. Use when the delivered
 * payload is not available but the leaf hash was recorded at delivery time.
 * The leaf hash is the SHA256 of the JCS-canonicalized payload.
 */
export function verifyReceiptWithLeaf(receipt: ReceiptData, leafHash: string): VerificationResult {
  const errors: string[] = [];

  const computedReceiptHash = computeReceiptHash({
    leaf: Buffer.from(leafHash, 'hex'),
    datasetId: receipt.datasetId,
    buyer: receipt.buyer,
    amount: receipt.amount,
    seller: receipt.seller,
    deliveredAt: receipt.deliveredAt,
  });

  const computedReceiptHex = computedReceiptHash.toString('hex');

  const leafHashMatches = leafHash === receipt.leafHash;
  if (!leafHashMatches) {
    errors.push('Leaf hash mismatch: supplied leaf hash differs from the stored one.');
  }

  const receiptHashMatches = computedReceiptHex === receipt.receiptHash;
  if (!receiptHashMatches) {
    errors.push('Receipt hash mismatch: payload + metadata do not hash to the stored receipt hash.');
  }

  let merkleProofValid: boolean | undefined;
  if (
    receipt.merkleRoot &&
    receipt.merkleIndex !== undefined &&
    receipt.merkleProof
  ) {
    merkleProofValid = verifyProof({
      leafIndex: receipt.merkleIndex,
      leafHash: receipt.leafHash,
      siblings: receipt.merkleProof,
      root: receipt.merkleRoot,
    });
    if (!merkleProofValid) {
      errors.push('Merkle proof invalid: the leaf is not committed in the anchored root.');
    }
  }

  const anchorVerified =
    receipt.anchorStatus === 'ANCHORED' || receipt.anchorStatus === 'VERIFIED';

  return {
    valid:
      leafHashMatches &&
      receiptHashMatches &&
      (merkleProofValid !== false) &&
      (receipt.anchorStatus === 'NOT_ANCHORED_YET' || anchorVerified),
    computedLeafHash: leafHash,
    computedReceiptHash: computedReceiptHex,
    leafHashMatches,
    receiptHashMatches,
    merkleProofValid,
    anchorVerified: receipt.anchorTxHash ? anchorVerified : undefined,
    errors,
  };
}