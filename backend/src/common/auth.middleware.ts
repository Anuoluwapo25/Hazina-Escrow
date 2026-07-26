import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger';

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
 * Accepts either the shared API key or a seller JWT.
 * When a seller JWT is used, the wallet in the request body must match the JWT claim.
 */
export function requireSellerMutationAuth(req: Request, res: Response, next: NextFunction) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
  }

  const apiKey = process.env.API_KEY;
  if (apiKey && token === apiKey) {
    return next();
  }

  const secret = process.env.SELLER_JWT_SECRET;
  if (!secret) {
    return apiKey
      ? res.status(403).json({ error: 'Invalid API key' })
      : res.status(503).json({ error: 'Server misconfigured: SELLER_JWT_SECRET is not set' });
  }

  const claims = verifySellerJwt(token, secret);
  if (!claims) {
    return apiKey
      ? res.status(403).json({ error: 'Invalid API key' })
      : res.status(401).json({ error: 'Invalid or expired seller token' });
  }

  const requestWallet = getRequestWallet(req, 'sellerWallet');
  if (requestWallet && requestWallet !== claims.sellerWallet) {
    return res.status(403).json({ error: 'Authenticated wallet does not match request body' });
  }

  req.sellerAuth = claims;
  next();
}

/**
 * For GET /:sellerWallet — accepts the shared API key (admin, no wallet scope
 * restriction) OR a seller JWT scoped to the wallet in req.params.sellerWallet.
 * In non-production, skips auth when neither API_KEY nor SELLER_JWT_SECRET is set.
 */
export function requireSellerReadAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.API_KEY;
  const secret = process.env.SELLER_JWT_SECRET;

  if (!apiKey && !secret) {
    if (process.env.NODE_ENV === 'production') {
      return res
        .status(503)
        .json({ error: 'Server misconfigured: API_KEY or SELLER_JWT_SECRET must be set' });
    }
    logger.warn(
      '[auth] API_KEY and SELLER_JWT_SECRET not set — skipping read auth in non-production',
    );
    return next();
  }

  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
  }

  // Shared API key — admin, can read any seller's data.
  if (apiKey && token === apiKey) return next();

  // Seller JWT — must be scoped to the wallet in the route param.
  if (!secret) {
    return res.status(503).json({ error: 'Server misconfigured: SELLER_JWT_SECRET is not set' });
  }
  const claims = verifySellerJwt(token, secret);
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

/** Protects seller dashboard reads with a non-optional, expiring HS256 JWT. */
export function requireSellerJwt(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.SELLER_JWT_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Server misconfigured: SELLER_JWT_SECRET is not set' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or not Bearer' });
  }

  const claims = verifySellerJwt(authHeader.slice(7), secret);
  if (!claims) {
    return res.status(401).json({ error: 'Invalid or expired seller token' });
  }

  req.sellerAuth = claims;
  next();
}
