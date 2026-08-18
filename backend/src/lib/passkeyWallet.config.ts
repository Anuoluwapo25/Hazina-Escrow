/**
 * passkeyWallet.config.ts — env access for the passkey smart-wallet checkout
 * flow (#587). Launchtube sponsors the buyer's deploy and submission fees so
 * a brand-new buyer never needs testnet XLM.
 *
 * LAUNCHTUBE_JWT must never reach the browser bundle — every read of it is
 * confined to this module and to launchtube.client.ts, both server-only.
 */

const DEFAULT_LAUNCHTUBE_TESTNET_URL = 'https://testnet.launchtube.xyz';

/** True when a Launchtube token is configured (passkey checkout available). */
export function isPasskeyWalletConfigured(): boolean {
  return (process.env.LAUNCHTUBE_JWT ?? '').trim().length > 0;
}

export function getLaunchtubeUrl(): string {
  return (process.env.LAUNCHTUBE_URL ?? DEFAULT_LAUNCHTUBE_TESTNET_URL).trim().replace(/\/+$/, '');
}

/** Returns the configured Launchtube token or throws. Call at the relay call site. */
export function getLaunchtubeJwt(): string {
  const jwt = (process.env.LAUNCHTUBE_JWT ?? '').trim();
  if (!jwt) {
    throw new Error(
      'LAUNCHTUBE_JWT is not configured — passkey wallet checkout requires a Launchtube token. ' +
        'Generate a testnet token at https://testnet.launchtube.xyz/gen.',
    );
  }
  return jwt;
}

/** Hex WASM hash of the deployed smart-wallet contract, used by the frontend's PasskeyKit instance. */
export function getPasskeyWalletWasmHash(): string {
  return (process.env.PASSKEY_WALLET_WASM_HASH ?? '').trim();
}
