/**
 * Environment variable validation and central access.
 *
 * Call initEnv() once at the very top of app startup (main.tsx) so missing or
 * invalid env vars fail loudly instead of causing cryptic runtime errors.
 */

export interface EnvConfig {
  /** Base URL of the backend API (e.g. http://localhost:3001) */
  apiUrl: string;
  enableDemoMode: boolean;
  /**
   * Legacy shared API key for backend auth. Optional since SEP-10 (Sign in
   * with Stellar) replaced it: sellers authenticate with a wallet-signed
   * challenge and receive a short-lived JWT instead.
   */
  apiKey: string;
  /** Max parallel in-flight API requests (default 8) */
  maxConcurrentRequests: number;
  /** USDC issuer override */
  usdcIssuer: string;
  /** Stellar network: 'testnet' or 'public' */
  stellarNetwork: string;
  /** Soroban RPC endpoint used by the passkey smart-wallet client */
  sorobanRpcUrl: string;
  /** Hex WASM hash of the deployed smart-wallet contract (empty = passkey checkout hidden) */
  passkeyWalletWasmHash: string;
}

const REQUIRED_ENV_VARS = ['VITE_API_URL'] as const;

function readEnableDemoMode() {
  return (
    String(import.meta.env.VITE_ENABLE_DEMO_MODE ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

/**
 * Validate required environment variables and return a typed config object.
 * Throws a descriptive error when a required variable is missing or empty.
 */
export function validateEnv(): EnvConfig {
  const missing: string[] = [];

  // Try import.meta.env first (Vite), fall back to process.env (Node/test environment)
  const envVars = (import.meta.env as Record<string, string | undefined>) || process.env;

  for (const key of REQUIRED_ENV_VARS) {
    const value = envVars[key];
    if (!value || String(value).trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const list = missing.map(k => `  • ${k}`).join('\n');
    throw new Error(
      `[Hazina] Missing required environment variable(s):\n${list}\n\n` +
        'Copy .env.example to .env and fill in the missing values before starting the app.',
    );
  }

  return {
    apiUrl: String(import.meta.env.VITE_API_URL)
      .trim()
      .replace(/\/+$/, ''),
    enableDemoMode: readEnableDemoMode(),
    apiKey: String(import.meta.env.VITE_API_KEY ?? '').trim(),
    maxConcurrentRequests:
      parseInt(String(import.meta.env.VITE_MAX_CONCURRENT_REQUESTS ?? '8'), 10) || 8,
    usdcIssuer: String(import.meta.env.VITE_USDC_ISSUER ?? '').trim(),
    stellarNetwork: String(import.meta.env.VITE_STELLAR_NETWORK ?? 'testnet').trim(),
    sorobanRpcUrl:
      String(import.meta.env.VITE_SOROBAN_RPC_URL ?? '').trim() ||
      (String(import.meta.env.VITE_STELLAR_NETWORK ?? 'testnet').trim() === 'public'
        ? 'https://soroban.stellar.org'
        : 'https://soroban-testnet.stellar.org'),
    passkeyWalletWasmHash: String(import.meta.env.VITE_PASSKEY_WALLET_WASM_HASH ?? '').trim(),
  };
}

/**
 * Validated env config — available after validateEnv() succeeds.
 * Import this anywhere you need typed access to env values.
 */
let _env: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (!_env) {
    throw new Error(
      '[Hazina] getEnv() called before validateEnv(). ' +
        'Make sure validateEnv() is called in main.tsx before rendering the app.',
    );
  }
  return _env;
}

export function initEnv(): EnvConfig {
  _env = validateEnv();
  return _env;
}

export function isDemoModeEnabled() {
  return readEnableDemoMode();
}
