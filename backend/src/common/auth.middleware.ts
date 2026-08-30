import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger';
import { isApiKeyEnabled, isSep10Enabled } from '../auth/sep10.config';
import { verifySep10Jwt } from '../auth/sep10.jwt';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export interface SellerJwtClaims {
  sellerWallet: string;
  sub?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  nbf?: number;
  exp: number;
  [claim: string]: unknown;
}

declare module 'express-serve-static-core' {
  interface Request {
    sellerAuth?: SellerJwtClaims;
  }
}

function makeBearerMiddleware(envVar: string, label: string) {
  return function requireKey(req: Request, res: Response, next: NextFunction) {
    const key = process.env[envVar];

    if (!key) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: `Server misconfigured: ${envVar} is not set` });
      }
      logger.warn(`[auth] ${envVar} not set — skipping ${label} check in non-production`);
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
    }

    const token = authHeader.slice(7);
    if (token !== key) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
  };
}

/** Protects seller write operations (dataset creation, webhook management). */
export const requireApiKey = makeBearerMiddleware('API_KEY', 'seller');

/** Protects admin-only operations (backups). */
export const requireAdminKey = makeBearerMiddleware('ADMIN_API_KEY', 'admin');

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function hasExpectedAudience(
  claimAud: string | string[] | undefined,
  expectedAud: string,
): boolean {
  if (typeof claimAud === 'string') return claimAud === expectedAud;
  if (isStringArray(claimAud)) return claimAud.includes(expectedAud);
  return false;
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(part).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function verifySellerJwt(token: string, secret: string): SellerJwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;
  const header = parseJsonPart(encodedHeader);
  const payload = parseJsonPart(encodedPayload);
  if (!header || !payload) return null;
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  const nbf = payload.nbf;
  const iat = payload.iat;
  const sellerWallet = payload.sellerWallet;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return null;
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > now)) return null;
  if (iat !== undefined && (typeof iat !== 'number' || iat > now + 60)) return null;
  if (typeof sellerWallet !== 'string' || !STELLAR_ADDRESS_REGEX.test(sellerWallet)) return null;

  const expectedIssuer = process.env.SELLER_JWT_ISSUER;
  if (expectedIssuer && payload.iss !== expectedIssuer) return null;

  const expectedAudience = process.env.SELLER_JWT_AUDIENCE;
  const aud = payload.aud;
  if (
    expectedAudience &&
    !hasExpectedAudience(
      typeof aud === 'string' || isStringArray(aud) ? aud : undefined,
      expectedAudience,
    )
  ) {
    return null;
  }

  return {
    ...payload,
    sellerWallet,
    exp,
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    iss: typeof payload.iss === 'string' ? payload.iss : undefined,
    aud: typeof aud === 'string' || isStringArray(aud) ? aud : undefined,
    iat: typeof iat === 'number' ? iat : undefined,
    nbf: typeof nbf === 'number' ? nbf : undefined,
  };
}

function getBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 0 ? token : null;
}

function getRequestWallet(req: Request, walletField: string): string | null {
  const body = req.body;
  if (!body || typeof body !== 'object') return null;

  const value = (body as Record<string, unknown>)[walletField];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The seller JWT secret for the legacy SELLER_JWT_SECRET flow, if configured.
 */
function getLegacySellerSecret(): string | undefined {
  const secret = (process.env.SELLER_JWT_SECRET ?? '').trim();
  return secret || undefined;
}

/**
 * The SEP-10 web-auth JWT secret, used only while AUTH_MODE is sep10/both.
 * Tokens minted by the /auth endpoints carry the same `sellerWallet` claim as
 * legacy tokens, so the same middlewares accept either format.
 */
function getSep10SellerSecret(): string | undefined {
  if (!isSep10Enabled()) return undefined;
  const secret = (process.env.WEB_AUTH_JWT_SECRET ?? '').trim();
  return secret || undefined;
}

/** True when any seller credential source is configured (API key or a JWT secret). */
function hasSellerAuthConfigured(): boolean {
  return (
    Boolean((process.env.API_KEY ?? '').trim()) ||
    getLegacySellerSecret() !== undefined ||
    getSep10SellerSecret() !== undefined
  );
}

/**
 * Accepts a legacy SELLER_JWT_SECRET token or a SEP-10 web-auth JWT. Returns
 * the claims (with the owning G… sellerWallet) or null when the token is
 * invalid or signed by neither configured secret.
 */
function verifyAnySellerJwt(token: string): SellerJwtClaims | null {
  const legacy = getLegacySellerSecret();
  if (legacy) {
    const claims = verifySellerJwt(token, legacy);
    if (claims) return claims;
  }
  const sep10 = getSep10SellerSecret();
  if (sep10) {
    const claims = verifySep10Jwt(token, sep10, {
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (claims) {
      return {
        ...claims,
        sellerWallet: claims.sellerWallet,
        sub: typeof claims.sub === 'string' ? claims.sub : undefined,
        iss: typeof claims.iss === 'string' ? claims.iss : undefined,
        iat: typeof claims.iat === 'number' ? claims.iat : undefined,
        exp: claims.exp,
      };
    }
  }
  return null;
}

/**
 * Factory behind {@link requireSellerMutationAuth} and
 * {@link requireCuratorMutationAuth} (#615). Accepts either the shared API key
 * (when AUTH_MODE is legacy or both) or a seller JWT (legacy SELLER_JWT_SECRET
 * or a SEP-10 web-auth token) — every wallet on the marketplace (seller or
 * curator) is the same identity, scoped by the same `sellerWallet` JWT claim.
 * When a JWT is used, `walletField` in the request body must match the JWT's
 * wallet claim, so a curator can only build a bundle they can prove ownership of.
 */
function makeWalletMutationAuth(walletField: string) {
  return function requireWalletMutationAuth(req: Request, res: Response, next: NextFunction) {
    const token = getBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
    }

    const apiKey = process.env.API_KEY;
    if (apiKey && isApiKeyEnabled() && token === apiKey) {
      return next();
    }

    const claims = verifyAnySellerJwt(token);
    if (!claims) {
      if (apiKey && isApiKeyEnabled()) {
        return res.status(403).json({ error: 'Invalid API key' });
      }
      if (hasSellerAuthConfigured()) {
        return res.status(401).json({ error: 'Invalid or expired seller token' });
      }
      return res.status(503).json({ error: 'Server misconfigured: SELLER_JWT_SECRET is not set' });
    }

    const requestWallet = getRequestWallet(req, walletField);
    if (requestWallet && requestWallet !== claims.sellerWallet) {
      return res.status(403).json({ error: 'Authenticated wallet does not match request body' });
    }

    req.sellerAuth = claims;
    next();
  };
}

/**
 * Accepts either the shared API key (when AUTH_MODE is legacy or both) or a
 * seller JWT (legacy SELLER_JWT_SECRET or a SEP-10 web-auth token).
 * When a seller JWT is used, the wallet in the request body must match the
 * JWT claim.
 */
export const requireSellerMutationAuth = makeWalletMutationAuth('sellerWallet');

/**
 * Protects bundle creation (#615) — same trust model as
 * {@link requireSellerMutationAuth}, scoped to the `curatorWallet` field
 * instead of `sellerWallet` so a curator proves ownership of their own wallet.
 */
export const requireCuratorMutationAuth = makeWalletMutationAuth('curatorWallet');

/**
 * For GET /:sellerWallet — accepts the shared API key (admin, no wallet scope
 * restriction) OR a seller JWT (legacy or SEP-10) scoped to the wallet in
 * req.params.sellerWallet.
 * In non-production, skips auth when no seller credential is configured.
 */
export function requireSellerReadAuth(req: Request, res: Response, next: NextFunction) {
  if (!hasSellerAuthConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'Server misconfigured: API_KEY or SELLER_JWT_SECRET must be set',
      });
    }
    logger.warn(
      '[auth] no seller authentication configured — skipping read auth in non-production',
    );
    return next();
  }

  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
  }

  const apiKey = process.env.API_KEY;
  // Shared API key — admin, can read any seller's data.
  if (apiKey && isApiKeyEnabled() && token === apiKey) return next();

  const claims = verifyAnySellerJwt(token);
  if (!claims) {
    return res.status(401).json({ error: 'Invalid or expired seller token' });
  }
  const paramWallet = req.params['sellerWallet'];
  if (paramWallet && claims.sellerWallet !== paramWallet) {
    return res.status(403).json({ error: 'Token wallet does not match requested seller' });
  }
  req.sellerAuth = claims;
  next();
}

/**
 * Attaches seller claims when a valid token is present, and does nothing when
 * one is not. For routes that are public but reveal more to the owning seller —
 * dataset history, where anyone may read the shape of the timeline but only the
 * seller (or a buyer with a completed purchase) may read the payloads.
 */
export function attachSellerAuthIfPresent(req: Request, _res: Response, next: NextFunction) {
  const token = getBearerToken(req.headers.authorization);
  if (token) {
    const claims = verifyAnySellerJwt(token);
    if (claims) req.sellerAuth = claims;
  }
  next();
}

/** Protects seller dashboard reads with a non-optional, expiring HS256 JWT. */
export function requireSellerJwt(req: Request, res: Response, next: NextFunction) {
  if (!hasSellerAuthConfigured()) {
    return res.status(503).json({ error: 'Server misconfigured: SELLER_JWT_SECRET is not set' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
  }

  const claims = verifyAnySellerJwt(authHeader.slice(7));
  if (!claims) {
    return res.status(401).json({ error: 'Invalid or expired seller token' });
  }

  req.sellerAuth = claims;
  next();
}
