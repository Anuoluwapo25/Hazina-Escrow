import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkSchema,
  checkFreshness,
  checkConsistency,
  checkNullDensity,
  runDeterministicChecks,
} from '../deterministic';
import type { Dataset } from '../../common/storage';

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-test-001',
    name: 'Test Dataset',
    description: 'A test dataset',
    type: 'yield-data',
    pricePerQuery: 0.01,
    sellerWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    data: {},
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('checkSchema', () => {
  it('rejects empty data', () => {
    const result = checkSchema({});
    expect(result.passed).toBe(false);
    expect(result.check).toBe('schema');
  });

  it('rejects non-object data', () => {
    const result = checkSchema(null as unknown as Record<string, unknown>);
    expect(result.passed).toBe(false);
  });

  it('accepts consistent array of records', () => {
    const data = {
      records: [
        { apy: 5.2, protocol: 'Aave', chain: 'Ethereum' },
        { apy: 3.1, protocol: 'Compound', chain: 'Ethereum' },
        { apy: 7.8, protocol: 'Curve', chain: 'Polygon' },
      ],
    };
    const result = checkSchema(data);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('flags inconsistent records', () => {
    const data = {
      records: [
        { apy: 5.2, protocol: 'Aave' },
        { completelyDifferent: true, foo: 'bar' },
      ],
    };
    const result = checkSchema(data);
    expect(result.passed).toBe(false);
  });
});

describe('checkFreshness', () => {
  it('marks recent data as fresh', () => {
    const data = {
      records: [
        { timestamp: new Date().toISOString(), value: 1 },
        { timestamp: new Date().toISOString(), value: 2 },
      ],
    };
    const result = checkFreshness(data, new Date().toISOString());
    expect(result.passed).toBe(true);
  });

  it('marks old data as stale', () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const data = {
      records: [
        { timestamp: oldDate, value: 1 },
        { timestamp: oldDate, value: 2 },
      ],
    };
    const result = checkFreshness(data, oldDate);
    expect(result.passed).toBe(false);
  });

  it('passes for data without timestamps if recently created', () => {
    const data = { records: [{ value: 1 }, { value: 2 }] };
    const result = checkFreshness(data, new Date().toISOString());
    expect(result.passed).toBe(true);
  });
});

describe('checkConsistency', () => {
  it('passes clean data', () => {
    const data = {
      records: [
        { apy: 5.2, tvl: 1000000 },
        { apy: 3.1, tvl: 500000 },
      ],
    };
    const result = checkConsistency(data);
    expect(result.passed).toBe(true);
  });

  it('flags negative APY values', () => {
    const data = {
      records: [
        { apy_percent: -5.2, tvl: 1000000 },
        { apy_percent: 3.1, tvl: 500000 },
      ],
    };
    const result = checkConsistency(data);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('consistency issues');
  });

  it('flags future dates', () => {
    const futureDate = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const data = {
      records: [
        { date: futureDate, value: 1 },
      ],
    };
    const result = checkConsistency(data);
    expect(result.passed).toBe(false);
  });
});

describe('checkNullDensity', () => {
  it('passes data with mostly populated fields', () => {
    const data = {
      records: [
        { a: 1, b: 'hello', c: true },
        { a: 2, b: 'world', c: false },
      ],
    };
    const result = checkNullDensity(data);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails data with too many null fields', () => {
    const data = {
      records: [
        { a: null, b: null, c: null },
        { a: 1, b: null, c: null },
      ],
    };
    const result = checkNullDensity(data);
    expect(result.passed).toBe(false);
  });
});

describe('runDeterministicChecks', () => {
  const existingDatasets: Dataset[] = [];

  it('runs all checks and short-circuits on schema failure', async () => {
    const dataset = makeDataset({ data: {} });
    const result = await runDeterministicChecks(dataset, existingDatasets);
    expect(result.schema.passed).toBe(false);
    expect(result.overallPassed).toBe(false);
  });

  it('passes good data through all checks', async () => {
    const goodData = {
      records: Array.from({ length: 50 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        apy: 3 + Math.random() * 5,
        protocol: `Protocol ${i}`,
        chain: 'Ethereum',
        tvl: 1000000 + i * 100000,
      })),
    };
    const dataset = makeDataset({ data: goodData, createdAt: new Date().toISOString() });
    const result = await runDeterministicChecks(dataset, existingDatasets);
    expect(result.schema.passed).toBe(true);
    expect(result.freshness.passed).toBe(true);
    expect(result.consistency.passed).toBe(true);
    expect(result.originality.passed).toBe(true);
    expect(result.nullDensity.passed).toBe(true);
    expect(result.overallPassed).toBe(true);
  });
});
