import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setSellerSession,
  getSellerSession,
  getSellerToken,
  getSellerWallet,
  isSellerAuthenticated,
  clearSellerSession,
  subscribeSellerAuth,
  decodeTokenExpiry,
} from './sellerAuth';

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeToken(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const payload = btoa(JSON.stringify({ exp, sellerWallet: WALLET }))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.signature`;
}

describe('sellerAuth session store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T00:00:00Z'));
    clearSellerSession();
  });

  afterEach(() => {
    clearSellerSession();
    vi.useRealTimers();
  });

  it('stores and retrieves the session in memory', () => {
    expect(getSellerSession()).toBeNull();
    setSellerSession({ token: 't', sellerWallet: WALLET, expiresAtSec: 123 });
    expect(getSellerSession()).toEqual({ token: 't', sellerWallet: WALLET, expiresAtSec: 123 });
    expect(getSellerToken()).toBe('t');
    expect(getSellerWallet()).toBe(WALLET);
  });

  it('reports authentication status from the token expiry', () => {
    const now = Math.floor(Date.now() / 1000);
    setSellerSession({ token: 't', sellerWallet: WALLET, expiresAtSec: now + 60 });
    expect(isSellerAuthenticated()).toBe(true);

    setSellerSession({ token: 't', sellerWallet: WALLET, expiresAtSec: now - 1 });
    expect(isSellerAuthenticated()).toBe(false);
  });

  it('clears the session', () => {
    setSellerSession({ token: 't', sellerWallet: WALLET, expiresAtSec: 123 });
    clearSellerSession();
    expect(getSellerSession()).toBeNull();
    expect(getSellerToken()).toBeNull();
    expect(isSellerAuthenticated()).toBe(false);
  });

  it('notifies subscribers when the session changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSellerAuth(listener);

    setSellerSession({ token: 't', sellerWallet: WALLET, expiresAtSec: 123 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setSellerSession(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('decodes the exp claim without verifying the signature', () => {
    const exp = 1777500000;
    expect(decodeTokenExpiry(makeToken(exp))).toBe(exp);
  });

  it('returns null for malformed tokens', () => {
    expect(decodeTokenExpiry('not-a-jwt')).toBeNull();
    expect(decodeTokenExpiry('a.b')).toBeNull();
    expect(decodeTokenExpiry('a.b.c')).toBeNull();
  });
});
