/**
 * refund.e2e.ts — the buyer gets everything back.
 *
 * The invariant that matters: a refund returns 100% of the locked amount, with
 * no platform fee skimmed. A 95/5 split leaking into the refund path would be a
 * silent theft bug, and it is exactly the kind of thing a mocked test misses
 * because the mock returns whatever the developer expected.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Harness,
  CONTRACT_ERROR,
  confirmDelivery,
  contractErrorCode,
  ensureBuyerFunded,
  getEscrow,
  harness,
  lock,
  refund,
  release,
  tokenBalance,
  toStroops,
} from './helpers.ts';

const AMOUNT = toStroops(40);

describe('refund', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await ensureBuyerFunded(h, 1_000);
  }, 120_000);

  it('returns the full amount to the buyer and takes no fee', async () => {
    const buyer = h.accounts.buyer.publicKey;
    const treasury = h.accounts.treasury.publicKey;
    const seller = h.accounts.seller.publicKey;

    const before = {
      buyer: await tokenBalance(h, buyer),
      treasury: await tokenBalance(h, treasury),
      seller: await tokenBalance(h, seller),
      contract: await tokenBalance(h, h.contractId),
    };

    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    expect(await tokenBalance(h, buyer)).toBe(before.buyer - AMOUNT);

    await refund(h, escrowId);

    const after = {
      buyer: await tokenBalance(h, buyer),
      treasury: await tokenBalance(h, treasury),
      seller: await tokenBalance(h, seller),
      contract: await tokenBalance(h, h.contractId),
    };

    // Whole amount back, to the stroop.
    expect(after.buyer).toBe(before.buyer);
    // No fee taken, nothing paid to the seller, contract left flat.
    expect(after.treasury).toBe(before.treasury);
    expect(after.seller).toBe(before.seller);
    expect(after.contract).toBe(before.contract);

    const record = await getEscrow(h, escrowId);
    expect(record.refunded).toBe(true);
    expect(record.released).toBe(false);
  }, 180_000);

  it('refunds a confirmed-but-unreleased escrow without paying the seller', async () => {
    // Buyer confirmed delivery, then the sale was reversed anyway. The seller
    // must still receive nothing.
    await ensureBuyerFunded(h, 200);
    const seller = h.accounts.seller.publicKey;
    const sellerBefore = await tokenBalance(h, seller);
    const buyerBefore = await tokenBalance(h, h.accounts.buyer.publicKey);

    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await confirmDelivery(h, escrowId);
    await refund(h, escrowId);

    expect(await tokenBalance(h, seller)).toBe(sellerBefore);
    expect(await tokenBalance(h, h.accounts.buyer.publicKey)).toBe(buyerBefore);
  }, 180_000);

  it('refuses to release an escrow that was already refunded', async () => {
    await ensureBuyerFunded(h, 200);
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await refund(h, escrowId);

    const sellerBefore = await tokenBalance(h, h.accounts.seller.publicKey);
    await expect(release(h, escrowId)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.AlreadyRefunded,
    );
    expect(await tokenBalance(h, h.accounts.seller.publicKey)).toBe(sellerBefore);
  }, 180_000);

  it('refuses to refund the same escrow twice', async () => {
    await ensureBuyerFunded(h, 200);
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await refund(h, escrowId);

    const buyerAfterFirst = await tokenBalance(h, h.accounts.buyer.publicKey);
    await expect(refund(h, escrowId)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.AlreadyRefunded,
    );
    // A double refund would drain the contract's pooled funds.
    expect(await tokenBalance(h, h.accounts.buyer.publicKey)).toBe(buyerAfterFirst);
  }, 180_000);
});
