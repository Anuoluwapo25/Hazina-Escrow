/**
 * useStellarAuth.ts — React binding for the SEP-10 seller session.
 *
 * Re-renders when the in-memory session changes and exposes signIn/signOut
 * that drive the /api/v1/auth challenge flow via the connected wallet.
 */

import { useCallback, useEffect, useState } from 'react';
import { completeSellerSignIn } from '../lib/sep10';
import {
  clearSellerSession,
  getSellerSession,
  isSellerAuthenticated,
  subscribeSellerAuth,
  type SellerSession,
} from '../lib/sellerAuth';

export interface UseStellarAuthResult {
  session: SellerSession | null;
  /** True when a valid (unexpired) seller session is stored in memory. */
  isAuthenticated: boolean;
  /** Runs the SEP-10 flow for a connected wallet address. Throws on failure. */
  signIn: (account: string) => Promise<SellerSession | null>;
  /** Clears the in-memory session (wallet connection is left intact). */
  signOut: () => void;
}

export function useStellarAuth(): UseStellarAuthResult {
  const [session, setSession] = useState<SellerSession | null>(() => getSellerSession());

  useEffect(() => subscribeSellerAuth(() => setSession(getSellerSession())), []);

  const signIn = useCallback(async (account: string) => {
    await completeSellerSignIn(account);
    return getSellerSession();
  }, []);

  const signOut = useCallback(() => {
    clearSellerSession();
  }, []);

  return {
    session,
    isAuthenticated: isSellerAuthenticated(),
    signIn,
    signOut,
  };
}
