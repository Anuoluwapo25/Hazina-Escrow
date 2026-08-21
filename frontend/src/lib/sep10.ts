/**
 * sep10.ts — SEP-10 "Sign in with Stellar" client for the browser.
 *
 * Runs the three-step flow against the backend's /api/v1/auth endpoints:
 *
 *   1. GET  /auth?account=<wallet>&home_domain=<domain>  → challenge transaction
 *   2. Sign the challenge with the connected wallet (Freighter).
 *   3. POST /auth { transaction, home_domain }           → seller JWT
 *
 * The browser build deliberately avoids the @stellar/stellar-sdk dependency:
 * the challenge is signed by the wallet extension, and verification happens
 * server-side. The home domain we submit is the one the backend will accept —
 * its configured WEB_AUTH_DOMAIN or the host the request came from.
 */

import { getEnv } from './env';
import { signWithFreighter } from './stellarWallets';
import { setSellerSession, decodeTokenExpiry } from './sellerAuth';

export interface Sep10Challenge {
  transaction: string;
  network_passphrase: string;
  expires_at: number;
  home_domain: string;
}

export interface Sep10SignInResult {
  token: string;
  sellerWallet: string;
  homeDomain: string;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { apiUrl } = getEnv();
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Sign-in failed (HTTP ${response.status})`);
  }
  return response;
}

/** Requests a challenge for `account` from the server. */
export async function requestChallenge(
  account: string,
  homeDomain?: string,
): Promise<Sep10Challenge> {
  const params = new URLSearchParams({ account });
  if (homeDomain) params.set('home_domain', homeDomain);
  const response = await apiFetch(`/auth?${params.toString()}`);
  return (await response.json()) as Sep10Challenge;
}

/** Signs a challenge XDR with the connected Freighter wallet. */
export async function signChallenge(xdr: string): Promise<string> {
  return signWithFreighter(xdr);
}

/** Submits the signed challenge and receives the seller JWT. */
export async function submitSignedChallenge(
  signedTransaction: string,
  homeDomain: string,
): Promise<Sep10SignInResult> {
  const response = await apiFetch('/auth', {
    method: 'POST',
    body: JSON.stringify({ transaction: signedTransaction, home_domain: homeDomain }),
  });
  const body = (await response.json()) as {
    token: string;
    seller_wallet: string;
    account: string;
  };
  return {
    token: body.token,
    sellerWallet: body.seller_wallet ?? body.account,
    homeDomain,
  };
}

/**
 * Runs the full sign-in flow for a connected wallet address and stores the
 * session in memory. Throws on any failure (no session is stored).
 */
export async function completeSellerSignIn(account: string): Promise<Sep10SignInResult> {
  const homeDomain =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : undefined;

  const challenge = await requestChallenge(account, homeDomain);
  const signed = await signChallenge(challenge.transaction);
  const result = await submitSignedChallenge(signed, challenge.home_domain);

  const expiresAtSec = decodeTokenExpiry(result.token);
  if (expiresAtSec === null) {
    throw new Error('Sign-in failed: the server returned an invalid token');
  }

  setSellerSession({
    token: result.token,
    sellerWallet: result.sellerWallet,
    expiresAtSec,
  });
  return result;
}
