/**
 * provision.ts — `npm run devnet`.
 *
 * Boots the ephemeral network (unless one is already up), waits for it properly,
 * then provisions it into a state where a real purchase can be executed:
 *
 *   1. guard      — refuse anything that is not a local network
 *   2. compose up — start the pinned quickstart container
 *   3. health     — Horizon ingesting, RPC healthy, friendbot actually serving
 *   4. accounts   — deterministic keys, funded via friendbot
 *   5. asset      — issue devnet USDC, establish trustlines, distribute
 *   6. SAC        — wrap USDC (and XLM) as Soroban token contracts
 *   7. contract   — build wasm, upload, deploy at a fixed salt, initialize
 *   8. config     — set_treasury, set_arbitrator
 *   9. seed       — deterministic marketplace datasets
 *  10. artifacts  — .env.devnet, devnet.accounts.json, summary
 *
 * Every step is idempotent. Re-running against a live devnet re-checks state and
 * skips work that is already done, so `npm run devnet` is safe to run twice and
 * safe to run after a partial failure.
 */

import { execFile } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Address, Asset, Contract, Keypair, Operation, xdr } from '@stellar/stellar-sdk';
import {
  ACCOUNTS_OUTPUT_FILE,
  ENV_OUTPUT_FILE,
  HEALTH_TIMEOUTS_MS,
  LOCAL_NETWORK_PASSPHRASE,
  MARKETPLACE_SEED_FILE,
  PLATFORM_FEE_BPS,
  TRUSTLINE_LIMIT,
  USDC_CODE,
  USDC_DISTRIBUTION,
  WASM_RELATIVE_PATH,
  endpoints,
  env as readEnv,
} from './lib/config.ts';
import { assertDevnetTarget, assertReportedPassphraseMatches } from './lib/guard.ts';
import {
  accountMap,
  precomputeContractId,
  contractSalt,
  type DevnetAccount,
  type DevnetRole,
} from './lib/accounts.ts';
import {
  fetchRpcPassphrase,
  probeFriendbot,
  probeHorizon,
  probeRpc,
  waitFor,
} from './lib/health.ts';
import {
  type ChainContext,
  CONTRACT_ERROR,
  ChainError,
  classicBalance,
  contractErrorCode,
  fundAccount,
  hasTrustline,
  rpcClient,
  simulateCall,
  submitClassic,
  submitSoroban,
} from './lib/chain.ts';
import { writeArtifacts, type ProvisionResult } from './lib/artifacts.ts';
import { writeMarketplaceSeed } from './lib/marketplace.ts';
import { renderSummary } from './lib/summary.ts';
import { composeUp, isDevnetRunning } from './lib/compose.ts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let stepNumber = 0;
function step(message: string): void {
  stepNumber += 1;
  process.stdout.write(`\n[${stepNumber}/10] ${message}\n`);
}
function info(message: string): void {
  process.stdout.write(`      ${message}\n`);
}

// ── 3. Health ────────────────────────────────────────────────────────────────

async function waitForNetwork(ctx: ChainContext): Promise<void> {
  const horizon = await waitFor(() => probeHorizon(ctx.horizonUrl), {
    label: 'Horizon',
    timeoutMs: HEALTH_TIMEOUTS_MS.horizon,
    onAttempt: (attempt, elapsed) => {
      if (attempt > 0 && attempt % 5 === 0) {
        info(`still waiting for Horizon… ${Math.round(elapsed / 1000)}s`);
      }
    },
  });
  info(`Horizon ingesting at ledger ${horizon.latestLedger}`);

  // The network could be anything until we have seen its passphrase. Check the
  // moment Horizon can tell us, and again below via RPC.
  assertReportedPassphraseMatches(horizon.passphrase, ctx.passphrase);

  const rpcHealth = await waitFor(() => probeRpc(ctx.rpcUrl), {
    label: 'Soroban RPC',
    timeoutMs: HEALTH_TIMEOUTS_MS.rpc,
    onAttempt: (attempt, elapsed) => {
      if (attempt > 0 && attempt % 5 === 0) {
        info(`still waiting for Soroban RPC… ${Math.round(elapsed / 1000)}s`);
      }
    },
  });
  info(`Soroban RPC healthy at ledger ${rpcHealth.latestLedger}`);
  assertReportedPassphraseMatches(await fetchRpcPassphrase(ctx.rpcUrl), ctx.passphrase);

  // Friendbot starts only after core finishes its protocol upgrade — measurably
  // later than Horizon. Waiting on it here is what stops the first fundAccount
  // call from dying on a 502.
  const probeAddress = Keypair.random().publicKey();
  await waitFor(() => probeFriendbot(ctx.friendbotUrl, probeAddress), {
    label: 'Friendbot',
    timeoutMs: HEALTH_TIMEOUTS_MS.friendbot,
    onAttempt: (attempt, elapsed) => {
      if (attempt > 0 && attempt % 5 === 0) {
        info(`still waiting for friendbot… ${Math.round(elapsed / 1000)}s`);
      }
    },
  });
  info('friendbot serving');
}

// ── 4. Accounts ──────────────────────────────────────────────────────────────

async function fundAll(ctx: ChainContext, accounts: DevnetAccount[]): Promise<void> {
  // Sequential on purpose. Friendbot funds from a single root account, so
  // parallel requests race on its sequence number and produce tx_bad_seq.
  for (const account of accounts) {
    const outcome = await fundAccount(ctx, account.publicKey);
    info(`${account.role.padEnd(18)} ${account.publicKey} ${outcome}`);
  }
}

// ── 5. Asset ─────────────────────────────────────────────────────────────────

async function establishTrustlines(
  ctx: ChainContext,
  accounts: Record<DevnetRole, DevnetAccount>,
  usdc: Asset,
): Promise<void> {
  for (const account of Object.values(accounts)) {
    if (!account.trustline) {
      info(`${account.role.padEnd(18)} skipped (no-trustline fixture)`);
      continue;
    }
    if (await hasTrustline(ctx, account.publicKey, usdc)) {
      info(`${account.role.padEnd(18)} trustline already present`);
      continue;
    }
    await submitClassic(ctx, Keypair.fromSecret(account.secret), [
      Operation.changeTrust({ asset: usdc, limit: String(TRUSTLINE_LIMIT) }),
    ]);
    info(`${account.role.padEnd(18)} trustline established`);
  }
}

async function distributeUsdc(
  ctx: ChainContext,
  accounts: Record<DevnetRole, DevnetAccount>,
  usdc: Asset,
): Promise<void> {
  const issuer = Keypair.fromSecret(accounts.issuer.secret);
  for (const [role, amount] of Object.entries(USDC_DISTRIBUTION)) {
    if (amount <= 0) {
      continue;
    }
    const target = accounts[role as DevnetRole];
    const current = await classicBalance(ctx, target.publicKey, usdc);
    if (current >= amount) {
      info(`${role.padEnd(18)} already holds ${current} ${USDC_CODE}`);
      continue;
    }
    const delta = amount - current;
    await submitClassic(ctx, issuer, [
      Operation.payment({ destination: target.publicKey, asset: usdc, amount: String(delta) }),
    ]);
    info(`${role.padEnd(18)} funded with ${delta} ${USDC_CODE}`);
  }
}

// ── 6. SAC ───────────────────────────────────────────────────────────────────

/**
 * Deploys the Soroban Asset Contract wrapper for `asset`, or reports the
 * existing one. The SAC address is a pure function of (asset, network), so it is
 * deterministic without any salt of our own.
 */
async function ensureSac(ctx: ChainContext, deployer: Keypair, asset: Asset): Promise<string> {
  const sacAddress = asset.contractId(ctx.passphrase);
  const server = rpcClient(ctx);
  const existing = await server
    .getContractData(sacAddress, xdr.ScVal.scvLedgerKeyContractInstance())
    .catch(() => null);
  if (existing) {
    info(`${asset.getCode().padEnd(6)} SAC already deployed at ${sacAddress}`);
    return sacAddress;
  }
  // Pass the Asset object, never `asset.toString()`: the native asset stringifies
  // to "native", which the SDK then tries to parse as a code:issuer pair and
  // rejects with "Issuer cannot be null".
  await submitSoroban(ctx, deployer, Operation.createStellarAssetContract({ asset }));
  info(`${asset.getCode().padEnd(6)} SAC deployed at ${sacAddress}`);
  return sacAddress;
}

// ── 7. Contract ──────────────────────────────────────────────────────────────

async function buildWasm(skip: boolean): Promise<Buffer> {
  const wasmPath = join(REPO_ROOT, WASM_RELATIVE_PATH);
  if (!skip) {
    info('cargo build --release --target wasm32v1-none (this takes ~60s cold)');
    try {
      await execFileAsync(
        'cargo',
        [
          'build',
          '--manifest-path',
          join(REPO_ROOT, 'contracts/hazina-escrow/Cargo.toml'),
          '--release',
          '--target',
          'wasm32v1-none',
          '--locked',
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      if (stderr.includes('wasm32v1-none')) {
        throw new Error(
          'The wasm32v1-none Rust target is missing. Install it with:\n' +
            '  rustup target add wasm32v1-none\n\n' +
            `cargo said:\n${stderr.slice(0, 800)}`,
        );
      }
      throw new Error(`contract build failed:\n${stderr.slice(0, 2000)}`);
    }
  }
  try {
    return await readFile(wasmPath);
  } catch {
    throw new Error(
      `Contract wasm not found at ${wasmPath}. Run without DEVNET_SKIP_BUILD=true, ` +
        'or build it with: npm run contracts:check',
    );
  }
}

/** Uploads the wasm if the network does not already have it. */
async function ensureWasmUploaded(
  ctx: ChainContext,
  uploader: Keypair,
  wasm: Buffer,
): Promise<string> {
  const result = await submitSoroban(ctx, uploader, Operation.uploadContractWasm({ wasm }));
  const hash = Buffer.from(result.native as Uint8Array).toString('hex');
  info(`wasm hash ${hash}`);
  return hash;
}

/**
 * Deploys the escrow contract at the fixed salt, or accepts the one already
 * there. `precomputeContractId` tells us the address before we deploy, so the
 * "already deployed" check is a straight state read rather than a guess.
 */
async function ensureContractDeployed(
  ctx: ChainContext,
  deployer: Keypair,
  wasmHash: string,
): Promise<string> {
  const expectedId = precomputeContractId(deployer.publicKey(), ctx.passphrase);
  const server = rpcClient(ctx);
  const existing = await server
    .getContractData(expectedId, xdr.ScVal.scvLedgerKeyContractInstance())
    .catch(() => null);
  if (existing) {
    info(`contract already deployed at ${expectedId}`);
    return expectedId;
  }
  const result = await submitSoroban(
    ctx,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.from(wasmHash, 'hex'),
      salt: contractSalt(),
    }),
  );
  const deployedId = result.native as string;
  // The determinism guarantee is only worth anything if we check it.
  if (deployedId !== expectedId) {
    throw new Error(
      `Contract id mismatch: deployed ${deployedId} but precomputed ${expectedId}. ` +
        'The deterministic-address guarantee is broken — do not ship this.',
    );
  }
  info(`contract deployed at ${deployedId}`);
  return deployedId;
}

/**
 * initialize(admin, 500). Already-initialized is success, not failure.
 *
 * Note we do NOT probe with `get_default_fee` first: that getter is
 * `unwrap_or(500)`, so a freshly deployed, uninitialized contract happily
 * reports 500 and the probe would wrongly conclude the contract was ready —
 * leaving the next `set_treasury` to fail with NotInitialized. Attempting the
 * call and recognising AlreadyInitialized is the only honest check.
 */
async function ensureInitialized(
  ctx: ChainContext,
  admin: Keypair,
  contractId: string,
): Promise<void> {
  try {
    await submitSoroban(
      ctx,
      admin,
      new Contract(contractId).call(
        'initialize',
        Address.fromString(admin.publicKey()).toScVal(),
        xdr.ScVal.scvU32(PLATFORM_FEE_BPS),
      ),
    );
    info(`initialize(admin, ${PLATFORM_FEE_BPS}) — 95/5 split armed`);
  } catch (err) {
    if (contractErrorCode(err) !== CONTRACT_ERROR.AlreadyInitialized) {
      throw err;
    }
    info('already initialized');
  }

  const fee = await simulateCall(ctx, admin.publicKey(), contractId, 'get_default_fee');
  if (Number(fee) !== PLATFORM_FEE_BPS) {
    throw new Error(
      `Contract at ${contractId} reports ${String(fee)} bps but the devnet expects ` +
        `${PLATFORM_FEE_BPS}. Run \`npm run devnet:reset\` to reprovision from zero.`,
    );
  }
  info(`platform fee confirmed at ${String(fee)} bps`);
}

// ── 8. Contract config ───────────────────────────────────────────────────────

async function configureContract(
  ctx: ChainContext,
  admin: Keypair,
  contractId: string,
  accounts: Record<DevnetRole, DevnetAccount>,
): Promise<void> {
  const contract = new Contract(contractId);

  const treasury = await simulateCall(ctx, admin.publicKey(), contractId, 'get_treasury').catch(
    () => null,
  );
  if (treasury === accounts.treasury.publicKey) {
    info('treasury already set');
  } else {
    await submitSoroban(
      ctx,
      admin,
      contract.call(
        'set_treasury',
        Address.fromString(admin.publicKey()).toScVal(),
        Address.fromString(accounts.treasury.publicKey).toScVal(),
      ),
    );
    info(`set_treasury  → ${accounts.treasury.publicKey}`);
  }

  // There is no get_arbitrator on the contract, so this one is unconditional.
  // set_arbitrator is an idempotent overwrite, so re-running is harmless.
  await submitSoroban(
    ctx,
    admin,
    contract.call(
      'set_arbitrator',
      Address.fromString(admin.publicKey()).toScVal(),
      Address.fromString(accounts.arbitrator.publicKey).toScVal(),
    ),
  );
  info(`set_arbitrator → ${accounts.arbitrator.publicKey}`);
}

// ── 10. Balances for the summary ─────────────────────────────────────────────

async function collectBalances(
  ctx: ChainContext,
  accounts: DevnetAccount[],
  usdc: Asset,
): Promise<ProvisionResult['balances']> {
  const out: ProvisionResult['balances'] = {};
  for (const account of accounts) {
    const [xlm, usdcBalance, trustline] = await Promise.all([
      classicBalance(ctx, account.publicKey, Asset.native()),
      classicBalance(ctx, account.publicKey, usdc),
      hasTrustline(ctx, account.publicKey, usdc),
    ]);
    out[account.role] = { xlm, usdc: usdcBalance, trustline };
  }
  return out;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function provision(): Promise<ProvisionResult> {
  const overrides = readEnv();
  const urls = endpoints(overrides.port, overrides.host);
  const ctx: ChainContext = {
    horizonUrl: urls.horizon,
    rpcUrl: urls.rpc,
    friendbotUrl: urls.friendbot,
    passphrase: LOCAL_NETWORK_PASSPHRASE,
  };

  step('Guarding target network');
  assertDevnetTarget({ passphrase: ctx.passphrase, ...urls });
  info(`passphrase "${ctx.passphrase}" — local only`);

  step('Starting ephemeral network');
  if (await isDevnetRunning(urls.horizon)) {
    info('a devnet is already responding — reusing it');
  } else {
    await composeUp(REPO_ROOT, overrides.port, info);
  }

  step('Waiting for network health');
  await waitForNetwork(ctx);

  step('Deriving and funding deterministic accounts');
  const accounts = accountMap();
  const accountList = Object.values(accounts);
  await fundAll(ctx, accountList);

  step(`Issuing devnet ${USDC_CODE}`);
  const usdc = new Asset(USDC_CODE, accounts.issuer.publicKey);
  await establishTrustlines(ctx, accounts, usdc);
  await distributeUsdc(ctx, accounts, usdc);

  step('Deploying Soroban asset contracts');
  const admin = Keypair.fromSecret(accounts.admin.secret);
  const usdcSacAddress = await ensureSac(ctx, admin, usdc);
  const xlmSacAddress = await ensureSac(ctx, admin, Asset.native());

  step('Building and deploying hazina-escrow');
  const wasm = await buildWasm(overrides.skipBuild);
  info(`wasm ${wasm.length} bytes`);
  const wasmHash = await ensureWasmUploaded(ctx, admin, wasm);
  const contractId = await ensureContractDeployed(ctx, admin, wasmHash);
  await ensureInitialized(ctx, admin, contractId);

  step('Configuring treasury and arbitrator');
  await configureContract(ctx, admin, contractId, accounts);

  step('Seeding the marketplace');
  await mkdir(join(REPO_ROOT, 'data'), { recursive: true });
  const datasetIds = await writeMarketplaceSeed(join(REPO_ROOT, MARKETPLACE_SEED_FILE), accounts);
  for (const id of datasetIds) {
    info(`dataset ${id}`);
  }

  step('Writing .env.devnet and devnet.accounts.json');
  const balances = await collectBalances(ctx, accountList, usdc);
  const result: ProvisionResult = {
    passphrase: ctx.passphrase,
    horizonUrl: ctx.horizonUrl,
    rpcUrl: ctx.rpcUrl,
    friendbotUrl: ctx.friendbotUrl,
    contractId,
    wasmHash,
    usdcSacAddress,
    xlmSacAddress,
    issuerPublicKey: accounts.issuer.publicKey,
    accounts: accountList,
    balances,
    datasetIds,
  };
  await writeArtifacts(
    join(REPO_ROOT, ENV_OUTPUT_FILE),
    join(REPO_ROOT, ACCOUNTS_OUTPUT_FILE),
    result,
  );
  info(`${ENV_OUTPUT_FILE} and ${ACCOUNTS_OUTPUT_FILE} written`);

  return result;
}

async function main(): Promise<void> {
  const started = Date.now();
  const result = await provision();
  process.stdout.write(renderSummary(result, process.stdout.isTTY === true));
  process.stdout.write(`Provisioned in ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`);
}

/** True when this file was run directly rather than imported by a test. */
const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n✖ devnet provisioning failed\n\n${message}\n\n`);
    if (err instanceof ChainError && err.detail) {
      process.stderr.write(`${JSON.stringify(err.detail, null, 2).slice(0, 2000)}\n\n`);
    }
    process.stderr.write('Troubleshooting: docs/DEVNET.md\n\n');
    process.exitCode = 1;
  });
}
