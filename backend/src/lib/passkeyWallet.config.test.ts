import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isPasskeyWalletConfigured,
  getLaunchtubeUrl,
  getLaunchtubeJwt,
  getPasskeyWalletWasmHash,
} from './passkeyWallet.config';

describe('passkeyWallet.config', () => {
  const original = {
    LAUNCHTUBE_URL: process.env.LAUNCHTUBE_URL,
    LAUNCHTUBE_JWT: process.env.LAUNCHTUBE_JWT,
    PASSKEY_WALLET_WASM_HASH: process.env.PASSKEY_WALLET_WASM_HASH,
  };

  beforeEach(() => {
    delete process.env.LAUNCHTUBE_URL;
    delete process.env.LAUNCHTUBE_JWT;
    delete process.env.PASSKEY_WALLET_WASM_HASH;
  });

  afterEach(() => {
    process.env.LAUNCHTUBE_URL = original.LAUNCHTUBE_URL;
    process.env.LAUNCHTUBE_JWT = original.LAUNCHTUBE_JWT;
    process.env.PASSKEY_WALLET_WASM_HASH = original.PASSKEY_WALLET_WASM_HASH;
  });

  it('is unconfigured when LAUNCHTUBE_JWT is unset', () => {
    expect(isPasskeyWalletConfigured()).toBe(false);
  });

  it('is configured once LAUNCHTUBE_JWT is set', () => {
    process.env.LAUNCHTUBE_JWT = 'a-token';
    expect(isPasskeyWalletConfigured()).toBe(true);
  });

  it('defaults LAUNCHTUBE_URL to the testnet endpoint', () => {
    expect(getLaunchtubeUrl()).toBe('https://testnet.launchtube.xyz');
  });

  it('strips a trailing slash from a configured LAUNCHTUBE_URL', () => {
    process.env.LAUNCHTUBE_URL = 'https://launchtube.xyz/';
    expect(getLaunchtubeUrl()).toBe('https://launchtube.xyz');
  });

  it('throws a descriptive error when getLaunchtubeJwt() is called unconfigured', () => {
    expect(() => getLaunchtubeJwt()).toThrow(/LAUNCHTUBE_JWT/);
  });

  it('returns the configured JWT', () => {
    process.env.LAUNCHTUBE_JWT = 'secret-token';
    expect(getLaunchtubeJwt()).toBe('secret-token');
  });

  it('returns an empty string when no WASM hash is configured', () => {
    expect(getPasskeyWalletWasmHash()).toBe('');
  });
});
