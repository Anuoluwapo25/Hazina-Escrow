/**
 * useAccessPass.ts — buyer-side subscription status for one dataset.
 *
 * Fail-closed by construction: while the query is loading or has errored,
 * `state` is 'loading' / 'unavailable' and callers must treat access as DENIED.
 * Only `state === 'active'` (or 'expired', which the contract itself enforces
 * anyway) lets the UI show pass details.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Same localStorage key the Navbar writes on wallet connect. */
const WALLET_STORAGE_KEY = 'hazina_wallet';

export function getConnectedWallet(): string | null {
  try {
    return localStorage.getItem(WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

export type AccessPassStatus =
  | 'no-wallet' // no wallet connected yet — nothing to verify
  | 'loading' // check in flight → deny until proven otherwise
  | 'unavailable' // verification failed → deny + surface a neutral state
  | 'active' // non-revoked, unexpired pass held
  | 'expired' // pass exists but its term ended
  | 'none'; // buyer never held a pass for this dataset

export interface UseAccessPassResult {
  status: AccessPassStatus;
  /** Pass record when present (including expired ones), else null. */
  pass: {
    planId: number;
    expiry: number;
    start: number;
    amountPaid: number;
    revoked: boolean;
  } | null;
  /** True only when an unexpired, non-revoked pass is verified on-chain. */
  hasAccess: boolean;
}

export function useAccessPass(datasetId: string | undefined): UseAccessPassResult {
  const buyer = getConnectedWallet();

  const query = useQuery({
    queryKey: ['access-pass', buyer, datasetId],
    queryFn: () => api.getAccessPass(datasetId as string, buyer as string),
    enabled: Boolean(datasetId && buyer),
    // Mirrors the backend's 15s read cache; refresh quietly every minute.
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  if (!buyer) return { status: 'no-wallet', pass: null, hasAccess: false };
  if (!datasetId) return { status: 'no-wallet', pass: null, hasAccess: false };

  if (query.isPending) return { status: 'loading', pass: null, hasAccess: false };
  if (query.isError || !query.data) {
    return { status: 'unavailable', pass: null, hasAccess: false };
  }

  const { hasAccess, pass } = query.data;
  return {
    status: hasAccess ? 'active' : pass !== null ? 'expired' : 'none',
    pass,
    hasAccess,
  };
}
