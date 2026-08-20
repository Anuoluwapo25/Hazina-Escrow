/**
 * receipt.service.ts — Verifiable delivery receipt service.
 *
 * Responsibilities:
 * - Construct receipt commitments from delivered payloads
 * - Compute leaf hash (SHA256 of RFC 8785 canonical payload)
 * - Compute receipt hash (SHA256 of structured preimage)
 * - Store and retrieve receipts
 * - Manage anchoring metadata (Merkle proofs, anchor status)
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { contentHashBytes } from './canonical';
import type {
  Receipt,
  ReceiptCreateInput,
  ReceiptAnchorMode,
  ReceiptAnchorStatus,
  ReceiptMerkleProof,
} from './types';
import db from '../db/client';
import { receiptsSqlite } from '../db/schema';
import { eq, inArray, and } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { verifyProof as verifyMerkleProofFromTree } from './merkle';

const RECEIPT_ID_PREFIX = 'rcpt_';

function generateReceiptId(): string {
  return `${RECEIPT_ID_PREFIX}${uuidv4().replace(/-/g, '')}`;
}

/**
 * Deterministic serialization for receipt preimage.
 * Each field is length-prefixed (4-byte big-endian) to avoid ambiguity.
 * Format:
 *   leaf (32 bytes)
 *   dataset_id (length-prefixed UTF-8)
 *   buyer (length-prefixed UTF-8)
 *   amount (8-byte big-endian float64 IEEE 754)
 *   seller (length-prefixed UTF-8)
 *   delivered_at (length-prefixed UTF-8 ISO 8601)
 */
function serializeReceiptPreimage(params: {
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

/**
 * Compute the leaf hash: SHA256(JCS(dataset_payload))
 * Returns 32-byte Buffer.
 */
export function computeLeafHash(datasetPayload: Record<string, unknown>): Buffer {
  return contentHashBytes(datasetPayload);
}

/**
 * Compute the receipt hash from structured components.
 * Returns 32-byte Buffer.
 */
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

/**
 * Serialize receipt preimage for independent verification.
 * Exported for testing and CLI verification.
 */
export { serializeReceiptPreimage };

/**
 * Compute the receipt hash directly from dataset payload and metadata.
 * Returns hex string (64 chars).
 */
export function computeReceiptHashHex(input: ReceiptCreateInput): string {
  const leaf = computeLeafHash(input.datasetPayload);
  const receiptHash = computeReceiptHash({
    leaf,
    datasetId: input.datasetId,
    buyer: input.buyer,
    amount: input.amount,
    seller: input.seller,
    deliveredAt: input.deliveredAt,
  });
  return receiptHash.toString('hex');
}

/**
 * Store a new receipt in the database.
 */
export async function storeReceipt(input: ReceiptCreateInput): Promise<Receipt> {
  const leaf = computeLeafHash(input.datasetPayload);
  const receiptHash = computeReceiptHash({
    leaf,
    datasetId: input.datasetId,
    buyer: input.buyer,
    amount: input.amount,
    seller: input.seller,
    deliveredAt: input.deliveredAt,
  });

  const now = new Date().toISOString();
  const receipt: Receipt = {
    id: generateReceiptId(),
    datasetId: input.datasetId,
    buyer: input.buyer,
    seller: input.seller,
    amount: input.amount,
    paymentToken: input.paymentToken,
    txHash: input.txHash,
    leafHash: leaf.toString('hex'),
    receiptHash: receiptHash.toString('hex'),
    anchorMode: input.anchorMode,
    anchorStatus: 'NOT_ANCHORED_YET',
    deliveredAt: input.deliveredAt,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(receiptsSqlite).values(receiptToRow(receipt));
  logger.info(`[Receipt] Created receipt ${receipt.id} for tx ${input.txHash}`);
  return receipt;
}

/**
 * Get a receipt by its ID.
 */
export async function getReceipt(id: string): Promise<Receipt | undefined> {
  const result = await db
    .select()
    .from(receiptsSqlite)
    .where(eq(receiptsSqlite.id, id))
    .limit(1);
  return result[0] ? rowToReceipt(result[0]) : undefined;
}

/**
 * Get a receipt by transaction hash.
 */
export async function getReceiptByTxHash(txHash: string): Promise<Receipt | undefined> {
  const result = await db
    .select()
    .from(receiptsSqlite)
    .where(eq(receiptsSqlite.txHash, txHash))
    .limit(1);
  return result[0] ? rowToReceipt(result[0]) : undefined;
}

/**
 * Get receipts for a dataset.
 */
export async function getReceiptsByDataset(datasetId: string): Promise<Receipt[]> {
  const result = await db
    .select()
    .from(receiptsSqlite)
    .where(eq(receiptsSqlite.datasetId, datasetId));
  return result.map(rowToReceipt);
}

/**
 * Get receipts that still need anchoring (NOT_ANCHORED_YET, ANCHORING, or
 * ANCHOR_FAILED), ordered oldest-first. Pass a mode to filter direct vs
 * batched anchoring. Limit bounds the batch size for a single sweep.
 */
export async function getPendingReceipts(
  opts: { mode?: ReceiptAnchorMode; limit?: number; statuses?: ReceiptAnchorStatus[] } = {},
): Promise<Receipt[]> {
  const statuses = opts.statuses ?? ['NOT_ANCHORED_YET', 'ANCHORING', 'ANCHOR_FAILED'];
  const conditions = [inArray(receiptsSqlite.anchorStatus, statuses)];
  if (opts.mode) {
    conditions.push(eq(receiptsSqlite.anchorMode, opts.mode));
  }

  const result = await db
    .select()
    .from(receiptsSqlite)
    .where(and(...conditions))
    .limit(opts.limit ?? 50);

  return result.map(rowToReceipt);
}

/**
 * Update receipt anchor status and metadata.
 */
export async function updateReceiptAnchor(
  receiptId: string,
  updates: Partial<Pick<Receipt, 'anchorStatus' | 'anchorTxHash' | 'merkleRoot' | 'merkleIndex' | 'merkleProof' | 'anchoredAt'>>,
): Promise<Receipt | null> {
  const existing = await getReceipt(receiptId);
  if (!existing) return null;

  const merged: Receipt = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await db
    .update(receiptsSqlite)
    .set(receiptToRow(merged))
    .where(eq(receiptsSqlite.id, receiptId));

  return merged;
}

/**
 * Set receipt anchor status to ANCHORED with transaction hash.
 */
export async function markReceiptAnchored(
  receiptId: string,
  anchorTxHash: string,
  merkleRoot?: string,
  merkleIndex?: number,
  merkleProof?: (string | null)[],
): Promise<Receipt | null> {
  return updateReceiptAnchor(receiptId, {
    anchorStatus: 'ANCHORED',
    anchorTxHash,
    merkleRoot,
    merkleIndex,
    merkleProof,
    anchoredAt: new Date().toISOString(),
  });
}

/**
 * Set receipt anchor status to ANCHOR_FAILED.
 */
export async function markReceiptAnchorFailed(receiptId: string): Promise<Receipt | null> {
  return updateReceiptAnchor(receiptId, {
    anchorStatus: 'ANCHOR_FAILED',
  });
}

/**
 * Set receipt anchor status to ANCHORING (in progress).
 */
export async function markReceiptAnchoring(receiptId: string): Promise<Receipt | null> {
  return updateReceiptAnchor(receiptId, {
    anchorStatus: 'ANCHORING',
  });
}

/**
 * Build a Merkle proof object for a receipt.
 */
export function buildMerkleProof(receipt: Receipt): ReceiptMerkleProof | undefined {
  if (!receipt.merkleRoot || receipt.merkleIndex === undefined || !receipt.merkleProof) {
    return undefined;
  }
  return {
    leafIndex: receipt.merkleIndex,
    leafHash: receipt.leafHash,
    siblings: receipt.merkleProof,
    root: receipt.merkleRoot,
  };
}

/**
 * Verify a receipt's Merkle proof against its root.
 * Returns true if the proof is valid.
 */
export function verifyMerkleProof(proof: ReceiptMerkleProof): boolean {
  return verifyMerkleProofFromTree(proof);
}

/**
 * Verify a receipt against its stored data and optional delivered payload.
 * If deliveredPayload is provided, recomputes hashes and checks for mismatch.
 */
export async function verifyReceipt(
  receiptId: string,
  deliveredPayload?: Record<string, unknown>,
): Promise<{
  valid: boolean;
  receiptHashMatches: boolean;
  merkleProofValid?: boolean;
  anchorVerified?: boolean;
  anchorTxHash?: string;
  status: ReceiptAnchorStatus;
  error?: string;
}> {
  const receipt = await getReceipt(receiptId);
  if (!receipt) {
    return { valid: false, receiptHashMatches: false, status: 'MISMATCH', error: 'Receipt not found' };
  }

  let receiptHashMatches = true;

  if (deliveredPayload) {
    const computedLeaf = computeLeafHash(deliveredPayload);
    const computedReceiptHash = computeReceiptHash({
      leaf: computedLeaf,
      datasetId: receipt.datasetId,
      buyer: receipt.buyer,
      amount: receipt.amount,
      seller: receipt.seller,
      deliveredAt: receipt.deliveredAt,
    });

    receiptHashMatches = computedReceiptHash.toString('hex') === receipt.receiptHash;
  }

  let merkleProofValid: boolean | undefined;
  if (receipt.merkleRoot && receipt.merkleProof && receipt.merkleIndex !== undefined) {
    const proof = buildMerkleProof(receipt);
    if (proof) {
      merkleProofValid = verifyMerkleProof(proof);
    }
  }

  const anchorVerified = receipt.anchorStatus === 'ANCHORED' || receipt.anchorStatus === 'VERIFIED';

  return {
    valid: receiptHashMatches && (merkleProofValid !== false),
    receiptHashMatches,
    merkleProofValid,
    anchorVerified,
    anchorTxHash: receipt.anchorTxHash,
    status: receipt.anchorStatus,
  };
}

// ── Row converters ──

function receiptToRow(receipt: Receipt): Record<string, unknown> {
  return {
    id: receipt.id,
    datasetId: receipt.datasetId,
    buyer: receipt.buyer,
    seller: receipt.seller,
    amount: String(receipt.amount),
    paymentToken: receipt.paymentToken,
    txHash: receipt.txHash,
    leafHash: receipt.leafHash,
    receiptHash: receipt.receiptHash,
    anchorMode: receipt.anchorMode,
    anchorStatus: receipt.anchorStatus,
    anchorTxHash: receipt.anchorTxHash ?? null,
    merkleRoot: receipt.merkleRoot ?? null,
    merkleIndex: receipt.merkleIndex ?? null,
    merkleProof: receipt.merkleProof ? JSON.stringify(receipt.merkleProof) : null,
    deliveredAt: receipt.deliveredAt,
    anchoredAt: receipt.anchoredAt ?? null,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

function rowToReceipt(row: Record<string, unknown>): Receipt {
  return {
    id: String(row.id),
    datasetId: String(row.datasetId),
    buyer: String(row.buyer),
    seller: String(row.seller),
    amount: Number(row.amount),
    paymentToken: String(row.paymentToken),
    txHash: String(row.txHash),
    leafHash: String(row.leafHash),
    receiptHash: String(row.receiptHash),
    anchorMode: String(row.anchorMode) as ReceiptAnchorMode,
    anchorStatus: String(row.anchorStatus) as ReceiptAnchorStatus,
    anchorTxHash: row.anchorTxHash ? String(row.anchorTxHash) : undefined,
    merkleRoot: row.merkleRoot ? String(row.merkleRoot) : undefined,
    merkleIndex: row.merkleIndex !== null ? Number(row.merkleIndex) : undefined,
    merkleProof: row.merkleProof ? JSON.parse(String(row.merkleProof)) : undefined,
    deliveredAt: String(row.deliveredAt),
    anchoredAt: row.anchoredAt ? String(row.anchoredAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}