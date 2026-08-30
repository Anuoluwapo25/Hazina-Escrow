import { describe, it, expect } from 'vitest';
import {
  assertValidBundleSplit,
  allocateStroops,
  InvalidBundleSplitError,
  BPS_DENOMINATOR,
} from './bundle.splits';

describe('assertValidBundleSplit', () => {
  const valid = [
    { datasetId: 'ds-whale', shareBps: 4500 },
    { datasetId: 'ds-risk', shareBps: 3000 },
    { datasetId: 'ds-sentiment', shareBps: 1500 },
  ];

  it('accepts a split that sums to exactly 10000 with curator fee', () => {
    expect(() => assertValidBundleSplit(valid, 1000)).not.toThrow();
  });

  it('rejects a split summing to less than 10000', () => {
    expect(() => assertValidBundleSplit(valid, 500)).toThrow(InvalidBundleSplitError);
  });

  it('rejects a split summing to more than 10000', () => {
    expect(() => assertValidBundleSplit(valid, 1500)).toThrow(InvalidBundleSplitError);
  });

  it('rejects a zero-share component', () => {
    expect(() =>
      assertValidBundleSplit([...valid, { datasetId: 'ds-free', shareBps: 0 }], 1000),
    ).toThrow(InvalidBundleSplitError);
  });

  it('rejects a negative-share component', () => {
    expect(() =>
      assertValidBundleSplit(
        [
          { datasetId: 'ds-whale', shareBps: -100 },
          { datasetId: 'ds-risk', shareBps: 9100 },
        ],
        1000,
      ),
    ).toThrow(InvalidBundleSplitError);
  });

  it('rejects a non-integer share (fractional bps)', () => {
    expect(() =>
      assertValidBundleSplit(
        [
          { datasetId: 'ds-whale', shareBps: 4500.5 },
          { datasetId: 'ds-risk', shareBps: 4499.5 },
        ],
        1000,
      ),
    ).toThrow(InvalidBundleSplitError);
  });

  it('rejects a negative curator fee', () => {
    expect(() => assertValidBundleSplit(valid, -1000)).toThrow(InvalidBundleSplitError);
  });

  it('allows a zero curator fee (curator waives their cut)', () => {
    expect(() =>
      assertValidBundleSplit(
        [
          { datasetId: 'ds-whale', shareBps: 5000 },
          { datasetId: 'ds-risk', shareBps: 5000 },
        ],
        0,
      ),
    ).not.toThrow();
  });

  it('rejects an empty component list', () => {
    expect(() => assertValidBundleSplit([], 10_000)).toThrow(InvalidBundleSplitError);
  });

  it('rejects a duplicate dataset id within the same bundle', () => {
    expect(() =>
      assertValidBundleSplit(
        [
          { datasetId: 'ds-whale', shareBps: 4500 },
          { datasetId: 'ds-whale', shareBps: 4500 },
        ],
        1000,
      ),
    ).toThrow(/appears more than once/);
  });

  it('allows the same seller to appear via two different datasets', () => {
    // Duplicate SELLER (not dataset) is a legitimate curator choice — the
    // same seller can contribute two different datasets to one bundle.
    expect(() =>
      assertValidBundleSplit(
        [
          { datasetId: 'ds-seller-a-1', shareBps: 4500 },
          { datasetId: 'ds-seller-a-2', shareBps: 4500 },
        ],
        1000,
      ),
    ).not.toThrow();
  });
});

describe('allocateStroops', () => {
  it('splits an evenly-divisible total with no dust', () => {
    const result = allocateStroops(1_000_000n, [
      { key: 'a', bps: 5000 },
      { key: 'b', bps: 5000 },
    ]);
    expect(result.get('a')).toBe(500_000n);
    expect(result.get('b')).toBe(500_000n);
  });

  it('distributes dust deterministically via largest remainder, summing exactly to the total', () => {
    // 1,000,000 stroops split 45/30/15/10 — an amount chosen to force rounding.
    const total = 1_000_003n;
    const result = allocateStroops(total, [
      { key: 'whale', bps: 4500 },
      { key: 'risk', bps: 3000 },
      { key: 'sentiment', bps: 1500 },
      { key: 'curator', bps: 1000 },
    ]);
    const sum = [...result.values()].reduce((s, v) => s + v, 0n);
    expect(sum).toBe(total);
    // Deterministic — running it again produces the identical allocation.
    const again = allocateStroops(total, [
      { key: 'whale', bps: 4500 },
      { key: 'risk', bps: 3000 },
      { key: 'sentiment', bps: 1500 },
      { key: 'curator', bps: 1000 },
    ]);
    expect([...again.entries()]).toEqual([...result.entries()]);
  });

  it('never loses or gains a stroop across a wide sweep of odd totals and prime-ish splits', () => {
    const allocations = [
      { key: 'a', bps: 3333 },
      { key: 'b', bps: 3333 },
      { key: 'c', bps: 3334 },
    ];
    for (let total = 1n; total < 1000n; total += 7n) {
      const result = allocateStroops(total, allocations);
      const sum = [...result.values()].reduce((s, v) => s + v, 0n);
      expect(sum).toBe(total);
      for (const v of result.values()) {
        expect(v).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('handles a single 100% allocation as identity', () => {
    const result = allocateStroops(12_345n, [{ key: 'only', bps: BPS_DENOMINATOR }]);
    expect(result.get('only')).toBe(12_345n);
  });

  it('handles a zero total (all shares zero, sum is zero)', () => {
    const result = allocateStroops(0n, [
      { key: 'a', bps: 6000 },
      { key: 'b', bps: 4000 },
    ]);
    expect(result.get('a')).toBe(0n);
    expect(result.get('b')).toBe(0n);
  });

  it('rejects allocations whose bps do not sum to 10000', () => {
    expect(() => allocateStroops(1000n, [{ key: 'a', bps: 9000 }])).toThrow(
      InvalidBundleSplitError,
    );
  });

  it('rejects a negative total', () => {
    expect(() => allocateStroops(-1n, [{ key: 'a', bps: BPS_DENOMINATOR }])).toThrow(
      InvalidBundleSplitError,
    );
  });
});
