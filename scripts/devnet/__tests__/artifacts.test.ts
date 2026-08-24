/**
 * Gate tests for the generated artifacts and the marketplace seed.
 *
 * These cover the "hands back a ready .env" half of the issue: the file has to
 * be complete enough to drop into backend/.env, and it has to be byte-identical
 * across runs.
 */

import { describe, expect, it } from 'vitest';
import { renderAccountsFile, renderEnvFile, type ProvisionResult } from '../lib/artifacts.ts';
import { buildDatasets, buildMarketplaceSeed, SEED_TIMESTAMP } from '../lib/marketplace.ts';
import { accountMap, deriveAccounts, precomputeContractId } from '../lib/accounts.ts';
import {
  LOCAL_NETWORK_PASSPHRASE,
  PLATFORM_FEE_BPS,
  endpoints,
  env as readEnv,
} from '../lib/config.ts';
import { formatAmount, renderSummary } from '../lib/summary.ts';
import { contractErrorCode, CONTRACT_ERROR } from '../lib/chain.ts';

function fixture(): ProvisionResult {
  const accounts = deriveAccounts();
  const map = accountMap();
  const urls = endpoints();
  return {
    passphrase: LOCAL_NETWORK_PASSPHRASE,
    horizonUrl: urls.horizon,
    rpcUrl: urls.rpc,
    friendbotUrl: urls.friendbot,
    contractId: precomputeContractId(map.admin.publicKey, LOCAL_NETWORK_PASSPHRASE),
    wasmHash: 'a'.repeat(64),
    usdcSacAddress: 'CB5AE4ZXEWQWZDSIXJDIIVGPRKGXYUOZ3QKAWDPRJZN37FFFTW5LEQWL',
    xlmSacAddress: 'CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4',
    issuerPublicKey: map.issuer.publicKey,
    accounts,
    balances: Object.fromEntries(
      accounts.map(a => [a.role, { xlm: 10_000, usdc: 0, trustline: a.trustline }]),
    ),
    datasetIds: ['devnet-whale-flows', 'devnet-yield-curve', 'devnet-orphan-feed'],
  };
}

describe('renderEnvFile', () => {
  it('is byte-identical across renders', () => {
    expect(renderEnvFile(fixture())).toBe(renderEnvFile(fixture()));
  });

  it('contains no timestamp or other varying value', () => {
    // The determinism criterion — a date stamp here would break it silently.
    const env = renderEnvFile(fixture());
    expect(env).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('wires the escrow contract and the 95/5 fee', () => {
    const env = renderEnvFile(fixture());
    expect(env).toContain(`ESCROW_CONTRACT_ID=${fixture().contractId}`);
    expect(env).toContain(`PLATFORM_FEE_BPS=${PLATFORM_FEE_BPS}`);
    expect(env).toContain('PLATFORM_FEE_RATE=0.05');
  });

  it('points every endpoint at the local devnet', () => {
    const env = renderEnvFile(fixture());
    expect(env).toContain('STELLAR_NETWORK=devnet');
    expect(env).toContain(`STELLAR_NETWORK_PASSPHRASE=${LOCAL_NETWORK_PASSPHRASE}`);
    expect(env).toMatch(/STELLAR_HORIZON_URL=http:\/\/localhost:\d+/);
    expect(env).toMatch(/SOROBAN_RPC_URL=http:\/\/localhost:\d+\/rpc/);
    // Nothing may point at a public network.
    expect(env).not.toMatch(/stellar\.org/);
  });

  it('includes every account as both public and secret', () => {
    const env = renderEnvFile(fixture());
    for (const account of deriveAccounts()) {
      expect(env).toContain(`${account.envKey}=${account.publicKey}`);
      expect(env).toContain(`${account.envKey.replace(/_PUBLIC$/, '_SECRET')}=${account.secret}`);
    }
  });

  it('sets the backend admin signer to the contract admin', () => {
    // The backend signs release/refund as admin; a mismatch here is a silent
    // "NotAdmin" at the first payout.
    const env = renderEnvFile(fixture());
    expect(env).toContain(`AGENT_WALLET_SECRET=${accountMap().admin.secret}`);
    expect(env).toContain(`ESCROW_WALLET=${accountMap().admin.publicKey}`);
  });

  it('warns that the keys are throwaway', () => {
    expect(renderEnvFile(fixture())).toMatch(/Never reuse them on/i);
  });

  it('is valid KEY=VALUE throughout', () => {
    for (const line of renderEnvFile(fixture()).split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) {
        continue;
      }
      expect(line).toMatch(/^[A-Z0-9_]+=.*$/);
    }
  });
});

describe('renderAccountsFile', () => {
  it('is stable across renders', () => {
    expect(JSON.stringify(renderAccountsFile(fixture()))).toBe(
      JSON.stringify(renderAccountsFile(fixture())),
    );
  });

  it('records the contract, asset and every account', () => {
    const file = renderAccountsFile(fixture());
    expect(file.network.passphrase).toBe(LOCAL_NETWORK_PASSPHRASE);
    expect(file.contract.platformFeeBps).toBe(PLATFORM_FEE_BPS);
    expect(file.accounts).toHaveLength(deriveAccounts().length);
    expect(file.asset.issuer).toBe(accountMap().issuer.publicKey);
  });

  it('preserves account order, so a diff between runs is meaningful', () => {
    expect(renderAccountsFile(fixture()).accounts.map(a => a.role)).toEqual(
      deriveAccounts().map(a => a.role),
    );
  });
});

describe('marketplace seed', () => {
  it('is deterministic', () => {
    const a = JSON.stringify(buildMarketplaceSeed(accountMap()));
    const b = JSON.stringify(buildMarketplaceSeed(accountMap()));
    expect(a).toBe(b);
  });

  it('uses a fixed timestamp rather than the current time', () => {
    for (const dataset of buildDatasets(accountMap())) {
      expect(dataset.createdAt).toBe(SEED_TIMESTAMP);
    }
  });

  it('assigns each dataset to a real devnet seller address', () => {
    const valid = new Set(deriveAccounts().map(a => a.publicKey));
    for (const dataset of buildDatasets(accountMap())) {
      expect(valid.has(dataset.sellerWallet)).toBe(true);
    }
  });

  it('pins the orphan feed to the trustline-less seller', () => {
    // This fixture is what the payout-failure e2e depends on.
    const orphan = buildDatasets(accountMap()).find(d => d.id === 'devnet-orphan-feed');
    expect(orphan?.sellerWallet).toBe(accountMap().sellerNoTrustline.publicKey);
  });

  it('uses unique dataset ids', () => {
    const ids = buildDatasets(accountMap()).map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the shape backend/src/db/seed.ts reads', () => {
    const seed = buildMarketplaceSeed(accountMap());
    expect(Array.isArray(seed.datasets)).toBe(true);
    expect(Array.isArray(seed.transactions)).toBe(true);
    for (const dataset of seed.datasets) {
      expect(dataset).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        type: expect.any(String),
        category: expect.any(String),
        pricePerQuery: expect.any(Number),
        sellerWallet: expect.any(String),
        queriesServed: expect.any(Number),
        totalEarned: expect.any(Number),
        createdAt: expect.any(String),
      });
    }
  });
});

describe('summary rendering', () => {
  it('renders without colour codes when colour is off', () => {
    const plain = renderSummary(fixture(), false);
    // eslint-disable-next-line no-control-regex
    expect(plain).not.toMatch(/\[/);
  });

  it('includes the endpoints, contract id and every account', () => {
    const summary = renderSummary(fixture(), false);
    expect(summary).toContain(fixture().contractId);
    expect(summary).toContain('http://localhost:8000/rpc');
    for (const account of deriveAccounts()) {
      expect(summary).toContain(account.publicKey);
    }
  });

  it('states the 95/5 split', () => {
    expect(renderSummary(fixture(), false)).toContain('95/5');
  });

  it('formats amounts with thousands separators', () => {
    expect(formatAmount(10_000)).toBe('10,000');
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(1_234_567)).toBe('1,234,567');
  });
});

describe('config env overrides', () => {
  it('defaults to port 8000', () => {
    expect(readEnv({}).port).toBe(8000);
  });

  it('honours DEVNET_PORT', () => {
    expect(readEnv({ DEVNET_PORT: '8100' }).port).toBe(8100);
  });

  it('rejects a nonsense port instead of silently defaulting', () => {
    expect(() => readEnv({ DEVNET_PORT: 'not-a-port' })).toThrow(/DEVNET_PORT/);
    expect(() => readEnv({ DEVNET_PORT: '99999' })).toThrow(/DEVNET_PORT/);
    expect(() => readEnv({ DEVNET_PORT: '0' })).toThrow(/DEVNET_PORT/);
  });

  it('builds endpoints off the configured port', () => {
    const urls = endpoints(8100);
    expect(urls.horizon).toBe('http://localhost:8100');
    expect(urls.rpc).toBe('http://localhost:8100/rpc');
    expect(urls.friendbot).toBe('http://localhost:8100/friendbot');
  });
});

describe('contractErrorCode', () => {
  it('extracts a contract panic code', () => {
    expect(contractErrorCode(new Error('HostError: Error(Contract, #17)'))).toBe(
      CONTRACT_ERROR.BuyerNotConfirmed,
    );
    expect(contractErrorCode(new Error('Error(Contract, #1)'))).toBe(
      CONTRACT_ERROR.AlreadyInitialized,
    );
  });

  it('tolerates whitespace variation', () => {
    expect(contractErrorCode(new Error('Error(Contract,#6)'))).toBe(CONTRACT_ERROR.AlreadyReleased);
  });

  it('returns null for a non-contract failure', () => {
    expect(contractErrorCode(new Error('connect ECONNREFUSED'))).toBeNull();
    expect(contractErrorCode('some string')).toBeNull();
    expect(contractErrorCode(undefined)).toBeNull();
  });
});
