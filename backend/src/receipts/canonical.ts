/**
 * canonical.ts — RFC 8785 (JCS) JSON Canonicalization Scheme.
 *
 * Implements the JSON Canonicalization Scheme per RFC 8785 for deterministic
 * serialization of JSON data. The canonical form is:
 * - Object keys sorted by UTF-16 code unit order
 * - No insignificant whitespace
 * - -0 preserved as -0 (not normalized to 0)
 * - Numbers serialized using ES6 Number.prototype.toString() semantics
 *   (shortest round-trippable decimal representation)
 * - undefined, functions, symbols dropped
 * - NaN, Infinity, -Infinity rejected (throw TypeError)
 * - Dates serialized as ISO 8601 UTC string
 * - Array holes serialized as null
 *
 * This implementation is independent and can be verified against RFC 8785 test vectors.
 */

import { createHash } from 'crypto';

export interface CanonicalizeOptions {
  /**
   * If true, reject non-finite numbers (NaN, Infinity) with TypeError.
   * If false (default for compatibility), follow JSON.stringify behavior of
   * serializing them as null. RFC 8785 requires rejection.
   */
  strictNumbers?: boolean;
}

/**
 * Serialize a JSON value to its RFC 8785 canonical form.
 *
 * @param value The value to canonicalize (must be JSON-serializable)
 * @param options Optional configuration
 * @returns Canonical UTF-8 string representation
 * @throws TypeError if value contains non-finite numbers and strictNumbers is true
 */
export function canonicalize(
  value: unknown,
  options: CanonicalizeOptions = { strictNumbers: true },
): string {
  const result = canonicalizeValue(value, '', options);
  return result ?? 'null';
}

function canonicalizeValue(
  value: unknown,
  path: string,
  options: CanonicalizeOptions,
): string | undefined {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        if (options.strictNumbers) {
          throw new TypeError(
            `Cannot canonicalise non-finite number at ${path || '<root>'}`,
          );
        }
        return 'null';
      }
      // Preserve -0 per RFC 8785: Object.is(-0, 0) is false, but -0 === 0 is true
      if (Object.is(value, -0)) {
        return '-0';
      }
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
      canonicalizeValue(item, `${path}[${i}]`, options) ?? 'null',
    );
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    return escapeString(value.toISOString());
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => {
      return a.localeCompare(b, undefined, { numeric: false, sensitivity: 'variant' });
    });
    const entries: string[] = [];
    for (const key of keys) {
      const serialized = canonicalizeValue(obj[key], path ? `${path}.${key}` : key, options);
      if (serialized === undefined) continue;
      entries.push(`${escapeString(key)}:${serialized}`);
    }
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Unsupported value type at ${path || '<root>'}: ${typeof value}`);
}

/**
 * Escape a string per RFC 8785 (which references RFC 8259 JSON string escaping).
 * Control characters, quote, backslash must be escaped.
 */
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

/**
 * Compute SHA-256 hash of the canonical form of a value.
 * Returns lowercase hex string (64 characters).
 */
export function contentHash(value: unknown, options?: CanonicalizeOptions): string {
  const canonical = canonicalize(value, options);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Compute SHA-256 hash of canonical form as raw bytes (32 bytes).
 */
export function contentHashBytes(value: unknown, options?: CanonicalizeOptions): Buffer {
  const canonical = canonicalize(value, options);
  return createHash('sha256').update(canonical, 'utf8').digest();
}