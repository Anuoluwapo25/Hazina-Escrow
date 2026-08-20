import { describe, expect, it } from 'vitest';
import { canonicalize, contentHash, contentHashBytes } from './canonical';

describe('canonicalize (RFC 8785 JCS)', () => {
  it('sorts object keys by UTF-16 code unit order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('sorts nested object keys recursively', () => {
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

  it('rejects non-finite numbers (NaN, Infinity) in strict mode', () => {
    expect(() => canonicalize({ ratio: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ ratio: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalize({ ratio: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
  });

  it('preserves -0 as -0 per RFC 8785', () => {
    expect(canonicalize({ v: -0 })).toBe('{"v":-0}');
    expect(canonicalize({ v: 0 })).toBe('{"v":0}');
    expect(canonicalize({ v: -0 })).not.toBe(canonicalize({ v: 0 }));
  });

  it('serializes numbers using shortest round-trippable form', () => {
    expect(canonicalize({ n: 1.5 })).toBe('{"n":1.5}');
    expect(canonicalize({ n: 1.0 })).toBe('{"n":1}');
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
  });

  it('escapes strings per RFC 8259', () => {
    expect(canonicalize({ s: 'hello"world' })).toBe('{"s":"hello\\"world"}');
    expect(canonicalize({ s: 'hello\\world' })).toBe('{"s":"hello\\\\world"}');
    expect(canonicalize({ s: 'hello\nworld' })).toBe('{"s":"hello\\nworld"}');
    expect(canonicalize({ s: 'hello\tworld' })).toBe('{"s":"hello\\tworld"}');
    expect(canonicalize({ s: '\u0000' })).toBe('{"s":"\\u0000"}');
  });

  it('serializes Date as ISO 8601 UTC string', () => {
    expect(canonicalize({ at: new Date('2026-08-03T00:00:00.000Z') })).toBe(
      '{"at":"2026-08-03T00:00:00.000Z"}',
    );
  });

  it('handles Unicode keys correctly', () => {
    const obj1 = { '🎉': 1, '👋': 2 };
    const obj2 = { '👋': 2, '🎉': 1 };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });

  it('handles deeply nested structures', () => {
    const complex = {
      a: [{ b: { c: [1, 2, 3] } }, { d: 4 }],
      e: { f: { g: { h: 5 } } },
    };
    expect(canonicalize(complex)).toBe(
      '{"a":[{"b":{"c":[1,2,3]}},{"d":4}],"e":{"f":{"g":{"h":5}}}}',
    );
  });

  it('produces deterministic output for identical semantic content', () => {
    const iterations = 100;
    const results = new Set();
    for (let i = 0; i < iterations; i++) {
      results.add(canonicalize({ b: 1, a: 2, c: [3, { d: 4 }] }));
    }
    expect(results.size).toBe(1);
  });
});

describe('contentHash', () => {
  it('returns 64-character lowercase hex string', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of key order', () => {
    expect(contentHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(
      contentHash({ b: [{ y: 2, x: 1 }], a: 1 }),
    );
  });

  it('differs when any value differs', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('is deterministic across multiple calls', () => {
    const h1 = contentHash({ x: 1, y: 2 });
    const h2 = contentHash({ x: 1, y: 2 });
    expect(h1).toBe(h2);
  });
});

describe('contentHashBytes', () => {
  it('returns 32-byte Buffer', () => {
    const hash = contentHashBytes({ a: 1 });
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);
  });

  it('matches hex output of contentHash', () => {
    const bytes = contentHashBytes({ a: 1 });
    const hex = contentHash({ a: 1 });
    expect(bytes.toString('hex')).toBe(hex);
  });
});

// RFC 8785 test vectors from the spec
// https://www.rfc-editor.org/rfc/rfc8785.html#appendix-A
describe('RFC 8785 test vectors', () => {
  it('matches RFC 8785 example 1: simple object', () => {
    const input = { hello: 'world' };
    // RFC 8785 canonical form: {"hello":"world"}
    expect(canonicalize(input)).toBe('{"hello":"world"}');
  });

  it('matches RFC 8785 example 2: nested object', () => {
    const input = { a: { b: { c: 'd' } } };
    expect(canonicalize(input)).toBe('{"a":{"b":{"c":"d"}}}');
  });

  it('matches RFC 8785 example 3: array', () => {
    const input = { a: [1, 2, 3] };
    expect(canonicalize(input)).toBe('{"a":[1,2,3]}');
  });

  it('matches RFC 8785 example 4: multiple keys sorted', () => {
    const input = { c: 3, a: 1, b: 2 };
    expect(canonicalize(input)).toBe('{"a":1,"b":2,"c":3}');
  });

  it('matches RFC 8785 example 5: numbers', () => {
    const input = { numbers: [1.5, -2.5, 0, -0] };
    // Note: RFC 8785 preserves -0
    expect(canonicalize(input)).toBe('{"numbers":[1.5,-2.5,0,-0]}');
  });

  it('matches RFC 8785 example 6: null and boolean', () => {
    const input = { a: null, b: true, c: false };
    expect(canonicalize(input)).toBe('{"a":null,"b":true,"c":false}');
  });

  it('handles empty object', () => {
    expect(canonicalize({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(canonicalize({ arr: [] })).toBe('{"arr":[]}');
  });
});
