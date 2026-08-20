import { describe, expect, it } from 'vitest';
import { diffPayloads } from './snapshots.diff';

describe('diffPayloads', () => {
  it('reports identical payloads as identical', () => {
    const diff = diffPayloads({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 });
    expect(diff.identical).toBe(true);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(diff.entries).toEqual([]);
  });

  it('counts added, removed, and changed leaves', () => {
    const diff = diffPayloads({ keep: 1, drop: 2, move: 3 }, { keep: 1, move: 4, fresh: 5 });
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.entries).toEqual([
      { path: 'drop', op: 'removed', before: 2 },
      { path: 'fresh', op: 'added', after: 5 },
      { path: 'move', op: 'changed', before: 3, after: 4 },
    ]);
  });

  it('matches array elements by identity, not position', () => {
    const before = {
      wallets: [
        { address: 'GA', balance: 1 },
        { address: 'GB', balance: 2 },
      ],
    };
    const after = {
      wallets: [
        { address: 'GC', balance: 9 },
        { address: 'GA', balance: 1 },
        { address: 'GB', balance: 5 },
      ],
    };

    const diff = diffPayloads(before, after);
    // One wallet added and one balance changed — not "everything shifted".
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(diff.entries).toEqual([
      { path: 'wallets[GB].balance', op: 'changed', before: 2, after: 5 },
      { path: 'wallets[GC]', op: 'added', after: { address: 'GC', balance: 9 } },
    ]);
  });

  it('reads a real refresh as "N added, N removed, N changed"', () => {
    const before = {
      wallets: Array.from({ length: 20 }, (_, i) => ({ address: `G${i}`, balance: i })),
    };
    const after = {
      wallets: [
        ...Array.from({ length: 17 }, (_, i) => ({
          address: `G${i}`,
          balance: i < 2 ? i + 100 : i,
        })),
        ...Array.from({ length: 14 }, (_, i) => ({ address: `N${i}`, balance: i })),
      ],
    };

    const diff = diffPayloads(before, after);
    expect(diff.summary).toEqual({ added: 14, removed: 3, changed: 2 });
  });

  it('falls back to positional matching for arrays without a stable identity', () => {
    const diff = diffPayloads({ points: [1, 2, 3] }, { points: [1, 9, 3, 4] });
    expect(diff.entries).toEqual([
      { path: 'points[1]', op: 'changed', before: 2, after: 9 },
      { path: 'points[3]', op: 'added', after: 4 },
    ]);
  });

  it('descends into nested objects', () => {
    const diff = diffPayloads(
      { meta: { source: 'a', rows: 1 } },
      { meta: { source: 'b', rows: 1 } },
    );
    expect(diff.entries).toEqual([{ path: 'meta.source', op: 'changed', before: 'a', after: 'b' }]);
  });

  it('treats a type change as a single change at that path', () => {
    const diff = diffPayloads({ v: [1] }, { v: 'one' });
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(diff.entries[0]?.path).toBe('v');
  });

  it('emits entries sorted by path, so the same pair always diffs identically', () => {
    const before = { z: 1, a: 1, m: 1 };
    const after = { z: 2, a: 2, m: 2 };
    const paths = diffPayloads(before, after).entries.map(entry => entry.path);
    expect(paths).toEqual(['a', 'm', 'z']);
  });

  it('truncates the entry list but keeps the counts honest', () => {
    const before = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const after = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i + 1]));

    const diff = diffPayloads(before, after, 5);
    expect(diff.entries).toHaveLength(5);
    expect(diff.truncated).toBe(true);
    expect(diff.summary.changed).toBe(30);
  });
});
