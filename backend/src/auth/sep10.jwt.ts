/**
 * SEP-10 seller JWT minting and verification.
 *
 * Pure Node `crypto` HS256 — no external JWT dependency, matching the hand-rolled
 * verification in `common/auth.middleware.ts`. This module must never import the
 * Stellar SDK so it can be pulled into the auth-middleware import graph, which
 * existing router tests mock down to `{ StrKey }`.
 */

import crypto from 'crypto';

export interface Sep10JwtClaims {
  /** The client account that authenticated (G… or M… strkey as presented). */
  sub: string;
  /** The home domain the challenge was issued for. */
  iss: string;
  /** G… address that owns the seller resources (muxed M… converted to G…). */
  sellerWallet: string;
  exp: number;
  iat: number;
  jti: string;
  [claim: string]: unknown;
}

const G_STRKEY_REGEX = /^G[A-Z2-7]{55}$/;

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(part).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

export interface MintSep10JwtInput {
  sub: string;
  iss: string;
  sellerWallet: string;
  jti: string;
  ttlSeconds: number;
  nowSec: number;
}

export function mintSep10Jwt(input: MintSep10JwtInput, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: input.sub,
      iss: input.iss,
      sellerWallet: input.sellerWallet,
      jti: input.jti,
      iat: input.nowSec,
      exp: input.nowSec + input.ttlSeconds,
    }),
  );
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export interface VerifySep10JwtOptions {
  nowSec: number;
  /** When set, the token's `iss` must match exactly. */
  expectedIssuer?: string;
  /** Leeway (seconds) allowed on `exp`/`iat`. Defaults to 0 (strict). */
  clockToleranceSeconds?: number;
}

export function verifySep10Jwt(
  token: string,
  secret: string,
  options: VerifySep10JwtOptions,
): Sep10JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;
  const header = parseJsonPart(encodedHeader);
  const payload = parseJsonPart(encodedPayload);
  if (!header || !payload) return null;
  if (header.alg !== 'HS256') return null;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  const tolerance = options.clockToleranceSeconds ?? 0;
  const { sub, iss, sellerWallet, jti, exp, iat } = payload;

  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp + tolerance <= options.nowSec) return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (iat > options.nowSec + 60 + tolerance) return null;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof sellerWallet !== 'string' || !G_STRKEY_REGEX.test(sellerWallet)) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;

  if (options.expectedIssuer !== undefined && iss !== options.expectedIssuer) return null;

  return {
    ...payload,
    sub,
    iss: typeof iss === 'string' ? iss : '',
    sellerWallet,
    exp,
    iat,
    jti,
  };
}

/** Decode and validate the payload shape without checking the signature (for client-side expiry reads). */
export function decodeSep10JwtPayload(
  token: string,
): (Sep10JwtClaims & { sub: string; iss: string; exp: number; iat: number; jti: string }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parseJsonPart(parts[1] ?? '');
  if (!payload) return null;
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.iss !== 'string' ||
    typeof payload.sellerWallet !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number' ||
    typeof payload.jti !== 'string'
  ) {
    return null;
  }
  return payload as Sep10JwtClaims & {
    sub: string;
    iss: string;
    exp: number;
    iat: number;
    jti: string;
  };
}
