import { describe, expect, it } from 'vitest';
import { canonicalize, contentHash, payloadContentHash, stripVolatileKeys } from './canonical';

describe('canonicalize', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it('drops undefined members but keeps nulls', () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('renders array holes as null, matching JSON.stringify', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('rejects non-finite numbers rather than silently writing null', () => {
    expect(() => canonicalize({ ratio: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ ratio: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('normalises -0 to 0', () => {
    expect(canonicalize({ v: -0 })).toBe(canonicalize({ v: 0 }));
  });

  it('serialises dates as ISO instants', () => {
    expect(canonicalize({ at: new Date('2026-08-03T00:00:00.000Z') })).toBe(
      '{"at":"2026-08-03T00:00:00.000Z"}',
    );
  });
});

describe('contentHash', () => {
  it('is a 64-character hex sha256', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agrees for payloads that differ only in key order', () => {
    expect(contentHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(
      contentHash({ b: [{ y: 2, x: 1 }], a: 1 }),
    );
  });

  it('differs when any value differs', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('payloadContentHash', () => {
  it('ignores the refresh timestamp so an unchanged poll hashes the same', () => {
    const first = { rows: [1, 2], _fetchedAt: '2026-08-03T00:00:00.000Z' };
    const second = { rows: [1, 2], _fetchedAt: '2026-08-03T00:05:00.000Z' };
    expect(payloadContentHash(first)).toBe(payloadContentHash(second));
  });

  it('still notices a real content change', () => {
    const first = { rows: [1, 2], _fetchedAt: '2026-08-03T00:00:00.000Z' };
    const second = { rows: [1, 3], _fetchedAt: '2026-08-03T00:00:00.000Z' };
    expect(payloadContentHash(first)).not.toBe(payloadContentHash(second));
  });
});

describe('stripVolatileKeys', () => {
  it('removes only the refresh bookkeeping', () => {
    expect(stripVolatileKeys({ a: 1, _live: true, _fetchedAt: 'now' })).toEqual({
      a: 1,
      _live: true,
    });
  });
});
