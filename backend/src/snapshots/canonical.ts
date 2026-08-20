/**
 * canonical.ts — deterministic serialisation and content addressing (#600).
 *
 * Every snapshot is keyed by `sha256(canonicalize(payload))`. Two refreshes that
 * carry the same information therefore collapse onto the same key no matter how
 * the provider ordered its JSON keys, which is what makes de-duplication (and a
 * hash a buyer can quote in a dispute) possible.
 *
 * The canonical form is the JCS shape (RFC 8785) restricted to what a dataset
 * payload can actually contain: object keys sorted by UTF-16 code unit, no
 * insignificant whitespace, `undefined` and function values dropped, and
 * non-finite numbers rejected rather than silently turned into `null`. Delivery
 * receipts hash the same way, so a receipt hash and a snapshot hash for the same
 * payload agree byte for byte.
 */

import { createHash } from 'crypto';

/** Keys carrying refresh bookkeeping rather than dataset content. */
const VOLATILE_KEYS = new Set(['_fetchedAt']);

function canonicalValue(value: unknown, path: string): string | undefined {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalise non-finite number at ${path || '<root>'}`);
      }
      // `-0` and `0` are the same quantity; JSON.stringify already prints the
      // shortest round-trippable form for every other finite double.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map(
      (item, i) => canonicalValue(item, `${path}[${i}]`) ?? 'null', // holes/undefined → null, as JSON.stringify does
    );
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const entries: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const serialised = canonicalValue(
      (value as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    );
    if (serialised === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${serialised}`);
  }
  return `{${entries.join(',')}}`;
}

/**
 * Strip keys that change on every poll without the dataset itself changing.
 * `_fetchedAt` is a wall-clock stamp the refresh path adds; leaving it in would
 * make every single poll look like a content change and defeat de-duplication.
 */
export function stripVolatileKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Serialise a value to its canonical JSON string. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value, '') ?? 'null';
}

/** `sha256` (hex) of the canonical form — the content address of a payload. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * Content address of a dataset payload as stored by the snapshot writer:
 * volatile refresh bookkeeping removed first, then hashed.
 */
export function payloadContentHash(payload: Record<string, unknown>): string {
  return contentHash(stripVolatileKeys(payload));
}
