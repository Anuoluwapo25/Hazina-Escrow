/**
 * summary.ts — the thing a contributor actually reads.
 *
 * Pure string rendering, so the summary is gate-testable and cannot be the
 * reason provisioning fails. Kept out of provision.ts to stop that file turning
 * into a wall of console.log.
 */

import { PLATFORM_FEE_BPS, USDC_CODE } from './config.ts';
import type { ProvisionResult } from './artifacts.ts';

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const CYAN = '[36m';
const YELLOW = '[33m';

/** Colour only when attached to a TTY, so CI logs stay greppable. */
export function colourise(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `${code}${s}${RESET}` : s);
  return {
    bold: wrap(BOLD),
    dim: wrap(DIM),
    green: wrap(GREEN),
    cyan: wrap(CYAN),
    yellow: wrap(YELLOW),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** Formats a number with thousands separators and at most 4 decimal places. */
export function formatAmount(value: number): string {
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '');
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

export function renderSummary(result: ProvisionResult, useColour = false): string {
  const c = colourise(useColour);
  const width = 78;
  const rule = '─'.repeat(width);
  // Pad against the *uncoloured* length — escape codes have no display width, so
  // measuring the coloured string puts the closing border in the wrong column.
  const title = 'Hazina devnet ready';
  const out: string[] = [];
  out.push('');
  out.push(c.green(`╭${rule}╮`));
  out.push(
    c.green('│') + ' ' + c.bold(title) + ' '.repeat(width - title.length - 1) + c.green('│'),
  );
  out.push(c.green(`╰${rule}╯`));
  out.push('');

  out.push(c.bold('Endpoints'));
  out.push(`  Horizon      ${c.cyan(result.horizonUrl)}`);
  out.push(`  Soroban RPC  ${c.cyan(result.rpcUrl)}`);
  out.push(`  Friendbot    ${c.cyan(result.friendbotUrl)}`);
  out.push(`  Passphrase   ${c.dim(result.passphrase)}`);
  out.push('');

  out.push(c.bold('Contract'));
  out.push(`  Escrow id    ${c.cyan(result.contractId)}`);
  out.push(`  WASM hash    ${c.dim(result.wasmHash)}`);
  out.push(
    `  Platform fee ${PLATFORM_FEE_BPS} bps ${c.dim(`(${PLATFORM_FEE_BPS / 100}% — 95/5 split)`)}`,
  );
  out.push('');

  out.push(c.bold(`Asset (${USDC_CODE})`));
  out.push(`  Issuer       ${c.cyan(result.issuerPublicKey)}`);
  out.push(`  SAC address  ${c.cyan(result.usdcSacAddress)}`);
  out.push(`  XLM SAC      ${c.dim(result.xlmSacAddress)}`);
  out.push('');

  out.push(c.bold('Accounts'));
  out.push(
    c.dim(
      `  ${pad('ROLE', 20)}${pad('ADDRESS', 58)}${padLeft('XLM', 12)}${padLeft(USDC_CODE, 14)}  TRUST`,
    ),
  );
  for (const account of result.accounts) {
    const bal = result.balances[account.role] ?? { xlm: 0, usdc: 0, trustline: false };
    const trust = account.trustline ? c.green('yes') : c.yellow('no');
    out.push(
      `  ${pad(account.role, 20)}${pad(account.publicKey, 58)}` +
        `${padLeft(formatAmount(bal.xlm), 12)}${padLeft(formatAmount(bal.usdc), 14)}  ${trust}`,
    );
  }
  out.push('');

  out.push(c.bold('Marketplace'));
  for (const id of result.datasetIds) {
    out.push(`  • ${id}`);
  }
  out.push('');

  out.push(c.bold('Files written'));
  out.push(`  .env.devnet            ${c.dim('cp .env.devnet backend/.env && npm run dev')}`);
  out.push(`  devnet.accounts.json   ${c.dim('machine-readable account table')}`);
  out.push(`  data/devnet.datasets.json`);
  out.push('');

  out.push(c.bold('Next'));
  out.push(
    `  ${c.cyan('npm run e2e:chain')}      run the on-chain purchase flow against this devnet`,
  );
  out.push(`  ${c.cyan('npm run devnet:status')}  show what is running`);
  out.push(`  ${c.cyan('npm run devnet:reset')}   destroy and reprovision from zero`);
  out.push('');
  return out.join('\n');
}
