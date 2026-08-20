import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createSep10NonceStore } from './nonce.store';
import { sep10NoncesSqlite } from '../db/schema';

/**
 * Fresh in-memory database with the real migration chain applied. Using the
 * actual migration SQL (not hand-rolled DDL) proves the checked-in migration
 * for `sep10_nonces` works on a clean database — and that it joins the existing
 * chain without breaking earlier migrations.
 */
function createTestStore() {
  const sqlite = new Database(':memory:');
  const db = drizzleSqlite(sqlite, { schema: { sep10Nonces: sep10NoncesSqlite } });
  migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  return createSep10NonceStore(db);
}

const NONCE = Buffer.alloc(48, 0x42).toString('base64');
const CLIENT = `G${'A'.repeat(55)}`;
const DOMAIN = 'hazina.example.com';
const NOW = 1_700_000_000;

describe('sep10 nonce store', () => {
  it('creates and redeems a nonce exactly once', async () => {
    const store = createTestStore();

    await store.createNonce({
      nonce: NONCE,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 300,
      now: NOW,
    });

    expect(await store.isNonceValid(NONCE, CLIENT, DOMAIN, NOW)).toBe(true);
    expect(await store.redeemNonce(NONCE, CLIENT, DOMAIN, NOW)).toBe(true);

    // Replay — the same nonce can never be redeemed again.
    expect(await store.redeemNonce(NONCE, CLIENT, DOMAIN, NOW + 10)).toBe(false);
    expect(await store.isNonceValid(NONCE, CLIENT, DOMAIN, NOW + 10)).toBe(false);
  });

  it('refuses to redeem a nonce bound to a different account or domain', async () => {
    const store = createTestStore();

    await store.createNonce({
      nonce: NONCE,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 300,
      now: NOW,
    });

    const otherAccount = `G${'B'.repeat(55)}`;
    expect(await store.isNonceValid(NONCE, otherAccount, DOMAIN, NOW)).toBe(false);
    expect(await store.isNonceValid(NONCE, CLIENT, 'other.example.com', NOW)).toBe(false);

    // Redemption is bound too — an attacker presenting another account cannot
    // redeem a challenge issued to the real client.
    expect(await store.redeemNonce(NONCE, otherAccount, DOMAIN, NOW)).toBe(false);
    expect(await store.redeemNonce(NONCE, CLIENT, 'other.example.com', NOW)).toBe(false);

    // The legitimate owner can still redeem.
    expect(await store.redeemNonce(NONCE, CLIENT, DOMAIN, NOW)).toBe(true);
  });

  it('refuses to redeem an expired nonce', async () => {
    const store = createTestStore();

    await store.createNonce({
      nonce: NONCE,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 300,
      now: NOW,
    });

    expect(await store.redeemNonce(NONCE, CLIENT, DOMAIN, NOW + 301)).toBe(false);
    expect(await store.isNonceValid(NONCE, CLIENT, DOMAIN, NOW + 301)).toBe(false);
  });

  it('sweeps only expired nonces', async () => {
    const store = createTestStore();
    const expired = Buffer.alloc(48, 0x01).toString('base64');
    const live = Buffer.alloc(48, 0x02).toString('base64');

    await store.createNonce({
      nonce: expired,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 100,
      now: NOW,
    });
    await store.createNonce({
      nonce: live,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 5000,
      now: NOW,
    });

    await store.sweepExpiredNonces(NOW + 200);

    expect(await store.isNonceValid(live, CLIENT, DOMAIN, NOW + 200)).toBe(true);
    expect(await store.isNonceValid(expired, CLIENT, DOMAIN, NOW + 200)).toBe(false);
  });

  it('counts active (unexpired) nonces', async () => {
    const store = createTestStore();
    const n1 = Buffer.alloc(48, 0x10).toString('base64');
    const n2 = Buffer.alloc(48, 0x11).toString('base64');

    await store.createNonce({
      nonce: n1,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 1000,
      now: NOW,
    });
    await store.createNonce({
      nonce: n2,
      clientAccount: CLIENT,
      homeDomain: DOMAIN,
      expiresAt: NOW + 500,
      now: NOW,
    });

    expect(await store.countActiveNonces(NOW)).toBe(2);
    await store.redeemNonce(n1, CLIENT, DOMAIN, NOW);
    expect(await store.countActiveNonces(NOW)).toBe(1);
  });

  it('reports false for unknown nonces', async () => {
    const store = createTestStore();
    expect(await store.redeemNonce(NONCE, CLIENT, DOMAIN, NOW)).toBe(false);
    expect(await store.isNonceValid(NONCE, CLIENT, DOMAIN, NOW)).toBe(false);
  });
});
