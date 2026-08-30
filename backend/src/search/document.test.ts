import { describe, expect, it } from 'vitest';
import {
  composeSearchDocument,
  contentHashOf,
  describeDataShape,
  stableSearchDocument,
} from './document';

describe('describeDataShape', () => {
  it('returns empty string for missing/non-object data', () => {
    expect(describeDataShape(null)).toBe('');
    expect(describeDataShape(undefined)).toBe('');
    expect(describeDataShape({})).toBe('');
  });

  it('surfaces the provider _headline as the first line', () => {
    const shape = describeDataShape({ _headline: '  Top 10 whale wallets by balance  ' });
    expect(shape).toBe('Top 10 whale wallets by balance');
  });

  it('excludes pure metadata keys (_live, _fetchedAt) but keeps _headline text', () => {
    const shape = describeDataShape({
      _live: true,
      _fetchedAt: '2026-01-01T00:00:00Z',
      _headline: 'Live feed',
    });
    expect(shape).toBe('Live feed');
  });

  it('extracts field names + a sample row from an array of records — this is the signal a title misses', () => {
    const shape = describeDataShape({
      _points: [
        { walletAddress: 'GABCDEF...', balanceUsd: 4_200_000, lastActive: '2026-01-01' },
        { walletAddress: 'GXYZ...', balanceUsd: 100, lastActive: '2026-01-02' },
      ],
    });
    expect(shape).toContain(
      '_points records include fields: walletAddress, balanceUsd, lastActive',
    );
    expect(shape).toContain('walletAddress=GABCDEF...');
    expect(shape).toContain('balanceUsd=4200000');
  });

  it('lists keys of a nested plain object without recursing into values', () => {
    const shape = describeDataShape({ metadata: { source: 'coingecko', chain: 'stellar' } });
    expect(shape).toBe('metadata fields: source, chain');
  });

  it('truncates long scalar values so the embedded text stays bounded', () => {
    const long = 'x'.repeat(200);
    const shape = describeDataShape({ note: long });
    expect(shape.length).toBeLessThan(long.length);
    expect(shape).toContain('…');
  });

  it('caps the number of top-level keys considered', () => {
    const data: Record<string, number> = {};
    for (let i = 0; i < 30; i++) data[`field${i}`] = i;
    const shape = describeDataShape(data);
    expect(shape.split('\n').length).toBeLessThanOrEqual(15);
  });
});

describe('composeSearchDocument', () => {
  it('joins name, description, category, type, tags, and data shape', () => {
    const doc = composeSearchDocument({
      name: 'Whale Wallet Movements',
      description: 'Tracks large token transfers between major holders',
      category: 'on-chain',
      type: 'whale-wallets',
      tags: ['stellar', 'whales'],
      data: { _points: [{ walletAddress: 'G...', balanceUsd: 5000000 }] },
    });
    expect(doc).toContain('Whale Wallet Movements');
    expect(doc).toContain('Tracks large token transfers between major holders');
    expect(doc).toContain('Category: on-chain');
    expect(doc).toContain('Type: whale-wallets');
    expect(doc).toContain('Tags: stellar, whales');
    expect(doc).toContain('walletAddress');
  });

  it('omits empty optional sections rather than leaving blank lines', () => {
    const doc = composeSearchDocument({
      name: 'X',
      description: 'Y',
      type: 'z',
      data: {},
    });
    expect(doc).toBe('X\nY\nType: z');
  });
});

describe('stableSearchDocument', () => {
  it('omits concrete sample values that describeDataShape would include', () => {
    const dataset = {
      name: 'Whale Wallet Movements',
      description: 'Tracks transfers',
      type: 'whale-wallets',
      data: { _points: [{ walletAddress: 'GABC', balanceUsd: 4_200_000 }] },
    };
    const stable = stableSearchDocument(dataset);
    expect(stable).toContain('_points records include fields: walletAddress, balanceUsd');
    expect(stable).not.toContain('GABC');
    expect(stable).not.toContain('4200000');
  });

  it('is unchanged when only sample values change (a live refresh), unlike the full document', () => {
    const base = {
      name: 'X',
      description: 'Y',
      type: 'z',
      data: { _points: [{ balanceUsd: 100 }] },
    };
    const refreshed = {
      ...base,
      data: { _points: [{ balanceUsd: 999_999 }] },
    };
    expect(stableSearchDocument(base)).toBe(stableSearchDocument(refreshed));
    expect(composeSearchDocument(base)).not.toBe(composeSearchDocument(refreshed));
  });

  it('still changes when the field names (shape) actually change', () => {
    const base = { name: 'X', description: 'Y', type: 'z', data: { _points: [{ a: 1 }] } };
    const changed = { name: 'X', description: 'Y', type: 'z', data: { _points: [{ b: 1 }] } };
    expect(stableSearchDocument(base)).not.toBe(stableSearchDocument(changed));
  });

  it('still changes when the name/description/category/tags change', () => {
    const base = { name: 'X', description: 'Y', type: 'z', data: {} };
    const renamed = { name: 'X2', description: 'Y', type: 'z', data: {} };
    expect(stableSearchDocument(base)).not.toBe(stableSearchDocument(renamed));
  });
});

describe('contentHashOf', () => {
  it('is deterministic for identical text', () => {
    expect(contentHashOf('hello world')).toBe(contentHashOf('hello world'));
  });

  it('changes when the text changes', () => {
    expect(contentHashOf('hello world')).not.toBe(contentHashOf('hello world!'));
  });

  it('is a 64-char lowercase hex sha256 digest', () => {
    expect(contentHashOf('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
