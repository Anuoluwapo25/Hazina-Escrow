import { StrKey } from '@stellar/stellar-sdk';

const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';

export const STELLAR_NETWORK = NETWORK as 'testnet' | 'mainnet';

export const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ??
  (STELLAR_NETWORK === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

export const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ??
  (STELLAR_NETWORK === 'mainnet'
    ? 'https://soroban.stellar.org'
    : 'https://soroban-testnet.stellar.org');

// ── Escrow contract ───────────────────────────────────────────────────────

// Read escrow-related env per-call (not at module load) so tests and runtime
// config changes take effect without re-importing the module — matching the
// pattern used elsewhere (e.g. STELLAR_TIMEOUT_MS in stellar.service.ts).

/** Default testnet Soroban Asset Contract (SAC) addresses. */
const DEFAULT_USDC_SAC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
const DEFAULT_XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** True when a real escrow contract is configured (non-custodial flow available). */
export function isEscrowContractConfigured(): boolean {
  return (process.env.ESCROW_CONTRACT_ID ?? '').trim().length > 0;
}

/**
 * Returns the configured escrow contract ID or throws. Use at the call site so
 * the failure names the missing env var instead of surfacing a cryptic RPC error.
 */
export function getEscrowContractId(): string {
  const id = (process.env.ESCROW_CONTRACT_ID ?? '').trim();
  if (!id) {
    throw new Error(
      'ESCROW_CONTRACT_ID is not configured — the non-custodial escrow flow ' +
        'requires the deployed contract address. Set ESCROW_CONTRACT_ID or use demo mode.',
    );
  }
  return id;
}

/**
 * Call once at application startup, alongside validateAgentWallet(). Escrow
 * mode is opt-in (ESCROW_CONTRACT_ID unset → legacy custodial demo path), but
 * once an operator sets it, a malformed contract address must fail fast here
 * rather than surface as a cryptic RPC error on the first buyer's request.
 */
export function validateEscrowConfig(): void {
  const id = (process.env.ESCROW_CONTRACT_ID ?? '').trim();
  if (!id) {
    return;
  }
  if (!StrKey.isValidContract(id)) {
    throw new Error(
      `[EscrowConfig] ESCROW_CONTRACT_ID "${id}" is not a valid Soroban contract address ` +
        '(expected a C… strkey). Check the value in your environment configuration.',
    );
  }
}

// ── Multi-token support ──────────────────────────────────────────────────────

export interface StellarToken {
  code: 'USDC' | 'EURC' | 'XLM';
  issuer?: string; // undefined for XLM (native)
  address?: string; // Soroban token contract (SAC) address — required for on-chain escrow
}

/**
 * Resolve the Soroban token contract (SAC) address for a token code, or null
 * when none is configured (the token cannot be used with on-chain escrow).
 * The escrow contract's `lock(token: Address, …)` needs the token *contract*
 * address, not the classic issuer account.
 */
export function getTokenSacAddress(code: string): string | null {
  switch (code) {
    case 'USDC':
      return (process.env.USDC_SAC_ADDRESS ?? DEFAULT_USDC_SAC) || null;
    case 'EURC':
      return (process.env.EURC_SAC_ADDRESS ?? '') || null;
    case 'XLM':
      return (process.env.XLM_SAC_ADDRESS ?? DEFAULT_XLM_SAC) || null;
    default:
      return null;
  }
}

export const USDC_ISSUER =
  process.env.USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // default testnet issuer

export const EURC_ISSUER =
  process.env.EURC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'; // testnet: same publisher as USDC

export const SUPPORTED_TOKENS: Record<string, StellarToken> = {
  USDC: {
    code: 'USDC',
    issuer: USDC_ISSUER,
  },
  EURC: {
    code: 'EURC',
    issuer: EURC_ISSUER,
  },
  XLM: {
    code: 'XLM',
    // native, no issuer
  },
};

export const DEFAULT_TOKEN_CODE = 'USDC';

export function getTokenByCode(code: string): StellarToken | null {
  return SUPPORTED_TOKENS[code] || null;
}

export const getNetworkPassphrase = () => {
  if (STELLAR_NETWORK === 'mainnet') {
    return 'Public Global Stellar Network ; September 2015';
  }
  return 'Test SDF Network ; September 2015';
};
