/**
 * config.ts — every constant the devnet depends on, in one place.
 *
 * Nothing here may be read from the ambient environment except the small set of
 * overrides listed under `env()`. A devnet that silently picks up a contributor's
 * personal STELLAR_* variables is exactly the failure mode this whole feature
 * exists to remove, so the defaults are hard-coded and the overrides are explicit.
 */

/**
 * Pinned quickstart image. Never `:latest` — see issue #457 (Backend Dockerfile
 * Uses node:latest Base Image). The digest is the real pin; the tag is kept
 * alongside it so a human reading `docker ps` can tell what is running.
 *
 * v657-b1330.1 ships stellar-core 28.0.1 / protocol 27, which is what public
 * testnet runs as of 2026-08. Bump both fields together, never one alone.
 */
export const QUICKSTART_IMAGE_TAG = 'v657-b1330.1-latest';
export const QUICKSTART_IMAGE_DIGEST =
  'sha256:6c8874f3576031979b0686c28b7abd2399942790ec5fa15a5d53348bc35eb2a9';
export const QUICKSTART_IMAGE = `stellar/quickstart:${QUICKSTART_IMAGE_TAG}@${QUICKSTART_IMAGE_DIGEST}`;

/**
 * The `--local` network passphrase baked into quickstart. This is the ONLY
 * passphrase the devnet tooling will ever write to, enforced by lib/guard.ts.
 */
export const LOCAL_NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';

/** Passphrases we must never touch. Named so the guard error can say which one. */
export const FORBIDDEN_PASSPHRASES: Record<string, string> = {
  'Public Global Stellar Network ; September 2015': 'Stellar mainnet',
  'Test SDF Network ; September 2015': 'Stellar public testnet',
  'Test SDF Future Network ; October 2022': 'Stellar futurenet',
};

/** Hostnames a devnet endpoint is allowed to live on. */
export const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
  'stellar-devnet', // the compose service name, for container-to-container use
]);

/** Compose project + service names, referenced by provision/status/reset. */
export const COMPOSE_FILE = 'docker-compose.devnet.yml';
export const COMPOSE_PROJECT = 'hazina-devnet';
export const COMPOSE_SERVICE = 'stellar-devnet';

/** Single nginx front door: Horizon, RPC and friendbot are all behind this port. */
export const DEFAULT_PORT = 8000;

export interface DevnetEndpoints {
  horizon: string;
  rpc: string;
  friendbot: string;
}

export function endpoints(port: number = DEFAULT_PORT, host = 'localhost'): DevnetEndpoints {
  const base = `http://${host}:${port}`;
  return { horizon: base, rpc: `${base}/rpc`, friendbot: `${base}/friendbot` };
}

// ── Asset ────────────────────────────────────────────────────────────────────

/** Devnet USDC. Same 4-char code and 7 decimals as the real thing. */
export const USDC_CODE = 'USDC';
export const TOKEN_DECIMALS = 7;
export const STROOPS_PER_UNIT = 10 ** TOKEN_DECIMALS;

/** XLM handed to each account by friendbot (quickstart's fixed starting balance). */
export const FRIENDBOT_STARTING_BALANCE = 10_000;

/** USDC minted to the issuer's counterparties during provisioning, in whole units. */
export const USDC_DISTRIBUTION: Record<string, number> = {
  buyer: 10_000,
  seller: 0,
  treasury: 0,
  arbitrator: 0,
};

/** Trustline limit, in whole units. Generous so no test ever hits it. */
export const TRUSTLINE_LIMIT = 1_000_000;

// ── Contract ─────────────────────────────────────────────────────────────────

/** Platform fee in basis points. 500 bps = 5%, giving the 95/5 split. */
export const PLATFORM_FEE_BPS = 500;

/**
 * Fixed salt for `create_contract`. Combined with the fixed admin address and
 * the fixed network passphrase this makes the deployed contract id byte-identical
 * on every reset — see lib/accounts.ts#precomputeContractId.
 */
export const CONTRACT_SALT_SEED = 'hazina-devnet:v1:escrow-salt';

/** Where `cargo build --target wasm32v1-none --release` drops the artifact. */
export const WASM_RELATIVE_PATH =
  'contracts/hazina-escrow/target/wasm32v1-none/release/hazina_escrow.wasm';

// ── Output artifacts ─────────────────────────────────────────────────────────

export const ENV_OUTPUT_FILE = '.env.devnet';
export const ACCOUNTS_OUTPUT_FILE = 'devnet.accounts.json';
export const MARKETPLACE_SEED_FILE = 'data/devnet.datasets.json';

// ── Timing ───────────────────────────────────────────────────────────────────

/**
 * Health-wait budget. The container needs to boot core, upgrade the network to
 * the target protocol, ingest into Horizon, and only THEN start friendbot — so
 * the friendbot budget is deliberately the most generous of the three.
 */
export const HEALTH_TIMEOUTS_MS = {
  horizon: 180_000,
  rpc: 180_000,
  friendbot: 180_000,
  transaction: 90_000,
};

/** Exponential backoff bounds shared by every waiter. */
export const BACKOFF = { initialMs: 200, maxMs: 2_000, factor: 1.6 };

/** Soroban tx fee, in stroops. Generous: devnet XLM is free and fee-bumps are noise. */
export const SOROBAN_FEE = '10000000';

/** Classic op fee, in stroops. */
export const CLASSIC_FEE = '1000000';

// ── Environment overrides ────────────────────────────────────────────────────

export interface DevnetEnvOverrides {
  port: number;
  host: string;
  skipBuild: boolean;
}

/**
 * The complete set of environment variables the devnet honours. Anything else in
 * the caller's environment is ignored on purpose.
 */
export function env(source: NodeJS.ProcessEnv = process.env): DevnetEnvOverrides {
  const rawPort = source.DEVNET_PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`DEVNET_PORT must be a port number, got "${rawPort}"`);
  }
  return {
    port,
    host: source.DEVNET_HOST ?? 'localhost',
    skipBuild: source.DEVNET_SKIP_BUILD === 'true',
  };
}
