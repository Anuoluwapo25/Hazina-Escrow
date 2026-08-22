import { describe, expect, it } from 'vitest';
import { evenSplit, redistributeSplit, BPS_TOTAL } from './splitSliders';

function sum(entries: { bps: number }[]): number {
  return entries.reduce((s, e) => s + e.bps, 0);
}

function mustFind(entries: { id: string; bps: number }[], id: string): { id: string; bps: number } {
  const entry = entries.find(e => e.id === id);
  if (!entry) throw new Error(`Test fixture error: expected entry "${id}"`);
  return entry;
}

describe('evenSplit', () => {
  it('splits evenly when the count divides 10000 exactly', () => {
    const result = evenSplit(['a', 'b', 'c', 'd']);
    expect(result.every(e => e.bps === 2500)).toBe(true);
    expect(sum(result)).toBe(BPS_TOTAL);
  });

  it('hands the remainder to the first entries when it does not divide evenly', () => {
    const result = evenSplit(['a', 'b', 'c']);
    expect(sum(result)).toBe(BPS_TOTAL);
    expect(result.map(e => e.bps)).toEqual([3334, 3333, 3333]);
  });

  it('returns an empty array for no entries', () => {
    expect(evenSplit([])).toEqual([]);
  });
});

describe('redistributeSplit', () => {
  it('always sums to exactly 10000 after a single change', () => {
    const start = evenSplit(['whale', 'risk', 'sentiment', 'curator']);
    const result = redistributeSplit(start, 'whale', 6000);
    expect(sum(result)).toBe(BPS_TOTAL);
    expect(result.find(e => e.id === 'whale')?.bps).toBe(6000);
  });

  it('rescales the other entries proportionally to their prior weights', () => {
    // whale=5000, risk=3000, sentiment=2000 — risk:sentiment is 3:2.
    const start = [
      { id: 'whale', bps: 5000 },
      { id: 'risk', bps: 3000 },
      { id: 'sentiment', bps: 2000 },
    ];
    const result = redistributeSplit(start, 'whale', 0);
    expect(sum(result)).toBe(BPS_TOTAL);
    const risk = mustFind(result, 'risk').bps;
    const sentiment = mustFind(result, 'sentiment').bps;
    // whale now takes 0, so risk+sentiment must fill the full 10000, still 3:2 -> 6000:4000.
    expect(risk).toBe(6000);
    expect(sentiment).toBe(4000);
  });

  it('splits evenly among the others when they are all currently at zero', () => {
    const start = [
      { id: 'whale', bps: 10000 },
      { id: 'risk', bps: 0 },
      { id: 'sentiment', bps: 0 },
    ];
    const result = redistributeSplit(start, 'whale', 4000);
    expect(sum(result)).toBe(BPS_TOTAL);
    const risk = mustFind(result, 'risk').bps;
    const sentiment = mustFind(result, 'sentiment').bps;
    expect(risk + sentiment).toBe(6000);
    expect(Math.abs(risk - sentiment)).toBeLessThanOrEqual(1); // even, modulo rounding dust
  });

  it('clamps the requested value into [0, 10000]', () => {
    const start = evenSplit(['a', 'b']);
    expect(redistributeSplit(start, 'a', -500).find(e => e.id === 'a')?.bps).toBe(0);
    expect(redistributeSplit(start, 'a', 15000).find(e => e.id === 'a')?.bps).toBe(10000);
  });

  it('is a no-op for an unknown id', () => {
    const start = evenSplit(['a', 'b']);
    expect(redistributeSplit(start, 'missing', 9000)).toEqual(start);
  });

  it('never lets an entry go negative, even after repeated redistribution', () => {
    let entries = evenSplit(['a', 'b', 'c', 'd', 'e']);
    // Repeatedly slam different sliders to extremes and check the invariant holds every time.
    const moves: [string, number][] = [
      ['a', 9000],
      ['b', 9000],
      ['c', 0],
      ['d', 5000],
      ['e', 10000],
      ['a', 100],
    ];
    for (const [id, value] of moves) {
      entries = redistributeSplit(entries, id, value);
      expect(sum(entries)).toBe(BPS_TOTAL);
      for (const entry of entries) {
        expect(entry.bps).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
