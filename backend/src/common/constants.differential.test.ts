/**
 * constants.differential.test.ts — issue #540
 *
 * The JavaScript half of the contract/backend fee differential. The Rust half
 * lives in `contracts/hazina-escrow/tests/fuzz/fee_differential.rs` and reads
 * the same committed fixture.
 *
 * Split of duty:
 *   - here: the fixture still matches what the backend actually computes, and
 *     the divergence from the contract's integer math stays inside its budget;
 *   - Rust: the contract still matches the fixture.
 *
 * Either side drifting breaks one of the two, which is the whole point.
 */

import { readFileSync } from 'fs';

import { describe, expect, it } from 'vitest';

import { PLATFORM_FEE_BPS, PLATFORM_FEE_RATE, platformFee, sellerShare } from './constants';
import { FIXTURE_PATH, PRICES, buildFixture, render } from './fee-vectors';

/** Stroops per whole token unit (Stellar assets are 7-decimal). */
const UNIT = 10_000_000n;

/**
 * Backend `platformFee` quantises to 1e-4 units = 1 000 stroops, so it can sit
 * up to 500 stroops from the exact fee; the contract truncates, costing under
 * one. See the Rust module for the full derivation.
 */
const TOLERANCE_STROOPS = 501n;

const toStroops = (units: number): bigint => BigInt(Math.round(units * Number(UNIT)));

/** The contract's `release_one` arithmetic, in exact integers. */
function contractPlatformCut(amount: bigint, feeBps: bigint): bigint {
  const calculated = (amount * feeBps) / 10_000n;
  return calculated === 0n && amount > 0n && feeBps > 0n ? 1n : calculated;
}

describe('fee vector fixture', () => {
  it('is current — regenerate with `npm run gen:fee-vectors --prefix backend`', () => {
    expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(render(buildFixture()));
  });

  it('derives the contract bps from the same rate the backend uses off-chain', () => {
    expect(PLATFORM_FEE_BPS).toBe(Math.round(PLATFORM_FEE_RATE * 10_000));
  });
});

describe('backend fee math vs contract fee math', () => {
  it('agrees within the rounding budget across the whole price grid', () => {
    let worst = 0n;

    for (const price of PRICES) {
      const amount = toStroops(price);
      const backendCut = toStroops(platformFee(price));
      const contractCut = contractPlatformCut(amount, BigInt(PLATFORM_FEE_BPS));

      const delta = contractCut > backendCut ? contractCut - backendCut : backendCut - contractCut;
      expect(
        delta,
        `price ${price}: contract ${contractCut} vs backend ${backendCut}`,
      ).toBeLessThanOrEqual(TOLERANCE_STROOPS);
      if (delta > worst) worst = delta;
    }

    // If this ever hits zero the grid has stopped covering the interesting
    // prices and the tolerance above is no longer being exercised.
    expect(worst).toBeGreaterThan(0n);
  });

  it('shows the contract charging a fee where the backend rounds to zero', () => {
    // The min-1-stroop rule has no backend equivalent, so small prices are
    // where the two disagree most sharply. 0.0005 units = 5 000 stroops: the
    // contract takes 250 stroops, the backend reports nothing at all.
    const price = 0.0005;
    expect(platformFee(price)).toBe(0);
    expect(contractPlatformCut(toStroops(price), BigInt(PLATFORM_FEE_BPS))).toBe(250n);
  });

  it('does not conserve value, unlike the contract', () => {
    // Each side is rounded independently (4 dp vs 7 dp), so the backend's two
    // numbers need not add back to the price. This is why backend figures are
    // display-only and never authoritative for settlement.
    const diverging = PRICES.filter(
      p => toStroops(platformFee(p) + sellerShare(p)) !== toStroops(p),
    );
    expect(diverging.length).toBeGreaterThan(0);

    // The contract, by construction, always conserves.
    for (const price of PRICES) {
      const amount = toStroops(price);
      const cut = contractPlatformCut(amount, BigInt(PLATFORM_FEE_BPS));
      expect(cut + (amount - cut)).toBe(amount);
    }
  });
});
