/**
 * status.ts — `npm run devnet:status`.
 *
 * Answers "is the devnet up, and is it the devnet I think it is?" without
 * mutating anything. Exits non-zero when the devnet is not usable, so CI and
 * shell scripts can gate on it.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Asset } from '@stellar/stellar-sdk';
import {
  LOCAL_NETWORK_PASSPHRASE,
  PLATFORM_FEE_BPS,
  USDC_CODE,
  endpoints,
  env as readEnv,
} from './lib/config.ts';
import { assertDevnetTarget } from './lib/guard.ts';
import { accountMap, precomputeContractId } from './lib/accounts.ts';
import { fetchRpcPassphrase, probeHorizon, probeRpc } from './lib/health.ts';
import { classicBalance, hasTrustline, simulateCall, type ChainContext } from './lib/chain.ts';
import { composeStatus } from './lib/compose.ts';
import { formatAmount } from './lib/summary.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)}${value}\n`);
}

export async function status(): Promise<boolean> {
  const overrides = readEnv();
  const urls = endpoints(overrides.port, overrides.host);
  const ctx: ChainContext = {
    horizonUrl: urls.horizon,
    rpcUrl: urls.rpc,
    friendbotUrl: urls.friendbot,
    passphrase: LOCAL_NETWORK_PASSPHRASE,
  };
  assertDevnetTarget({ passphrase: ctx.passphrase, ...urls });

  process.stdout.write('\nHazina devnet status\n\n');

  // ── Container ──
  try {
    const compose = await composeStatus(REPO_ROOT, overrides.port);
    line('container', compose.running ? 'running' : 'not running');
  } catch (err) {
    line('container', `unknown (${err instanceof Error ? err.message.split('\n')[0] : 'error'})`);
  }

  // ── Network ──
  const horizon = await probeHorizon(ctx.horizonUrl).catch(() => null);
  if (!horizon) {
    line('horizon', `DOWN (${ctx.horizonUrl})`);
    process.stdout.write('\nDevnet is not up. Start it with: npm run devnet\n\n');
    return false;
  }
  line('horizon', `up, ledger ${horizon.latestLedger} (${ctx.horizonUrl})`);

  const rpcHealth = await probeRpc(ctx.rpcUrl).catch(() => null);
  line('soroban rpc', rpcHealth ? `healthy, ledger ${rpcHealth.latestLedger}` : 'DOWN');

  const reported = await fetchRpcPassphrase(ctx.rpcUrl).catch(() => horizon.passphrase);
  const passphraseOk = reported === LOCAL_NETWORK_PASSPHRASE;
  line('passphrase', `${reported}${passphraseOk ? '' : '  ← NOT THE LOCAL DEVNET'}`);
  if (!passphraseOk) {
    process.stdout.write('\nRefusing to report further: that is not the local devnet.\n\n');
    return false;
  }

  // ── Contract ──
  const accounts = accountMap();
  const expectedId = precomputeContractId(accounts.admin.publicKey, LOCAL_NETWORK_PASSPHRASE);
  const fee = await simulateCall(
    ctx,
    accounts.admin.publicKey,
    expectedId,
    'get_default_fee',
  ).catch(() => null);
  line('escrow contract', expectedId);
  if (fee === null || fee === undefined) {
    line('contract state', 'NOT DEPLOYED / not initialized — run: npm run devnet');
    process.stdout.write('\n');
    return false;
  }
  line(
    'platform fee',
    `${String(fee)} bps${Number(fee) === PLATFORM_FEE_BPS ? '' : '  ← unexpected'}`,
  );

  const escrowCount = await simulateCall(
    ctx,
    accounts.admin.publicKey,
    expectedId,
    'get_escrow_count',
  ).catch(() => null);
  line('escrows created', escrowCount === null ? 'unknown' : String(escrowCount));

  // ── Balances ──
  const usdc = new Asset(USDC_CODE, accounts.issuer.publicKey);
  process.stdout.write('\n  accounts\n');
  for (const account of Object.values(accounts)) {
    const [xlm, usdcBalance, trust] = await Promise.all([
      classicBalance(ctx, account.publicKey, Asset.native()).catch(() => 0),
      classicBalance(ctx, account.publicKey, usdc).catch(() => 0),
      hasTrustline(ctx, account.publicKey, usdc).catch(() => false),
    ]);
    process.stdout.write(
      `    ${account.role.padEnd(20)}${account.publicKey}  ` +
        `${formatAmount(xlm).padStart(11)} XLM  ${formatAmount(usdcBalance).padStart(10)} ${USDC_CODE}` +
        `  ${trust ? 'trustline' : 'no-trustline'}\n`,
    );
  }
  process.stdout.write('\nDevnet is ready.\n\n');
  return true;
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  status()
    .then(ok => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      process.stderr.write(`\n✖ ${err instanceof Error ? err.message : String(err)}\n\n`);
      process.exitCode = 1;
    });
}
