import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAuthMode,
  getConfiguredWebAuthDomain,
  getSep10ChallengeTtlSeconds,
  getSep10JwtTtlSeconds,
  getWebAuthJwtSecret,
  isApiKeyEnabled,
  isSep10Enabled,
  validateHomeDomain,
  validateSep10Config,
} from './sep10.config';

const KEYS = [
  'AUTH_MODE',
  'WEB_AUTH_JWT_SECRET',
  'WEB_AUTH_SIGNING_KEY',
  'WEB_AUTH_DOMAIN',
  'PUBLIC_BASE_URL',
  'SEP10_CHALLENGE_TTL_SECONDS',
  'SEP10_JWT_TTL_SECONDS',
] as const;

describe('sep10.config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = saved[key] ?? '';
    }
  });

  describe('getAuthMode', () => {
    it('defaults to legacy when AUTH_MODE is unset', () => {
      delete process.env.AUTH_MODE;
      expect(getAuthMode()).toBe('legacy');
      expect(isSep10Enabled()).toBe(false);
      expect(isApiKeyEnabled()).toBe(true);
    });

    it.each(['sep10', 'both'])('parses AUTH_MODE=%s case-insensitively', mode => {
      process.env.AUTH_MODE = mode.toUpperCase();
      expect(getAuthMode()).toBe(mode);
      expect(isSep10Enabled()).toBe(true);
      expect(isApiKeyEnabled()).toBe(mode !== 'sep10');
    });

    it('treats unknown values as legacy', () => {
      process.env.AUTH_MODE = 'garbage';
      expect(getAuthMode()).toBe('legacy');
    });
  });

  describe('validateSep10Config', () => {
    it('does nothing in legacy mode without secrets', () => {
      process.env.AUTH_MODE = 'legacy';
      delete process.env.WEB_AUTH_JWT_SECRET;
      delete process.env.WEB_AUTH_SIGNING_KEY;
      expect(() => validateSep10Config()).not.toThrow();
    });

    it('throws when AUTH_MODE=sep10 but signing key is missing', () => {
      process.env.AUTH_MODE = 'sep10';
      process.env.WEB_AUTH_JWT_SECRET = 'jwt-secret';
      delete process.env.WEB_AUTH_SIGNING_KEY;
      expect(() => validateSep10Config()).toThrow(/WEB_AUTH_SIGNING_KEY/);
    });

    it('throws when AUTH_MODE=sep10 but JWT secret is missing', () => {
      process.env.AUTH_MODE = 'sep10';
      process.env.WEB_AUTH_SIGNING_KEY = 'S-secret';
      delete process.env.WEB_AUTH_JWT_SECRET;
      expect(() => validateSep10Config()).toThrow(/WEB_AUTH_JWT_SECRET/);
    });

    it('passes when AUTH_MODE=sep10 and all secrets are set', () => {
      process.env.AUTH_MODE = 'sep10';
      process.env.WEB_AUTH_SIGNING_KEY = 'S-secret';
      process.env.WEB_AUTH_JWT_SECRET = 'jwt-secret';
      expect(() => validateSep10Config()).not.toThrow();
    });

    it('rejects a WEB_AUTH_DOMAIN that is not a plain hostname', () => {
      process.env.AUTH_MODE = 'sep10';
      process.env.WEB_AUTH_SIGNING_KEY = 'S-secret';
      process.env.WEB_AUTH_JWT_SECRET = 'jwt-secret';
      process.env.WEB_AUTH_DOMAIN = 'https://hazina.app';
      expect(() => validateSep10Config()).toThrow(/not a valid hostname/);
    });
  });

  describe('validateHomeDomain', () => {
    it('accepts plain hostnames', () => {
      expect(validateHomeDomain('hazina.app')).toBe(true);
      expect(validateHomeDomain('sub.hazina.app')).toBe(true);
      expect(validateHomeDomain('HAZINA.APP')).toBe(true);
    });

    it('rejects schemes, paths, ports, and empty values', () => {
      expect(validateHomeDomain('https://hazina.app')).toBe(false);
      expect(validateHomeDomain('hazina.app/path')).toBe(false);
      expect(validateHomeDomain('hazina.app:8080')).toBe(false);
      expect(validateHomeDomain('')).toBe(false);
      expect(validateHomeDomain(' ')).toBe(false);
    });
  });

  describe('TTLs', () => {
    it('defaults challenge TTL to 300s', () => {
      delete process.env.SEP10_CHALLENGE_TTL_SECONDS;
      expect(getSep10ChallengeTtlSeconds()).toBe(300);
    });

    it('honours a valid challenge TTL', () => {
      process.env.SEP10_CHALLENGE_TTL_SECONDS = '120';
      expect(getSep10ChallengeTtlSeconds()).toBe(120);
    });

    it('rejects out-of-range challenge TTLs', () => {
      process.env.SEP10_CHALLENGE_TTL_SECONDS = '99999';
      expect(getSep10ChallengeTtlSeconds()).toBe(300);
      process.env.SEP10_CHALLENGE_TTL_SECONDS = '-5';
      expect(getSep10ChallengeTtlSeconds()).toBe(300);
    });

    it('defaults JWT TTL to 900s', () => {
      delete process.env.SEP10_JWT_TTL_SECONDS;
      expect(getSep10JwtTtlSeconds()).toBe(900);
    });

    it('honours a valid JWT TTL', () => {
      process.env.SEP10_JWT_TTL_SECONDS = '3600';
      expect(getSep10JwtTtlSeconds()).toBe(3600);
    });

    it('rejects out-of-range JWT TTLs', () => {
      process.env.SEP10_JWT_TTL_SECONDS = '200000';
      expect(getSep10JwtTtlSeconds()).toBe(900);
      process.env.SEP10_JWT_TTL_SECONDS = 'abc';
      expect(getSep10JwtTtlSeconds()).toBe(900);
    });
  });

  describe('getConfiguredWebAuthDomain', () => {
    it('prefers WEB_AUTH_DOMAIN', () => {
      process.env.WEB_AUTH_DOMAIN = 'auth.Hazina.app';
      process.env.PUBLIC_BASE_URL = 'https://public.example.com';
      expect(getConfiguredWebAuthDomain()).toBe('auth.hazina.app');
    });

    it('derives the domain from PUBLIC_BASE_URL', () => {
      delete process.env.WEB_AUTH_DOMAIN;
      process.env.PUBLIC_BASE_URL = 'https://hazina.example.com';
      expect(getConfiguredWebAuthDomain()).toBe('hazina.example.com');
    });

    it('returns null when neither is configured', () => {
      delete process.env.WEB_AUTH_DOMAIN;
      delete process.env.PUBLIC_BASE_URL;
      expect(getConfiguredWebAuthDomain()).toBeNull();
    });
  });

  describe('getWebAuthJwtSecret', () => {
    it('throws when unset', () => {
      delete process.env.WEB_AUTH_JWT_SECRET;
      expect(() => getWebAuthJwtSecret()).toThrow(/WEB_AUTH_JWT_SECRET/);
    });

    it('returns the secret when set', () => {
      process.env.WEB_AUTH_JWT_SECRET = 'my-secret';
      expect(getWebAuthJwtSecret()).toBe('my-secret');
    });
  });
});
