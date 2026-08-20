/**
 * sellerAuth.ts — in-memory SEP-10 seller session.
 *
 * After a successful wallet sign-in the backend returns a short-lived HS256
 * JWT whose `sellerWallet` claim is the owning G… address. It is held in
 * memory only (never localStorage) and attached as the Bearer token for
 * seller-scoped API calls. Components subscribe via `subscribe` to re-render
 * when the session changes.
 */

export interface SellerSession {
  token: string;
  /** The G… address that owns seller resources (muxed M… normalized server-side). */
  sellerWallet: string;
  /** Unix seconds at which the token expires. */
  expiresAtSec: number;
}

let session: SellerSession | null = null;
const listeners = new Set<() => void>();

export function setSellerSession(next: SellerSession | null): void {
  session = next;
  for (const listener of listeners) listener();
}

export function getSellerSession(): SellerSession | null {
  return session;
}

export function getSellerToken(): string | null {
  return session?.token ?? null;
}

export function getSellerWallet(): string | null {
  return session?.sellerWallet ?? null;
}

export function isSellerAuthenticated(): boolean {
  return session !== null && session.expiresAtSec > Math.floor(Date.now() / 1000);
}

export function clearSellerSession(): void {
  setSellerSession(null);
}

export function subscribeSellerAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Decodes the exp claim without verifying the signature (for expiry UI). */
export function decodeTokenExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const raw = parts[1] ?? '';
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}
