/**
 * splitSliders.ts — #615
 *
 * Pure math behind the curator bundle builder's linked split sliders: moving
 * one slider must always leave every slider summing to exactly 100% (10 000
 * bps) — the same invariant the backend enforces server-side
 * (bundle.splits.ts's assertValidBundleSplit). Kept separate from any React
 * component so the redistribution logic is provable with plain unit tests.
 */

export const BPS_TOTAL = 10_000;

export interface SplitEntry {
  id: string;
  bps: number;
}

/** Splits 10 000 bps evenly across `ids`, handing any remainder (from integer division) to the first entries so the total is always exact. */
export function evenSplit(ids: string[]): SplitEntry[] {
  if (ids.length === 0) return [];
  const base = Math.floor(BPS_TOTAL / ids.length);
  const remainder = BPS_TOTAL - base * ids.length;
  return ids.map((id, i) => ({ id, bps: base + (i < remainder ? 1 : 0) }));
}

/**
 * Moves `changedId`'s slider to `requestedBps` and proportionally rescales
 * every other entry so the whole set still sums to exactly 10 000 bps — the
 * classic "linked budget allocator" interaction. Every other entry keeps its
 * relative weight; if every other entry is currently at 0 (nothing to scale
 * proportionally from), the freed-up room is split evenly among them
 * instead. Integer rounding can leave the total off by a few bps, so any
 * leftover is assigned to whichever "other" entry currently has the largest
 * share — never fabricated basis points, just consistent placement of the
 * unavoidable rounding remainder.
 */
export function redistributeSplit(
  entries: SplitEntry[],
  changedId: string,
  requestedBps: number,
): SplitEntry[] {
  if (!entries.some(e => e.id === changedId)) return entries;

  const clamped = Math.max(0, Math.min(BPS_TOTAL, Math.round(requestedBps)));
  const others = entries.filter(e => e.id !== changedId);
  const otherRoom = BPS_TOTAL - clamped;
  const otherCurrentSum = others.reduce((sum, e) => sum + e.bps, 0);

  let redistributed: SplitEntry[];
  if (others.length === 0) {
    redistributed = [];
  } else if (otherCurrentSum === 0) {
    redistributed = evenSplit(others.map(e => e.id)).map(e => ({
      id: e.id,
      bps: Math.round((e.bps / BPS_TOTAL) * otherRoom),
    }));
  } else {
    redistributed = others.map(e => ({
      id: e.id,
      bps: Math.round((e.bps / otherCurrentSum) * otherRoom),
    }));
  }

  if (redistributed.length > 0) {
    const sumSoFar = clamped + redistributed.reduce((sum, e) => sum + e.bps, 0);
    const dust = BPS_TOTAL - sumSoFar;
    const target = [...redistributed].sort((a, b) =>
      a.bps === b.bps ? (a.id < b.id ? -1 : 1) : b.bps - a.bps,
    )[0];
    if (dust !== 0 && target) {
      target.bps = Math.max(0, target.bps + dust);
    }
  }

  const byId = new Map(redistributed.map(e => [e.id, e.bps]));
  return entries.map(e =>
    e.id === changedId ? { id: e.id, bps: clamped } : { id: e.id, bps: byId.get(e.id) ?? 0 },
  );
}
