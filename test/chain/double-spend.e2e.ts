/**
 * double-spend.e2e.ts — replaying a signed transaction.
 *
 * The attack: take a lock transaction that already succeeded and submit the exact
 * same bytes again, hoping one authorisation yields two escrows or two debits.
 *
 * What the network actually does is worth stating precisely, because it is NOT
 * the "second submission errors" behaviour people assume:
 *
 *   A replayed envelope has the same transaction hash as the original. The
 *   sequence number was consumed by the first inclusion, so the replay can never
 *   be included again — but RPC resolves `getTransaction(hash)` against the
 *   ORIGINAL, already-successful transaction. So the replay can come back
 *   looking like a success, returning the original's escrow id.
 *
 * That is a trap for any caller that submits-and-reads-returnValue without
 * tracking hashes: it sees a "successful lock" and a valid escrow id, and may
 * conclude a second escrow exists. It does not. These tests therefore assert on
 * money and on the escrow counter — the properties that actually matter — rather
 * than on the shape of the response.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import {
  type Harness,
  confirmDelivery,
  ensureBuyerFunded,
  escrowCount,
  getEscrow,
  harness,
  prepareLock,
  release,
  submitSigned,
  tokenBalance,
  toStroops,
} from './helpers.ts';

const AMOUNT = toStroops(20);

/**
 * Replays an envelope and reports what happened, without asserting. Whether the
 * network rejects it or idempotently echoes the original is an implementation
 * detail of RPC; the caller asserts on the ledger instead.
 */
async function replay(
  h: Harness,
  envelopeXdr: string,
): Promise<{ rejected: boolean; escrowId: bigint | null }> {
  const tx = TransactionBuilder.fromXdr(envelopeXdr, h.ctx.passphrase);
  try {
    const result = await submitSigned(h.ctx, tx as never);
    return { rejected: false, escrowId: BigInt(result.native as string | number | bigint) };
  } catch {
    return { rejected: true, escrowId: null };
  }
}

describe('double-spend via replayed transaction', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await ensureBuyerFunded(h, 1_000);
  }, 120_000);

  it('debits the buyer exactly once when the same signed tx is replayed', async () => {
    const buyer = h.accounts.buyer.publicKey;
    const buyerBefore = await tokenBalance(h, buyer);
    const contractBefore = await tokenBalance(h, h.contractId);
    const countBefore = await escrowCount(h);

    // One authorisation, signed once. `toXdr`/`fromXdr` in stellar-sdk v17.
    const signed = await prepareLock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });
    const envelopeXdr = signed.toXdr();

    // ── first submission succeeds ─────────────────────────────────────────
    const first = await submitSigned(h.ctx, signed);
    const escrowId = BigInt(first.native as string | number | bigint);

    const buyerAfterFirst = await tokenBalance(h, buyer);
    const countAfterFirst = await escrowCount(h);
    expect(buyerAfterFirst).toBe(buyerBefore - AMOUNT);
    expect(countAfterFirst).toBe(countBefore + 1n);

    // ── replay the identical bytes ────────────────────────────────────────
    // Rebuilt from XDR, so this is genuinely the same envelope, same signature,
    // same sequence number — not a freshly built lookalike.
    const rebuilt = TransactionBuilder.fromXdr(envelopeXdr, h.ctx.passphrase);
    expect(rebuilt.toXdr()).toBe(envelopeXdr);

    const outcome = await replay(h, envelopeXdr);

    // If the replay appeared to succeed, it must have echoed the ORIGINAL escrow,
    // never minted a new one.
    if (!outcome.rejected) {
      expect(outcome.escrowId).toBe(escrowId);
    }

    // ── the assertions that matter ────────────────────────────────────────
    // No second debit...
    expect(await tokenBalance(h, buyer)).toBe(buyerAfterFirst);
    // ...no second escrow...
    expect(await escrowCount(h)).toBe(countAfterFirst);
    // ...no second credit into the contract.
    expect(await tokenBalance(h, h.contractId)).toBe(contractBefore + AMOUNT);

    // The one escrow that exists is intact and untouched by the replay.
    const record = await getEscrow(h, escrowId);
    expect(record.amount).toBe(AMOUNT);
    expect(record.released).toBe(false);
    expect(record.refunded).toBe(false);
  }, 300_000);

  it('cannot resurrect a released escrow by replaying its lock', async () => {
    // The nastier variant: replay after the funds have already moved on, when a
    // naive implementation might treat the escrow as new again.
    const buyer = h.accounts.buyer.publicKey;
    await ensureBuyerFunded(h, 200);

    const signed = await prepareLock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });
    const envelopeXdr = signed.toXdr();
    const first = await submitSigned(h.ctx, signed);
    const escrowId = BigInt(first.native as string | number | bigint);

    await confirmDelivery(h, escrowId);
    await release(h, escrowId);

    const buyerAfterRelease = await tokenBalance(h, buyer);
    const sellerAfterRelease = await tokenBalance(h, h.accounts.seller.publicKey);
    const countAfterRelease = await escrowCount(h);

    const outcome = await replay(h, envelopeXdr);
    if (!outcome.rejected) {
      expect(outcome.escrowId).toBe(escrowId);
    }

    // No new escrow, no new debit, and crucially the seller is not paid twice.
    expect(await escrowCount(h)).toBe(countAfterRelease);
    expect(await tokenBalance(h, buyer)).toBe(buyerAfterRelease);
    expect(await tokenBalance(h, h.accounts.seller.publicKey)).toBe(sellerAfterRelease);

    // The escrow stays released — replay did not reset its state.
    expect((await getEscrow(h, escrowId)).released).toBe(true);
  }, 300_000);

  it('treats a re-signed lock as a genuinely new escrow, not a replay', async () => {
    // The control case. A NEW transaction (fresh sequence number) for the same
    // logical purchase is not a double-spend — it is a second purchase, and it
    // must debit the buyer a second time. This is what proves the test above is
    // detecting replay specifically rather than just observing an inert network.
    await ensureBuyerFunded(h, 200);
    const buyer = h.accounts.buyer.publicKey;
    const buyerBefore = await tokenBalance(h, buyer);
    const countBefore = await escrowCount(h);

    const a = await prepareLock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });
    const firstId = BigInt((await submitSigned(h.ctx, a)).native as string | number | bigint);
    const b = await prepareLock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });
    const secondId = BigInt((await submitSigned(h.ctx, b)).native as string | number | bigint);

    expect(secondId).not.toBe(firstId);
    expect(await escrowCount(h)).toBe(countBefore + 2n);
    expect(await tokenBalance(h, buyer)).toBe(buyerBefore - AMOUNT * 2n);
  }, 300_000);
});
