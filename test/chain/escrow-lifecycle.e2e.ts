/**
 * escrow-lifecycle.e2e.ts — the purchase flow, on a real chain.
 *
 * lock → confirm delivery → release, with the 95/5 split asserted from token
 * balances read off the ledger. Nothing here trusts an API response body; every
 * number comes from a read-only simulation of the SAC's `balance()`.
 *
 * This is the test that mocks cannot replace. It exercises operation ordering,
 * Soroban auth entries, the token contract's own trustline checks, and the
 * contract's arithmetic against a real host — the failure modes the issue calls
 * out as invisible to unit tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Harness,
  confirmDelivery,
  escrowCount,
  expectedSplit,
  getEscrow,
  harness,
  lock,
  release,
  ensureBuyerFunded,
  tokenBalance,
  toStroops,
  CONTRACT_ERROR,
  contractErrorCode,
} from './helpers.ts';

const AMOUNT = toStroops(100); // 100 USDC → 95 seller / 5 treasury

describe('escrow lifecycle: lock → deliver → release', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await ensureBuyerFunded(h, 1_000);
  }, 120_000);

  it('splits a released escrow 95/5 between seller and treasury on-chain', async () => {
    const buyer = h.accounts.buyer.publicKey;
    const seller = h.accounts.seller.publicKey;
    const treasury = h.accounts.treasury.publicKey;

    const before = {
      buyer: await tokenBalance(h, buyer),
      seller: await tokenBalance(h, seller),
      treasury: await tokenBalance(h, treasury),
      contract: await tokenBalance(h, h.contractId),
    };

    // ── lock ──────────────────────────────────────────────────────────────
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });

    const afterLock = {
      buyer: await tokenBalance(h, buyer),
      seller: await tokenBalance(h, seller),
      contract: await tokenBalance(h, h.contractId),
    };

    // The buyer's funds are in the CONTRACT, not with the seller. If this ever
    // regressed to paying the seller directly, escrow would be a no-op.
    expect(afterLock.buyer).toBe(before.buyer - AMOUNT);
    expect(afterLock.contract).toBe(before.contract + AMOUNT);
    expect(afterLock.seller).toBe(before.seller);

    const record = await getEscrow(h, escrowId);
    expect(record.amount).toBe(AMOUNT);
    expect(record.buyer).toBe(buyer);
    expect(record.seller).toBe(seller);
    expect(record.released).toBe(false);
    expect(record.buyer_confirmed).toBe(false);

    // ── release before confirmation must fail ─────────────────────────────
    // The buyer-confirmation gate is the whole point of escrow; assert it is
    // actually enforced on-chain rather than only in the API layer.
    await expect(release(h, escrowId)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.BuyerNotConfirmed,
    );

    // ── confirm + release ─────────────────────────────────────────────────
    await confirmDelivery(h, escrowId);
    expect((await getEscrow(h, escrowId)).buyer_confirmed).toBe(true);

    await release(h, escrowId);

    const after = {
      buyer: await tokenBalance(h, buyer),
      seller: await tokenBalance(h, seller),
      treasury: await tokenBalance(h, treasury),
      contract: await tokenBalance(h, h.contractId),
    };

    const { sellerCut, platformCut } = expectedSplit(AMOUNT);

    // Independently computed: 100 USDC at 500 bps = 95 / 5.
    expect(sellerCut).toBe(toStroops(95));
    expect(platformCut).toBe(toStroops(5));

    // The assertions that matter — deltas measured on the ledger.
    expect(after.seller - before.seller).toBe(sellerCut);
    expect(after.treasury - before.treasury).toBe(platformCut);
    expect(after.contract).toBe(before.contract);
    expect(after.buyer).toBe(before.buyer - AMOUNT);

    // Conservation: nothing was minted or burned by the round trip.
    const credited = after.seller - before.seller + (after.treasury - before.treasury);
    expect(credited).toBe(AMOUNT);

    expect((await getEscrow(h, escrowId)).released).toBe(true);
  }, 180_000);

  it('rejects a second release of the same escrow', async () => {
    await ensureBuyerFunded(h, 200);
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-whale-flows' });
    await confirmDelivery(h, escrowId);
    await release(h, escrowId);

    const sellerAfterFirst = await tokenBalance(h, h.accounts.seller.publicKey);

    await expect(release(h, escrowId)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.AlreadyReleased,
    );

    // The important half: the failed retry moved no money.
    expect(await tokenBalance(h, h.accounts.seller.publicKey)).toBe(sellerAfterFirst);
  }, 180_000);

  it('increments the on-chain escrow counter exactly once per lock', async () => {
    await ensureBuyerFunded(h, 200);
    const before = await escrowCount(h);
    await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    expect(await escrowCount(h)).toBe(before + 1n);
  }, 120_000);
});
