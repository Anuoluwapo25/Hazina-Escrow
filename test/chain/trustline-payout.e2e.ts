/**
 * trustline-payout.e2e.ts — paying an account that cannot receive the asset.
 *
 * This is the scenario the issue names explicitly, and it is the clearest
 * example of something a mock cannot model. On Stellar an account can only hold
 * a non-native asset it has explicitly trusted. A seller who never established a
 * USDC trustline cannot be paid, and the SAC transfer inside `release_one` traps
 * — taking the whole release transaction down with it.
 *
 * What must be true, and is asserted here:
 *   1. The release FAILS rather than silently succeeding.
 *   2. The escrow stays unreleased, so the funds are not stranded in limbo.
 *   3. The buyer's money is still in the contract — not burned, not half-paid.
 *   4. Once the trustline exists, the SAME escrow releases correctly 95/5.
 *
 * Point 3 is the one that matters. A partial payout — seller paid, treasury
 * transfer trapped — would be a real loss. Soroban's atomicity is what prevents
 * it, and this test is the proof rather than the assumption.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Harness,
  addTrustline,
  confirmDelivery,
  ensureBuyerFunded,
  expectedSplit,
  freshAccountWithoutTrustline,
  getEscrow,
  harness,
  hasTrustline,
  platformFeeRecipient,
  release,
  tokenBalance,
  tokenBalanceOrZero,
  toStroops,
} from './helpers.ts';
import { Address, Contract, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { submitSoroban } from '../../scripts/devnet/lib/chain.ts';

const AMOUNT = toStroops(30);

describe('payout to a trustline-less account', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await ensureBuyerFunded(h, 1_000);
  }, 120_000);

  it('keeps the shared no-trustline fixture genuinely trustline-less', async () => {
    // Guards the fixture itself. If some earlier run added a trustline to this
    // account the scenario below would silently stop testing anything.
    expect(await hasTrustline(h.ctx, h.accounts.sellerNoTrustline.publicKey, h.usdc)).toBe(false);
  }, 60_000);

  it('fails the release, strands nothing, and succeeds once the trustline exists', async () => {
    // A per-test account so adding the trustline below does not consume the
    // shared fixture for future runs.
    const seller = await freshAccountWithoutTrustline(h, 'trustline-payout-seller');
    expect(await hasTrustline(h.ctx, seller.publicKey(), h.usdc)).toBe(false);

    const treasury = platformFeeRecipient(h);
    const buyerBefore = await tokenBalance(h, h.accounts.buyer.publicKey);
    const treasuryBefore = await tokenBalance(h, treasury);
    const contractBefore = await tokenBalance(h, h.contractId);

    // ── lock to the trustline-less seller ─────────────────────────────────
    // lock() only moves buyer → contract, so it succeeds: the seller's inability
    // to receive is not discovered until payout time. That lag is precisely the
    // production bug this scenario represents.
    const lockResult = await submitSoroban(
      h.ctx,
      Keypair.fromSecret(h.accounts.buyer.secret),
      new Contract(h.contractId).call(
        'lock',
        Address.fromString(h.accounts.buyer.publicKey).toScVal(),
        Address.fromString(seller.publicKey()).toScVal(),
        Address.fromString(h.usdcSac).toScVal(),
        nativeToScVal(AMOUNT, { type: 'i128' }),
        nativeToScVal('devnet-orphan-feed', { type: 'string' }),
        nativeToScVal(3_600n, { type: 'u64' }),
      ),
    );
    const escrowId = BigInt(lockResult.native as string | number | bigint);

    expect(await tokenBalance(h, h.accounts.buyer.publicKey)).toBe(buyerBefore - AMOUNT);
    expect(await tokenBalance(h, h.contractId)).toBe(contractBefore + AMOUNT);

    await confirmDelivery(h, escrowId);

    // ── release must fail ─────────────────────────────────────────────────
    await expect(release(h, escrowId)).rejects.toThrow();

    // ── and must have changed nothing ─────────────────────────────────────
    const record = await getEscrow(h, escrowId);
    expect(record.released).toBe(false);
    expect(record.refunded).toBe(false);

    // The critical assertion: the whole amount is still in the contract. No
    // partial payout, no burn. The treasury did not get its 5% for a sale that
    // never completed.
    expect(await tokenBalance(h, h.contractId)).toBe(contractBefore + AMOUNT);
    expect(await tokenBalance(h, treasury)).toBe(treasuryBefore);
    // Reads as zero via the trustline-aware helper: the SAC traps on balance()
    // for an account with no trustline rather than reporting 0.
    expect(await tokenBalanceOrZero(h, seller.publicKey())).toBe(0n);

    // ── remediate and retry ───────────────────────────────────────────────
    // The real-world fix: the seller adds the trustline, and the same escrow is
    // released without re-locking or refunding.
    await addTrustline(h, seller);
    expect(await hasTrustline(h.ctx, seller.publicKey(), h.usdc)).toBe(true);

    await release(h, escrowId);

    const { sellerCut, platformCut } = expectedSplit(AMOUNT);
    expect(await tokenBalance(h, seller.publicKey())).toBe(sellerCut);
    expect(await tokenBalance(h, treasury)).toBe(treasuryBefore + platformCut);
    expect(await tokenBalance(h, h.contractId)).toBe(contractBefore);
    expect((await getEscrow(h, escrowId)).released).toBe(true);
  }, 300_000);
});
