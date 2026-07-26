import { Request, Response, NextFunction } from 'express';
import { parsePositiveInt } from './env';

interface RateLimitInfo {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
  skip?: (req: Request) => boolean;
}

interface ResolvedRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_GLOBAL_MAX_REQUESTS = 200;
const DEFAULT_PAYMENTS_MAX_REQUESTS = 10;
const DEFAULT_AGENT_MAX_REQUESTS = 5;

export function getRateLimitConfig(
  tier: 'global' | 'payments' | 'agent',
  overrides: RateLimitOptions = {},
): ResolvedRateLimitConfig {
  const windowMs =
    overrides.windowMs ?? parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);

  const defaultMaxRequests =
    tier === 'global'
      ? DEFAULT_GLOBAL_MAX_REQUESTS
      : tier === 'payments'
        ? DEFAULT_PAYMENTS_MAX_REQUESTS
        : DEFAULT_AGENT_MAX_REQUESTS;

  const envKey =
    tier === 'global'
      ? 'RATE_LIMIT_MAX'
      : tier === 'payments'
        ? 'RATE_LIMIT_PAYMENTS_MAX'
        : 'RATE_LIMIT_AGENT_MAX';

  const maxRequests =
    overrides.maxRequests ?? parsePositiveInt(process.env[envKey], defaultMaxRequests);

  return { windowMs, maxRequests };
}

export const createRateLimitMiddleware = (options: RateLimitOptions = {}) => {
  const rateLimits = new Map<string, RateLimitInfo>();

  const { windowMs, maxRequests } = getRateLimitConfig('global', options);

  return (req: Request, res: Response, next: NextFunction) => {
    if (options.skip?.(req)) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let info = rateLimits.get(ip);

    if (!info || now > info.resetAt) {
      info = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    info.count += 1;
    rateLimits.set(ip, info);

    const remaining = Math.max(0, maxRequests - info.count);
    const resetSeconds = Math.ceil(info.resetAt / 1000);
    const retryAfterSeconds = Math.max(1, Math.ceil((info.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (info.count > maxRequests) {
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: retryAfterSeconds,
      });
    }

    next();
  };
};

export const createGlobalRateLimitMiddleware = (options: RateLimitOptions = {}) =>
  createRateLimitMiddleware(getRateLimitConfig('global', options));

export const createPaymentsRateLimitMiddleware = (options: RateLimitOptions = {}) =>
  createRateLimitMiddleware(getRateLimitConfig('payments', options));

export const createAgentRateLimitMiddleware = (options: RateLimitOptions = {}) =>
  createRateLimitMiddleware(getRateLimitConfig('agent', options));

// Export a default instance for convenience
export const rateLimitMiddleware = createGlobalRateLimitMiddleware();
