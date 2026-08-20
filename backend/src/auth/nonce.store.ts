/**
 * SEP-10 challenge nonce store.
 *
 * A challenge nonce is single-use. Redemption is an atomic conditional update:
 * `UPDATE ... SET redeemed_at = now WHERE nonce = ? AND redeemed_at IS NULL AND
 * expires_at > now`. On SQLite (better-sqlite3 is synchronous) and PostgreSQL
 * (row-level UPDATE) this cannot be raced, so a replayed signed challenge can
 * never be redeemed twice.
 *
 * The store follows the existing storage layer convention: it uses the sqlite
 * table variant against the shared app db (the `db/client` instance is `any`
 * and the query builder emits plain SQL from the table definition).
 */

import { and, count, eq, gt, isNull, lt } from 'drizzle-orm';
import db from '../db/client';
import { sep10NoncesSqlite } from '../db/schema';

export interface Sep10NonceStore {
  createNonce(input: {
    nonce: string;
    clientAccount: string;
    homeDomain: string;
    expiresAt: number;
    now: number;
  }): Promise<void>;
  /**
   * Atomically mark a nonce as redeemed. Resolves true exactly once per nonce
   * (and only while it is unexpired AND still bound to the issuing client
   * account and home domain); false on replay, expiry, wrong binding, or an
   * unknown nonce. The account/domain binding lives in the same conditional
   * UPDATE as the single-use guard, so there is no check-then-redeem window.
   */
  redeemNonce(
    nonce: string,
    clientAccount: string,
    homeDomain: string,
    now: number,
  ): Promise<boolean>;
  /** True when the nonce exists, is unexpired, unredeemed, and bound to this account/domain. */
  isNonceValid(
    nonce: string,
    clientAccount: string,
    homeDomain: string,
    now: number,
  ): Promise<boolean>;
  sweepExpiredNonces(now: number): Promise<void>;
  countActiveNonces(now: number): Promise<number>;
}

export function createSep10NonceStore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeDb: any,
): Sep10NonceStore {
  const table = sep10NoncesSqlite;

  async function createNonce(input: {
    nonce: string;
    clientAccount: string;
    homeDomain: string;
    expiresAt: number;
    now: number;
  }): Promise<void> {
    const { nonce, clientAccount, homeDomain, expiresAt, now } = input;
    await storeDb.insert(table).values({
      nonce,
      clientAccount,
      homeDomain,
      expiresAt,
      createdAt: now,
    });
  }

  async function redeemNonce(
    nonce: string,
    clientAccount: string,
    homeDomain: string,
    now: number,
  ): Promise<boolean> {
    const rows = await storeDb
      .update(table)
      .set({ redeemedAt: now })
      .where(
        and(
          eq(table.nonce, nonce),
          eq(table.clientAccount, clientAccount),
          eq(table.homeDomain, homeDomain),
          isNull(table.redeemedAt),
          gt(table.expiresAt, now),
        ),
      )
      .returning({ nonce: table.nonce });
    return rows.length === 1;
  }

  async function isNonceValid(
    nonce: string,
    clientAccount: string,
    homeDomain: string,
    now: number,
  ): Promise<boolean> {
    const rows = await storeDb
      .select({ nonce: table.nonce })
      .from(table)
      .where(
        and(
          eq(table.nonce, nonce),
          eq(table.clientAccount, clientAccount),
          eq(table.homeDomain, homeDomain),
          isNull(table.redeemedAt),
          gt(table.expiresAt, now),
        ),
      );
    return rows.length === 1;
  }

  async function sweepExpiredNonces(now: number): Promise<void> {
    await storeDb.delete(table).where(lt(table.expiresAt, now));
  }

  async function countActiveNonces(now: number): Promise<number> {
    const rows = await storeDb
      .select({ total: count() })
      .from(table)
      .where(and(isNull(table.redeemedAt), gt(table.expiresAt, now)));
    return Number(rows[0]?.total ?? 0);
  }

  return { createNonce, redeemNonce, isNonceValid, sweepExpiredNonces, countActiveNonces };
}

/** The application-wide nonce store, bound to the shared db. */
export const sep10NonceStore = createSep10NonceStore(db);
