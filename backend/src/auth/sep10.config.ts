/**
 * SEP-10 (Sign in with Stellar) configuration.
 *
 * Pure environment parsing — no Stellar SDK imports in this module. Keeping the
 * SDK out of the module boundary matters: existing router tests mock
 * `@stellar/stellar-sdk` down to `{ StrKey }`, and every module in their import
 * graph must therefore survive that mock. SDK-dependent code (keypair
 * derivation, transaction building) lives in `sep10.service.ts` instead.
 */

export type AuthMode = 'legacy' | 'sep10' | 'both';

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_JWT_TTL_SECONDS = 900;
const FALLBACK_AUTH_DOMAIN = 'hazina-escrow.app';

/**
 * A valid hostname per SEP-10's home-domain rules: a fully qualified domain
 * name with no scheme, no port, and no path. Lowercased before matching.
 */
const HOME_DOMAIN_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

export function getAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? 'legacy').trim().toLowerCase();
  if (raw === 'sep10') return 'sep10';
  if (raw === 'both') return 'both';
  return 'legacy';
}

export function isSep10Enabled(): boolean {
  return getAuthMode() !== 'legacy';
}

/** True when the shared API key may be used alongside SEP-10 (AUTH_MODE=both). */
export function isApiKeyEnabled(): boolean {
  return getAuthMode() !== 'sep10';
}

export function getSep10ChallengeTtlSeconds(): number {
  const raw = process.env.SEP10_CHALLENGE_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 3600
    ? parsed
    : DEFAULT_CHALLENGE_TTL_SECONDS;
}

export function getSep10JwtTtlSeconds(): number {
  const raw = process.env.SEP10_JWT_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 86400
    ? parsed
    : DEFAULT_JWT_TTL_SECONDS;
}

export function getWebAuthJwtSecret(): string {
  const secret = (process.env.WEB_AUTH_JWT_SECRET ?? '').trim();
  if (!secret) {
    throw new Error(
      '[Sep10Config] WEB_AUTH_JWT_SECRET is not set — SEP-10 authentication requires ' +
        'it to sign and verify seller JWT tokens.',
    );
  }
  return secret;
}

/** The web-auth signing keypair secret. Resolved in the service layer, not here. */
export function getWebAuthSigningSecret(): string {
  const secret = (process.env.WEB_AUTH_SIGNING_KEY ?? '').trim();
  if (!secret) {
    throw new Error(
      '[Sep10Config] WEB_AUTH_SIGNING_KEY is not set — SEP-10 authentication requires ' +
        'the server signing account secret key.',
    );
  }
  return secret;
}

/** Public base URL used to advertise SEP-1/SEP-10 endpoints, or '' when unset. */
export function getPublicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? '').trim();
}

/**
 * The server's own home domain, resolved from WEB_AUTH_DOMAIN, falling back to
 * the host of PUBLIC_BASE_URL. Returns null when neither is configured — the
 * SEP-1 endpoint then derives the domain from the incoming request host.
 */
export function getConfiguredWebAuthDomain(): string | null {
  const configured = (process.env.WEB_AUTH_DOMAIN ?? '').trim().toLowerCase();
  if (configured) return configured;
  const baseUrl = getPublicBaseUrl();
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      if (hostname) return hostname;
    } catch {
      // fall through to null — request-host derivation is used instead
    }
  }
  return null;
}

/**
 * Domain used when no WEB_AUTH_DOMAIN or PUBLIC_BASE_URL is configured. Kept as
 * a last-resort so challenge issuance never serves a blank web_auth_domain.
 */
export function getFallbackAuthDomain(): string {
  return FALLBACK_AUTH_DOMAIN;
}

export function validateHomeDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return false;
  }
  return HOME_DOMAIN_REGEX.test(normalized);
}

/**
 * Fail-fast startup validation for SEP-10. Runs before the server listens so a
 * misconfigured AUTH_MODE crashes startup instead of 500ing the first login.
 */
export function validateSep10Config(): void {
  if (!isSep10Enabled()) return;

  const missing: string[] = [];
  if (!(process.env.WEB_AUTH_SIGNING_KEY ?? '').trim()) missing.push('WEB_AUTH_SIGNING_KEY');
  if (!(process.env.WEB_AUTH_JWT_SECRET ?? '').trim()) missing.push('WEB_AUTH_JWT_SECRET');

  const configuredDomain = getConfiguredWebAuthDomain();
  if (configuredDomain && !validateHomeDomain(configuredDomain)) {
    throw new Error(
      `[Sep10Config] WEB_AUTH_DOMAIN "${configuredDomain}" is not a valid hostname — ` +
        'expected a fully qualified domain name without scheme, port, or path.',
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `[Sep10Config] AUTH_MODE=${getAuthMode()} requires ${missing.join(' and ')} to be set.`,
    );
  }
}
