/**
 * fee-vectors.ts — issue #540
 *
 * Builds the shared fee fixture that the Rust differential test reads, computed
 * by the *real* backend functions rather than a transcription of them. The
 * fixture is committed; `constants.differential.test.ts` fails if it drifts,
 * and the Rust suite fails if the contract stops matching it.
 *
 * Regenerate with `npm run gen:fee-vectors --prefix backend`
 * (thin CLI wrapper at `backend/scripts/gen-fee-vectors.ts`).
 *
 * Deterministic by construction: fixed price grid in, same JSON out. Nothing
 * here belongs in a model reply.
 */

import path from 'path';

import { PLATFORM_FEE_BPS, PLATFORM_FEE_RATE, platformFee, sellerShare } from './constants';

export const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../contracts/hazina-escrow/tests/fixtures/fee_vectors.json',
);

/** Stellar asset precision. `amount` in the contract is always stroops. */
export const DECIMALS = 7;

/**
 * Price grid, in whole token units. Chosen, not random: decade boundaries, the
 * band where the backend fee rounds away to nothing, the contract's
 * MIN_LOCK_AMOUNT (0.001 units = 10 000 stroops), and prices whose exact fee
 * needs more than four decimals so `toFixed(4)` has to round.
 */
export const PRICES: number[] = [
  0.0000001, 0.0000005, 0.000001, 0.00001, 0.0001, 0.0002, 0.0005, 0.001, 0.0019, 0.002, 0.005,
  0.01, 0.02, 0.05, 0.1, 0.19, 0.2, 0.3, 0.33, 0.5, 0.77, 0.99, 1, 1.23, 1.5, 2, 2.5, 3.33, 5, 7.77,
  9.99, 10, 12.345, 19.99, 25, 50, 99.999, 100, 123.456, 250, 500, 999.9999, 1000, 1234.5678, 5000,
  10000, 12345.6789, 50000, 100000,
];

export interface FeeVectorFile {
  generatedBy: string;
  platformFeeRate: number;
  platformFeeBps: number;
  decimals: number;
  /** `[price, platformFee(price), sellerShare(price)]`, all in token units. */
  vectors: [number, number, number][];
}

export function buildFixture(): FeeVectorFile {
  return {
    generatedBy: 'backend/scripts/gen-fee-vectors.ts',
    platformFeeRate: PLATFORM_FEE_RATE,
    platformFeeBps: PLATFORM_FEE_BPS,
    decimals: DECIMALS,
    vectors: PRICES.map(price => [price, platformFee(price), sellerShare(price)]),
  };
}

/** Stable, diff-friendly rendering: one vector per line. */
export function render(fixture: FeeVectorFile): string {
  const rows = fixture.vectors.map(v => `    ${JSON.stringify(v)}`).join(',\n');
  return [
    '{',
    `  "generatedBy": ${JSON.stringify(fixture.generatedBy)},`,
    `  "platformFeeRate": ${fixture.platformFeeRate},`,
    `  "platformFeeBps": ${fixture.platformFeeBps},`,
    `  "decimals": ${fixture.decimals},`,
    '  "vectors": [',
    rows,
    '  ]',
    '}',
    '',
  ].join('\n');
}
