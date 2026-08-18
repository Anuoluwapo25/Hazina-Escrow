/**
 * compression.ts — snapshot payload compression (#600).
 *
 * Payloads are stored as gzip'd canonical JSON, base64-encoded so the column
 * stays a plain `text` on both SQLite and Postgres. Dataset payloads are JSON
 * with heavily repeated keys, which is the case gzip handles best — measured on
 * the seeded whale/yield/risk feeds the stored size lands around a fifth of the
 * canonical JSON (see `snapshots.compression.test.ts`, which asserts the ratio
 * so a regression in the encoding path is caught).
 *
 * Tiny payloads are the exception: below `MIN_COMPRESSION_BYTES` the gzip header
 * costs more than it saves, so those are stored as plain JSON. The `encoding`
 * column records which form a row uses, so both are readable forever.
 */

import { gzipSync, gunzipSync, constants as zlibConstants } from 'zlib';

export type SnapshotEncoding = 'gzip+base64' | 'json';

/** Below this size gzip's ~20-byte envelope outweighs any saving. */
const MIN_COMPRESSION_BYTES = 256;

export interface EncodedPayload {
  /** Storable representation of the canonical JSON. */
  payload: string;
  encoding: SnapshotEncoding;
  /** Bytes actually stored. */
  byteSize: number;
  /** Bytes the canonical JSON would have taken uncompressed. */
  rawByteSize: number;
}

/** Compress canonical JSON for storage. */
export function encodePayload(canonicalJson: string): EncodedPayload {
  const rawByteSize = Buffer.byteLength(canonicalJson, 'utf8');

  if (rawByteSize < MIN_COMPRESSION_BYTES) {
    return { payload: canonicalJson, encoding: 'json', byteSize: rawByteSize, rawByteSize };
  }

  const gzipped = gzipSync(Buffer.from(canonicalJson, 'utf8'), {
    level: zlibConstants.Z_BEST_COMPRESSION,
  }).toString('base64');

  return {
    payload: gzipped,
    encoding: 'gzip+base64',
    byteSize: Buffer.byteLength(gzipped, 'utf8'),
    rawByteSize,
  };
}

/** Inverse of {@link encodePayload}. Throws on an unknown encoding. */
export function decodePayload(payload: string, encoding: string): string {
  if (encoding === 'json') return payload;
  if (encoding === 'gzip+base64') {
    return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
  }
  throw new Error(`Unsupported snapshot encoding: ${encoding}`);
}
