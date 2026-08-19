import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical';
import { decodePayload, encodePayload } from './compression';

/** A payload shaped like a real whale-movement feed: many repeated keys. */
function buildWhaleFeed(rows: number): Record<string, unknown> {
  return {
    updatedAt: '2026-08-03T00:00:00.000Z',
    wallets: Array.from({ length: rows }, (_, i) => ({
      address: `G${String(i).padStart(55, 'A')}`,
      balance: 1_000_000 + i * 137,
      lastMovedAt: '2026-08-02T18:30:00.000Z',
      chain: 'stellar',
      label: `whale-${i}`,
    })),
  };
}

describe('encodePayload / decodePayload', () => {
  it('round-trips a compressed payload byte for byte', () => {
    const canonical = canonicalize(buildWhaleFeed(50));
    const encoded = encodePayload(canonical);
    expect(encoded.encoding).toBe('gzip+base64');
    expect(decodePayload(encoded.payload, encoded.encoding)).toBe(canonical);
  });

  it('stores tiny payloads as plain JSON, where gzip would only add overhead', () => {
    const canonical = canonicalize({ a: 1 });
    const encoded = encodePayload(canonical);
    expect(encoded.encoding).toBe('json');
    expect(encoded.byteSize).toBe(encoded.rawByteSize);
    expect(decodePayload(encoded.payload, encoded.encoding)).toBe(canonical);
  });

  it('compresses a realistic feed to well under a third of its raw size', () => {
    const canonical = canonicalize(buildWhaleFeed(200));
    const encoded = encodePayload(canonical);
    // Measured on this fixture: ~24 KB raw → ~2.5 KB stored (base64 included).
    expect(encoded.byteSize).toBeLessThan(encoded.rawByteSize / 3);
  });

  it('rejects an unknown encoding rather than returning garbage', () => {
    expect(() => decodePayload('abc', 'brotli')).toThrow(/Unsupported snapshot encoding/);
  });
});
