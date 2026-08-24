/**
 * guard.ts — the blast shield.
 *
 * Acceptance criterion: "Nothing in the devnet path can touch public testnet or
 * mainnet — a guard rejects a non-local network passphrase."
 *
 * Every function in this file is pure and synchronous, so the whole guard is
 * covered by gate tests that need no Docker and no network. Call
 * `assertDevnetTarget` once per entry point AND immediately before any code path
 * that signs or submits — a passphrase read at startup is not proof of what a
 * later call will use.
 */

import { ALLOWED_HOSTS, FORBIDDEN_PASSPHRASES, LOCAL_NETWORK_PASSPHRASE } from './config.ts';

export class DevnetGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevnetGuardError';
  }
}

/**
 * True for the quickstart `--local` passphrase, including the
 * `--randomize-network-passphrase` variant which appends ` ; <64 hex chars>`.
 * Anything else — including a passphrase that merely *contains* the local one
 * as a substring — is rejected.
 */
export function isLocalPassphrase(passphrase: string): boolean {
  if (passphrase === LOCAL_NETWORK_PASSPHRASE) {
    return true;
  }
  const randomized = new RegExp(
    `^${LOCAL_NETWORK_PASSPHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ; [0-9a-f]{64}$`,
  );
  return randomized.test(passphrase);
}

/**
 * Throws unless `passphrase` is a local devnet passphrase. Named networks get a
 * specific message so the operator immediately understands what was prevented.
 */
export function assertLocalPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new DevnetGuardError(
      'Refusing to run: network passphrase is empty. The devnet only ever targets ' +
        `"${LOCAL_NETWORK_PASSPHRASE}".`,
    );
  }
  if (isLocalPassphrase(passphrase)) {
    return;
  }
  const named = FORBIDDEN_PASSPHRASES[passphrase];
  if (named) {
    throw new DevnetGuardError(
      `Refusing to run against ${named}. The devnet provisioner creates accounts, ` +
        'issues assets and deploys contracts — it must only ever touch a local ' +
        `network. Expected passphrase "${LOCAL_NETWORK_PASSPHRASE}", got "${passphrase}".`,
    );
  }
  throw new DevnetGuardError(
    `Refusing to run: "${passphrase}" is not a local devnet passphrase. ` +
      `Expected "${LOCAL_NETWORK_PASSPHRASE}".`,
  );
}

/**
 * Throws unless `url` points at a loopback/dev host over http(s). Guards against
 * the case where the passphrase is spoofed but the endpoint is a public one.
 */
export function assertLocalEndpoint(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DevnetGuardError(`Refusing to run: ${label} URL "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DevnetGuardError(
      `Refusing to run: ${label} URL "${url}" must be http(s), got "${parsed.protocol}".`,
    );
  }
  // URL normalises IPv6 literals to bracketed form; strip for comparison.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new DevnetGuardError(
      `Refusing to run: ${label} URL "${url}" resolves to host "${host}", which is not a ` +
        `local devnet host. Allowed: ${[...ALLOWED_HOSTS].join(', ')}.`,
    );
  }
}

export interface DevnetTarget {
  passphrase: string;
  horizon: string;
  rpc: string;
  friendbot: string;
}

/**
 * The single call every entry point makes before doing anything else. Checks the
 * passphrase and all three endpoints together, so a partially-local config
 * (local RPC, testnet Horizon) cannot slip through.
 */
export function assertDevnetTarget(target: DevnetTarget): void {
  assertLocalPassphrase(target.passphrase);
  assertLocalEndpoint(target.horizon, 'Horizon');
  assertLocalEndpoint(target.rpc, 'Soroban RPC');
  assertLocalEndpoint(target.friendbot, 'Friendbot');
}

/**
 * Confirms the network we are actually talking to reports the passphrase we
 * expect. Catches the case where something else is listening on port 8000 — a
 * stale tunnel, a proxy to testnet, another project's container.
 */
export function assertReportedPassphraseMatches(reported: string, expected: string): void {
  assertLocalPassphrase(reported);
  if (reported !== expected) {
    throw new DevnetGuardError(
      `Refusing to run: the network at the configured endpoint reports passphrase ` +
        `"${reported}" but the devnet was configured for "${expected}". Something ` +
        'other than the Hazina devnet is listening on that port.',
    );
  }
}
