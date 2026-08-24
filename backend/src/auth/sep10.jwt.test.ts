import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { decodeSep10JwtPayload, mintSep10Jwt, verifySep10Jwt } from './sep10.jwt';

const SECRET = 'web-auth-jwt-secret';
const CLIENT = `G${'A'.repeat(55)}`;
const DOMAIN = 'hazina.example.com';
const NOW = 1_700_000_000;

function makeToken(overrides: Partial<Record<string, unknown>> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: CLIENT,
      iss: DOMAIN,
      sellerWallet: CLIENT,
      jti: 'nonce-1',
      iat: NOW,
      exp: NOW + 900,
      ...overrides,
    }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

describe('sep10.jwt', () => {
  it('mints and verifies a token round trip', () => {
    const token = mintSep10Jwt(
      {
        sub: CLIENT,
        iss: DOMAIN,
        sellerWallet: CLIENT,
        jti: 'nonce-1',
        ttlSeconds: 900,
        nowSec: NOW,
      },
      SECRET,
    );
    const claims = verifySep10Jwt(token, SECRET, { nowSec: NOW + 100, expectedIssuer: DOMAIN });
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(CLIENT);
    expect(claims?.iss).toBe(DOMAIN);
    expect(claims?.sellerWallet).toBe(CLIENT);
    expect(claims?.jti).toBe('nonce-1');
    expect(claims?.exp).toBe(NOW + 900);
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintSep10Jwt(
      { sub: CLIENT, iss: DOMAIN, sellerWallet: CLIENT, jti: 'n', ttlSeconds: 900, nowSec: NOW },
      SECRET,
    );
    expect(verifySep10Jwt(token, 'wrong-secret', { nowSec: NOW + 1 })).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = mintSep10Jwt(
      { sub: CLIENT, iss: DOMAIN, sellerWallet: CLIENT, jti: 'n', ttlSeconds: 900, nowSec: NOW },
      SECRET,
    );
    expect(verifySep10Jwt(token, SECRET, { nowSec: NOW + 901 })).toBeNull();
    expect(verifySep10Jwt(token, SECRET, { nowSec: NOW + 900 })).toBeNull();
  });

  it('rejects a token whose issuer does not match', () => {
    const token = mintSep10Jwt(
      {
        sub: CLIENT,
        iss: 'other.example.com',
        sellerWallet: CLIENT,
        jti: 'n',
        ttlSeconds: 900,
        nowSec: NOW,
      },
      SECRET,
    );
    expect(verifySep10Jwt(token, SECRET, { nowSec: NOW + 1, expectedIssuer: DOMAIN })).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = mintSep10Jwt(
      { sub: CLIENT, iss: DOMAIN, sellerWallet: CLIENT, jti: 'n', ttlSeconds: 900, nowSec: NOW },
      SECRET,
    );
    const [header, payload] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: `G${'B'.repeat(55)}`, iss: DOMAIN, sellerWallet: CLIENT }),
    ).toString('base64url');
    const forged = `${header}.${tamperedPayload}.${payload}`;
    expect(verifySep10Jwt(forged, SECRET, { nowSec: NOW + 1 })).toBeNull();
  });

  it('rejects a token with a non-HS256 algorithm header', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: CLIENT,
        iss: DOMAIN,
        sellerWallet: CLIENT,
        jti: 'n',
        iat: NOW,
        exp: NOW + 900,
      }),
    ).toString('base64url');
    expect(verifySep10Jwt(`${header}.${payload}.`, SECRET, { nowSec: NOW + 1 })).toBeNull();
  });

  it('rejects a token with a malformed sellerWallet', () => {
    const token = makeToken({ sellerWallet: 'not-a-stellar-address' });
    expect(verifySep10Jwt(token, SECRET, { nowSec: NOW + 1 })).toBeNull();
  });

  it('rejects garbage and non-JWT tokens', () => {
    expect(verifySep10Jwt('garbage', SECRET, { nowSec: NOW })).toBeNull();
    expect(verifySep10Jwt('a.b', SECRET, { nowSec: NOW })).toBeNull();
  });

  it('decodeSep10JwtPayload reads claims without verifying', () => {
    const token = mintSep10Jwt(
      {
        sub: CLIENT,
        iss: DOMAIN,
        sellerWallet: CLIENT,
        jti: 'nonce-1',
        ttlSeconds: 900,
        nowSec: NOW,
      },
      SECRET,
    );
    const claims = decodeSep10JwtPayload(token);
    expect(claims?.exp).toBe(NOW + 900);
    expect(claims?.sub).toBe(CLIENT);
  });

  it('decodeSep10JwtPayload rejects malformed tokens', () => {
    expect(decodeSep10JwtPayload('')).toBeNull();
    expect(decodeSep10JwtPayload('a.b.c')).toBeNull();
  });
});
