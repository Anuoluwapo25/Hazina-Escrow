/**
 * dispute.e2e.ts — dispute → resolve, both directions.
 *
 * resolve_dispute is the most dangerous function on the contract: it moves money
 * on the arbitrator's say-so and it bypasses the buyer-confirmation gate. The
 * things worth proving on a real chain are that only the arbitrator can call it,
 * that "favour buyer" is a full refund, and that "favour seller" is still the
 * 95/5 split rather than a 100% payout.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Harness,
  CONTRACT_ERROR,
  contractErrorCode,
  ensureBuyerFunded,
  expectedSplit,
  getEscrow,
  harness,
  lock,
  platformFeeRecipient,
  raiseDispute,
  release,
  resolveDispute,
  tokenBalance,
  toStroops,
} from './helpers.ts';

const AMOUNT = toStroops(60);

describe('dispute resolution', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
    await ensureBuyerFunded(h, 1_000);
  }, 120_000);

  it('refunds the buyer in full when the arbitrator favours the buyer', async () => {
    const buyer = h.accounts.buyer.publicKey;
    const seller = h.accounts.seller.publicKey;
    const treasury = h.accounts.treasury.publicKey;

    const before = {
      buyer: await tokenBalance(h, buyer),
      seller: await tokenBalance(h, seller),
      treasury: await tokenBalance(h, treasury),
    };

    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await raiseDispute(h, escrowId);
    expect((await getEscrow(h, escrowId)).disputed).toBe(true);

    // A disputed escrow must not be releasable through the normal path.
    await expect(release(h, escrowId)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.DisputedEscrow,
    );

    await resolveDispute(h, escrowId, true);

    expect(await tokenBalance(h, buyer)).toBe(before.buyer);
    expect(await tokenBalance(h, seller)).toBe(before.seller);
    expect(await tokenBalance(h, treasury)).toBe(before.treasury);

    const record = await getEscrow(h, escrowId);
    expect(record.refunded).toBe(true);
    expect(record.disputed).toBe(false);
  }, 180_000);

  it('pays the 95/5 split when the arbitrator favours the seller', async () => {
    await ensureBuyerFunded(h, 200);
    const buyer = h.accounts.buyer.publicKey;
    const seller = h.accounts.seller.publicKey;
    const treasury = platformFeeRecipient(h);

    const before = {
      buyer: await tokenBalance(h, buyer),
      seller: await tokenBalance(h, seller),
      treasury: await tokenBalance(h, treasury),
    };

    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await raiseDispute(h, escrowId);
    await resolveDispute(h, escrowId, false);

    const { sellerCut, platformCut } = expectedSplit(AMOUNT);
    // Resolving for the seller must NOT waive the platform fee.
    expect(await tokenBalance(h, seller)).toBe(before.seller + sellerCut);
    expect(await tokenBalance(h, treasury)).toBe(before.treasury + platformCut);
    expect(await tokenBalance(h, buyer)).toBe(before.buyer - AMOUNT);

    const record = await getEscrow(h, escrowId);
    expect(record.released).toBe(true);
    expect(record.disputed).toBe(false);
  }, 180_000);

  it('rejects resolve_dispute from a non-arbitrator', async () => {
    await ensureBuyerFunded(h, 200);
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await raiseDispute(h, escrowId);

    const sellerBefore = await tokenBalance(h, h.accounts.seller.publicKey);
    const buyerBefore = await tokenBalance(h, h.accounts.buyer.publicKey);

    // The admin is powerful but is NOT the arbitrator — provisioning set the
    // arbitrator to its own account. Assert the separation actually holds.
    const { Contract, Address, nativeToScVal, Keypair } = await import('@stellar/stellar-sdk');
    const { submitSoroban } = await import('../../scripts/devnet/lib/chain.ts');
    const attempt = submitSoroban(
      h.ctx,
      Keypair.fromSecret(h.accounts.admin.secret),
      new Contract(h.contractId).call(
        'resolve_dispute',
        Address.fromString(h.accounts.admin.publicKey).toScVal(),
        nativeToScVal(escrowId, { type: 'u64' }),
        nativeToScVal(false),
      ),
    );
    await expect(attempt).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.NotArbitrator,
    );

    // No money moved on the rejected attempt.
    expect(await tokenBalance(h, h.accounts.seller.publicKey)).toBe(sellerBefore);
    expect(await tokenBalance(h, h.accounts.buyer.publicKey)).toBe(buyerBefore);

    // Clean up so the escrow does not stay disputed for later runs.
    await resolveDispute(h, escrowId, true);
  }, 180_000);

  it('refuses to resolve an escrow that is not disputed', async () => {
    await ensureBuyerFunded(h, 200);
    const escrowId = await lock(h, { amount: AMOUNT, datasetId: 'devnet-yield-curve' });
    await expect(resolveDispute(h, escrowId, false)).rejects.toSatisfy(
      (err: unknown) => contractErrorCode(err) === CONTRACT_ERROR.NotDisputed,
    );
  }, 180_000);
});
