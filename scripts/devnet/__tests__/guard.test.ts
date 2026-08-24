/**
 * Gate tests for the devnet blast shield.
 *
 * This is the suite that enforces the acceptance criterion "Nothing in the
 * devnet path can touch public testnet or mainnet". Deterministic, offline,
 * milliseconds — it runs on every commit.
 */

import { describe, expect, it } from 'vitest';
import {
  DevnetGuardError,
  assertDevnetTarget,
  assertLocalEndpoint,
  assertLocalPassphrase,
  assertReportedPassphraseMatches,
  isLocalPassphrase,
} from '../lib/guard.ts';
import { LOCAL_NETWORK_PASSPHRASE } from '../lib/config.ts';

const LOCAL_URLS = {
  horizon: 'http://localhost:8000',
  rpc: 'http://localhost:8000/rpc',
  friendbot: 'http://localhost:8000/friendbot',
};

describe('assertLocalPassphrase', () => {
  it('accepts the quickstart local passphrase', () => {
    expect(() => assertLocalPassphrase(LOCAL_NETWORK_PASSPHRASE)).not.toThrow();
    expect(isLocalPassphrase(LOCAL_NETWORK_PASSPHRASE)).toBe(true);
  });

  it('accepts the randomized local passphrase variant', () => {
    const randomized = `${LOCAL_NETWORK_PASSPHRASE} ; ${'a1b2c3d4'.repeat(8)}`;
    expect(randomized).toMatch(/ ; [0-9a-f]{64}$/);
    expect(isLocalPassphrase(randomized)).toBe(true);
  });

  // The whole point of the feature. Each of these must be impossible.
  it.each([
    ['Public Global Stellar Network ; September 2015', 'mainnet'],
    ['Test SDF Network ; September 2015', 'public testnet'],
    ['Test SDF Future Network ; October 2022', 'futurenet'],
  ])('refuses %s', passphrase => {
    expect(() => assertLocalPassphrase(passphrase)).toThrow(DevnetGuardError);
  });

  it('names the network it refused, so the operator knows what was prevented', () => {
    expect(() => assertLocalPassphrase('Public Global Stellar Network ; September 2015')).toThrow(
      /Stellar mainnet/,
    );
    expect(() => assertLocalPassphrase('Test SDF Network ; September 2015')).toThrow(
      /Stellar public testnet/,
    );
  });

  it('refuses an empty or non-string passphrase', () => {
    expect(() => assertLocalPassphrase('')).toThrow(DevnetGuardError);
    expect(() => assertLocalPassphrase(undefined as unknown as string)).toThrow(DevnetGuardError);
  });

  it('refuses a passphrase that merely CONTAINS the local one', () => {
    // Guards against a substring check being used instead of an exact match.
    expect(isLocalPassphrase(`${LOCAL_NETWORK_PASSPHRASE} and also mainnet`)).toBe(false);
    expect(isLocalPassphrase(`prefix ${LOCAL_NETWORK_PASSPHRASE}`)).toBe(false);
    expect(() => assertLocalPassphrase(`${LOCAL_NETWORK_PASSPHRASE}x`)).toThrow(DevnetGuardError);
  });

  it('refuses a randomized variant with a non-hex or wrong-length suffix', () => {
    expect(isLocalPassphrase(`${LOCAL_NETWORK_PASSPHRASE} ; zzzz`)).toBe(false);
    expect(isLocalPassphrase(`${LOCAL_NETWORK_PASSPHRASE} ; ${'a'.repeat(63)}`)).toBe(false);
    expect(isLocalPassphrase(`${LOCAL_NETWORK_PASSPHRASE} ; ${'a'.repeat(65)}`)).toBe(false);
  });
});

describe('assertLocalEndpoint', () => {
  it.each([
    'http://localhost:8000',
    'http://127.0.0.1:8000/rpc',
    'http://0.0.0.0:8100',
    'http://host.docker.internal:8000',
    'http://stellar-devnet:8000/rpc',
  ])('accepts %s', url => {
    expect(() => assertLocalEndpoint(url, 'test')).not.toThrow();
  });

  it.each([
    'https://horizon-testnet.stellar.org',
    'https://horizon.stellar.org',
    'https://soroban-testnet.stellar.org',
    'http://evil.example.com:8000',
    // A hostname that merely starts with an allowed one must still be refused.
    'http://localhost.evil.com:8000',
  ])('refuses %s', url => {
    expect(() => assertLocalEndpoint(url, 'test')).toThrow(DevnetGuardError);
  });

  it('refuses non-http protocols and malformed URLs', () => {
    expect(() => assertLocalEndpoint('ftp://localhost:8000', 'test')).toThrow(DevnetGuardError);
    expect(() => assertLocalEndpoint('file:///etc/passwd', 'test')).toThrow(DevnetGuardError);
    expect(() => assertLocalEndpoint('not a url', 'test')).toThrow(DevnetGuardError);
  });

  it('names the endpoint that failed', () => {
    expect(() => assertLocalEndpoint('https://horizon.stellar.org', 'Horizon')).toThrow(/Horizon/);
  });
});

describe('assertDevnetTarget', () => {
  it('accepts a fully local target', () => {
    expect(() =>
      assertDevnetTarget({ passphrase: LOCAL_NETWORK_PASSPHRASE, ...LOCAL_URLS }),
    ).not.toThrow();
  });

  it('refuses a local passphrase pointed at a public endpoint', () => {
    // The mixed-config case: right passphrase, wrong host.
    expect(() =>
      assertDevnetTarget({
        passphrase: LOCAL_NETWORK_PASSPHRASE,
        ...LOCAL_URLS,
        horizon: 'https://horizon.stellar.org',
      }),
    ).toThrow(DevnetGuardError);
  });

  it('refuses a local endpoint with a public passphrase', () => {
    expect(() =>
      assertDevnetTarget({
        passphrase: 'Test SDF Network ; September 2015',
        ...LOCAL_URLS,
      }),
    ).toThrow(DevnetGuardError);
  });

  it('checks every endpoint, not just the first', () => {
    expect(() =>
      assertDevnetTarget({
        passphrase: LOCAL_NETWORK_PASSPHRASE,
        ...LOCAL_URLS,
        friendbot: 'https://friendbot.stellar.org',
      }),
    ).toThrow(DevnetGuardError);
  });
});

describe('assertReportedPassphraseMatches', () => {
  it('accepts a matching local passphrase', () => {
    expect(() =>
      assertReportedPassphraseMatches(LOCAL_NETWORK_PASSPHRASE, LOCAL_NETWORK_PASSPHRASE),
    ).not.toThrow();
  });

  it('refuses when the network reports a public passphrase', () => {
    // Something else listening on port 8000 — a tunnel, a proxy to testnet.
    expect(() =>
      assertReportedPassphraseMatches(
        'Test SDF Network ; September 2015',
        LOCAL_NETWORK_PASSPHRASE,
      ),
    ).toThrow(DevnetGuardError);
  });

  it('refuses when a local-but-different passphrase is reported', () => {
    const randomized = `${LOCAL_NETWORK_PASSPHRASE} ; ${'0'.repeat(64)}`;
    expect(() => assertReportedPassphraseMatches(randomized, LOCAL_NETWORK_PASSPHRASE)).toThrow(
      /other than the Hazina devnet/,
    );
  });
});
