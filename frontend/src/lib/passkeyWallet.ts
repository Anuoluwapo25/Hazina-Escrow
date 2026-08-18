/**
 * passkeyWallet.ts — WebAuthn / secp256r1 smart-wallet wrapper for the
 * "Pay with passkey" checkout flow (#587).
 *
 * Wraps passkey-kit's `PasskeyKit`: WebAuthn/platform-authenticator feature
 * detection, wallet creation, one-tap reconnect, and recovery, plus
 * credentialId → contract-address persistence so a returning buyer never
 * re-registers their passkey. Deploy carriers are relayed through the
 * backend's `/wallet/passkey/deploy` endpoint, which forwards them to
 * Launchtube — the buyer never needs testnet XLM and the browser never talks
 * to Launchtube (or its JWT) directly.
 *
 * Signing and submitting an actual dataset payment through a connected
 * passkey wallet (`/wallet/passkey/submit`) is intentionally out of scope
 * here — see docs/PASSKEY_WALLETS.md for why and what ships next.
 */
import { PasskeyKit } from 'passkey-kit';
import { getEnv } from './env';
import { networkPassphrase } from './stellarWallets';

const STORAGE_KEY = 'hazina:passkeyWallet';
const APP_NAME = 'Hazina';

export interface StoredPasskeyWallet {
  keyId: string;
  contractId: string;
}

export type PasskeyWalletResult = StoredPasskeyWallet;

let kitInstance: PasskeyKit | null = null;

function getKit(): PasskeyKit {
  if (kitInstance) return kitInstance;
  const { sorobanRpcUrl, passkeyWalletWasmHash } = getEnv();
  if (!passkeyWalletWasmHash) {
    throw new Error('Passkey checkout is not configured (VITE_PASSKEY_WALLET_WASM_HASH is unset).');
  }
  kitInstance = new PasskeyKit({
    rpcUrl: sorobanRpcUrl,
    networkPassphrase: networkPassphrase(),
    walletWasmHash: passkeyWalletWasmHash,
  });
  return kitInstance;
}

/**
 * True when this browser can run a platform passkey ceremony (Face ID, Touch
 * ID, Windows Hello, or a security key). Callers should hide passkey checkout
 * entirely when this resolves false rather than show a button that will fail.
 */
export async function isPasskeySupported(): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    typeof window.PublicKeyCredential === 'undefined' ||
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
  ) {
    return false;
  }
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function getStoredPasskeyWallet(): StoredPasskeyWallet | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPasskeyWallet>;
    if (typeof parsed.keyId === 'string' && typeof parsed.contractId === 'string') {
      return { keyId: parsed.keyId, contractId: parsed.contractId };
    }
    return null;
  } catch {
    return null;
  }
}

function savePasskeyWallet(wallet: StoredPasskeyWallet): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
}

export function clearStoredPasskeyWallet(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

async function relayToBackend(path: string, xdr: string): Promise<void> {
  const { apiUrl, apiKey } = getEnv();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ xdr }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Passkey wallet request to ${path} failed`);
  }
}

/**
 * Register a brand-new passkey and deploy its smart wallet, sponsored via
 * Launchtube so the buyer never needs testnet XLM. Persists the
 * credentialId → contract-address mapping for one-tap reconnect.
 */
export async function createPasskeyWallet(userName: string): Promise<PasskeyWalletResult> {
  const kit = getKit();
  const { keyIdBase64, contractId, signedTx } = await kit.createWallet(APP_NAME, userName);
  await relayToBackend('/wallet/passkey/deploy', signedTx);
  const wallet: StoredPasskeyWallet = { keyId: keyIdBase64, contractId };
  savePasskeyWallet(wallet);
  return wallet;
}

/**
 * Reconnect a returning buyer's wallet in one tap using the stored
 * credentialId, or — when nothing is stored locally (a new device, cleared
 * storage) — run the full WebAuthn discovery ceremony to recover the wallet
 * from the passkey itself.
 */
export async function connectPasskeyWallet(): Promise<PasskeyWalletResult> {
  const kit = getKit();
  const stored = getStoredPasskeyWallet();
  const { keyIdBase64, contractId } = await kit.connectWallet(
    stored ? { keyId: stored.keyId } : undefined,
  );
  const wallet: StoredPasskeyWallet = { keyId: keyIdBase64, contractId };
  savePasskeyWallet(wallet);
  return wallet;
}

/** Create a wallet if none is stored yet, otherwise reconnect the existing one. */
export async function createOrConnectPasskeyWallet(userName: string): Promise<PasskeyWalletResult> {
  return getStoredPasskeyWallet() ? connectPasskeyWallet() : createPasskeyWallet(userName);
}
