/**
 * anchor.service.ts — Stellar on-chain anchoring of delivery receipts.
 *
 * Two anchoring modes:
 * - `direct`:  one receipt per transaction — a MEMO_HASH carrying the 32-byte
 *   receipt hash is embedded in a minimal self-payment made by the agent
 *   wallet. Cheap, immediate, verifiable on-chain.
 * - `batched`: many receipts are Merkle-rooted into a single commitment; the
 *   root (also 32 bytes) is anchored in one transaction and each receipt
 *   stores its inclusion proof for independent verification.
 *
 * The sweep worker (`startAnchorWorker`) periodically picks up receipts in
 * NOT_ANCHORED_YET / ANCHORING / ANCHOR_FAILED state and anchors them
 * according to their configured mode. Stellar faults are guarded by a
 * circuit breaker so a Horizon outage does not pile work onto a dead RPC.
 *
 * SECURITY: The agent wallet secret is only used to sign locally and is never
 * logged. Receipt hashes are public data intended to be written on-chain.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { parsePositiveInt } from '../common/env';
import { HORIZON_URL, getNetworkPassphrase } from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { buildMerkleTree, generateInclusionProof } from './merkle';
import {
  getPendingReceipts,
  getReceipt,
  markReceiptAnchored,
  markReceiptAnchoring,
  markReceiptAnchorFailed,
} from './receipt.service';
import type { Receipt, ReceiptAnchorMode } from './types';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const anchorBreaker = getCircuitBreaker('stellar-horizon-anchor', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

// A self-payment of 1 stroop is the minimal possible Stellar transaction that
// can carry a memo — the memo, not the amount, is what anchors the hash.
const ANCHOR_AMOUNT = '0.0000001';

const getAnchorTimeoutMs = () => parsePositiveInt(process.env.STELLAR_TIMEOUT_MS, 10_000);

async function withAnchorTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const timeoutMs = getAnchorTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
  }
}

function requireAgentSecret(): string {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) {
    throw new Error('AGENT_WALLET_SECRET not configured — cannot anchor receipts');
  }
  return secret;
}

/**
 * Submit a minimal self-payment carrying the given 32-byte hash as MEMO_HASH.
 * Returns the on-chain transaction hash.
 */
export async function submitAnchorTransaction(hashHex: string): Promise<string> {
  const secret = requireAgentSecret();
  const keypair = StellarSdk.Keypair.fromSecret(secret);

  const account = await withAnchorTimeout(() =>
    anchorBreaker.execute(() => server.loadAccount(keypair.publicKey())),
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: keypair.publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: ANCHOR_AMOUNT,
      }),
    )
    .addMemo(StellarSdk.Memo.hash(Buffer.from(hashHex, 'hex')))
    .setTimeout(30)
    .build();

  tx.sign(keypair);

  const result = await withAnchorTimeout(() =>
    anchorBreaker.execute(() => server.submitTransaction(tx)),
  );

  return result.hash;
}

/**
 * Anchor a single receipt directly with its receipt hash as MEMO_HASH.
 */
export async function anchorReceiptDirect(receiptId: string): Promise<Receipt | null> {
  const receipt = await getReceipt(receiptId);
  if (!receipt) {
    logger.warn(`[Anchor] Receipt ${receiptId} not found — skipping`);
    return null;
  }

  await markReceiptAnchoring(receiptId);
  try {
    const anchorTxHash = await submitAnchorTransaction(receipt.receiptHash);
    const anchored = await markReceiptAnchored(receiptId, anchorTxHash);
    logger.info(`[Anchor] Direct-anchored receipt ${receiptId} (tx ${anchorTxHash})`);
    return anchored;
  } catch (err) {
    await markReceiptAnchorFailed(receiptId);
    logger.error(
      `[Anchor] Direct anchor failed for ${receiptId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Anchor a batch of receipts via a single Merkle root MEMO_HASH.
 * Each receipt gets its inclusion proof stored for independent verification.
 */
export async function anchorReceiptBatch(receiptIds: string[]): Promise<Receipt[]> {
  const receipts: Receipt[] = [];
  for (const id of receiptIds) {
    const receipt = await getReceipt(id);
    if (receipt) receipts.push(receipt);
  }
  if (receipts.length === 0) {
    return [];
  }

  for (const receipt of receipts) {
    await markReceiptAnchoring(receipt.id);
  }

  try {
    const tree = buildMerkleTree(receipts.map(r => r.leafHash));
    const root = tree.root;
    const anchorTxHash = await submitAnchorTransaction(root);

    const anchored: Receipt[] = [];
    let index = 0;
    for (const receipt of receipts) {
      const proof = generateInclusionProof(tree, index);
      const updated = await markReceiptAnchored(
        receipt.id,
        anchorTxHash,
        root,
        index,
        proof.siblings,
      );
      if (updated) anchored.push(updated);
      index++;
    }
    logger.info(
      `[Anchor] Batch-anchored ${anchored.length} receipts (root ${root}, tx ${anchorTxHash})`,
    );
    return anchored;
  } catch (err) {
    for (const receipt of receipts) {
      await markReceiptAnchorFailed(receipt.id);
    }
    logger.error(
      `[Anchor] Batch anchor failed for ${receipts.length} receipts: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Run one anchoring sweep: pick up pending receipts and anchor them by mode.
 * Returns how many receipts were anchored (direct + batched) and any failures.
 */
export async function runAnchorSweep(): Promise<{
  anchored: number;
  directAnchored: number;
  batchedAnchored: number;
  failed: number;
}> {
  const batchSize = parsePositiveInt(process.env.RECEIPT_ANCHOR_BATCH_SIZE, 64);

  const directPending = await getPendingReceipts({ mode: 'direct', limit: 100 });
  const batchedPending = await getPendingReceipts({ mode: 'batched', limit: batchSize });

  let directAnchored = 0;
  let batchedAnchored = 0;
  let failed = 0;

  for (const receipt of directPending) {
    const result = await anchorReceiptDirect(receipt.id);
    if (result) directAnchored++;
    else failed++;
  }

  if (batchedPending.length > 0) {
    const anchoredBatch = await anchorReceiptBatch(batchedPending.map(r => r.id));
    batchedAnchored = anchoredBatch.length;
    failed += batchedPending.length - anchoredBatch.length;
  }

  const anchored = directAnchored + batchedAnchored;
  logger.info(
    `[Anchor] Sweep complete: ${anchored} anchored (${directAnchored} direct, ${batchedAnchored} batched), ${failed} failed`,
  );

  return { anchored, directAnchored, batchedAnchored, failed };
}

// ── Background sweep worker ─────────────────────────────────────────────────

let anchorWorker: NodeJS.Timeout | null = null;

function getAnchorIntervalMs(): number {
  return parsePositiveInt(process.env.RECEIPT_ANCHOR_INTERVAL_MS, 60_000);
}

/**
 * Start the periodic receipt-anchoring worker. Disabled when
 * RECEIPT_ANCHOR_ENABLED is explicitly "false" (e.g. in tests/CI). Runs an
 * initial sweep shortly after start rather than blocking boot.
 */
export function startAnchorWorker(intervalMs = getAnchorIntervalMs()): void {
  if (process.env.RECEIPT_ANCHOR_ENABLED === 'false') {
    logger.info('[Anchor] Disabled via RECEIPT_ANCHOR_ENABLED=false');
    return;
  }
  if (anchorWorker) {
    logger.info('[Anchor] Already running');
    return;
  }

  logger.info(`[Anchor] Starting anchoring worker (every ${Math.round(intervalMs / 1000)}s)`);

  setTimeout(() => {
    runAnchorSweep().catch(err =>
      logger.error(
        `[Anchor] initial sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, 2_000).unref?.();

  anchorWorker = setInterval(() => {
    runAnchorSweep().catch(err =>
      logger.error(
        `[Anchor] scheduled sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, intervalMs);
  anchorWorker.unref?.();
}

export function stopAnchorWorker(): void {
  if (anchorWorker) {
    clearInterval(anchorWorker);
    anchorWorker = null;
    logger.info('[Anchor] Stopped');
  }
}

/**
 * Resolve the anchoring mode for a given mode string, with validation.
 */
export function parseAnchorMode(mode: string): ReceiptAnchorMode {
  if (mode === 'batched') return 'batched';
  return 'direct';
}
