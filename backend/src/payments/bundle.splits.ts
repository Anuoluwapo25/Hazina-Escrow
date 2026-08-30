/**
 * bundle.splits.ts — #615
 *
 * Pure, side-effect-free math for turning a bundle's basis-point splits into
 * an exact stroop vector for `lock_multi`. Kept separate from bundle.service.ts
 * so the "sum of payouts equals the locked amount exactly" invariant is
 * provable in isolation with plain integer-arithmetic tests — no DB, no
 * network, no mocks.
 */

export const BPS_DENOMINATOR = 10_000;

export class InvalidBundleSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBundleSplitError';
  }
}

export interface BundleSplitComponent {
  datasetId: string;
  shareBps: number;
}

/**
 * Validates a bundle's declared splits before anything is persisted or sent
 * on-chain: every component share is a positive integer, dataset ids are
 * unique within the bundle (buying the same dataset twice under two
 * different splits is never valid), and `curatorFeeBps` plus every
 * component's `shareBps` sums to exactly 10 000 — no more, no less. Throws
 * {@link InvalidBundleSplitError} (a typed error the API layer maps to a 400)
 * on the first violation found.
 */
export function assertValidBundleSplit(
  components: BundleSplitComponent[],
  curatorFeeBps: number,
): void {
  if (components.length === 0) {
    throw new InvalidBundleSplitError('A bundle must have at least one component dataset');
  }

  const seenDatasetIds = new Set<string>();
  for (const component of components) {
    if (!Number.isInteger(component.shareBps) || component.shareBps <= 0) {
      throw new InvalidBundleSplitError(
        `Component ${component.datasetId} must have a positive integer shareBps, got ${component.shareBps}`,
      );
    }
    if (seenDatasetIds.has(component.datasetId)) {
      throw new InvalidBundleSplitError(
        `Dataset ${component.datasetId} appears more than once in this bundle`,
      );
    }
    seenDatasetIds.add(component.datasetId);
  }

  if (!Number.isInteger(curatorFeeBps) || curatorFeeBps < 0) {
    throw new InvalidBundleSplitError(
      `curatorFeeBps must be a non-negative integer, got ${curatorFeeBps}`,
    );
  }

  const sumBps = components.reduce((sum, c) => sum + c.shareBps, curatorFeeBps);
  if (sumBps !== BPS_DENOMINATOR) {
    throw new InvalidBundleSplitError(
      `Component shares plus curator fee must sum to exactly ${BPS_DENOMINATOR} bps, got ${sumBps}`,
    );
  }
}

export interface BpsAllocation {
  key: string;
  bps: number;
}

/**
 * Splits `totalStroops` across `allocations` (bps must sum to exactly 10 000)
 * using the largest-remainder method: each key first gets
 * `floor(totalStroops * bps / 10000)`, then the leftover stroops — at most
 * `allocations.length - 1` of them, since each floor() loses less than one
 * whole stroop — are handed out one at a time to whichever keys had the
 * largest fractional remainder. This is the standard fair-apportionment
 * algorithm (Hamilton/largest-remainder): it is deterministic (same input
 * always produces the same output, with ties broken by key), and the
 * returned amounts always sum to exactly `totalStroops` — proven by
 * construction, not by rounding luck.
 */
export function allocateStroops(
  totalStroops: bigint,
  allocations: BpsAllocation[],
): Map<string, bigint> {
  const totalBps = allocations.reduce((sum, a) => sum + a.bps, 0);
  if (totalBps !== BPS_DENOMINATOR) {
    throw new InvalidBundleSplitError(
      `allocateStroops: bps must sum to ${BPS_DENOMINATOR}, got ${totalBps}`,
    );
  }
  if (totalStroops < 0n) {
    throw new InvalidBundleSplitError('allocateStroops: totalStroops must be non-negative');
  }

  const denom = BigInt(BPS_DENOMINATOR);
  const shares = allocations.map(({ key, bps }) => {
    const product = totalStroops * BigInt(bps);
    return { key, floor: product / denom, remainder: product % denom };
  });

  const result = new Map<string, bigint>();
  for (const share of shares) result.set(share.key, share.floor);

  const distributed = shares.reduce((sum, s) => sum + s.floor, 0n);
  let dust = totalStroops - distributed;

  const byRemainderDesc = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  let i = 0;
  while (dust > 0n) {
    const target = byRemainderDesc[i % byRemainderDesc.length];
    if (!target) break; // unreachable — byRemainderDesc is never empty once dust > 0
    result.set(target.key, (result.get(target.key) ?? 0n) + 1n);
    dust -= 1n;
    i += 1;
  }

  return result;
}
