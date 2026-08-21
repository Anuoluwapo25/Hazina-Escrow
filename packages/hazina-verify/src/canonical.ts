/**
 * canonical.ts — RFC 8785 (JCS) JSON Canonicalization Scheme.
 *
 * Independent implementation for the offline verifier. Matches the backend's
 * canonical.ts byte-for-byte so a payload hashes to the same leaf hash on
 * either machine: keys sorted by UTF-16 code unit order, no insignificant
 * whitespace, -0 preserved, ES6 number formatting, undefined/functions/symbols
 * dropped, non-finite numbers rejected, Dates as ISO 8601 UTC.
 */

import { createHash } from 'crypto';

export function canonicalize(value: unknown): string {
  const result = canonicalizeValue(value, '');
  return result ?? 'null';
}

function canonicalizeValue(value: unknown, path: string): string | undefined {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalise non-finite number at ${path || '<root>'}`);
      }
      if (Object.is(value, -0)) return '-0';
      return value.toString();
    }
    case 'string':
      return escapeString(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) =>
      canonicalizeValue(item, `${path}[${i}]`) ?? 'null',
    );
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    return escapeString(value.toISOString());
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: false, sensitivity: 'variant' }),
    );
    const entries: string[] = [];
    for (const key of keys) {
      const serialized = canonicalizeValue(obj[key], path ? `${path}.${key}` : key);
      if (serialized === undefined) continue;
      entries.push(`${escapeString(key)}:${serialized}`);
    }
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Unsupported value type at ${path || '<root>'}: ${typeof value}`);
}

function escapeString(str: string): string {
  let result = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    switch (ch) {
      case '"':
        result += '\\"';
        break;
      case '\\':
        result += '\\\\';
        break;
      case '\b':
        result += '\\b';
        break;
      case '\f':
        result += '\\f';
        break;
      case '\n':
        result += '\\n';
        break;
      case '\r':
        result += '\\r';
        break;
      case '\t':
        result += '\\t';
        break;
      default:
        if (code < 0x20) {
          result += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          result += ch;
        }
    }
  }
  result += '"';
  return result;
}

/** SHA-256 of the canonical UTF-8 form, as raw 32 bytes. */
export function contentHashBytes(value: unknown): Buffer {
  const canonical = canonicalize(value);
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** SHA-256 of the canonical UTF-8 form, as lowercase hex. */
export function contentHash(value: unknown): string {
  return contentHashBytes(value).toString('hex');
}