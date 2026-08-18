import { describe, it, expect } from 'vitest';
import { computeMinhash, jaccardSimilarity } from '../originality';

describe('computeMinhash', () => {
  it('returns a fixed-length signature', () => {
    const records = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const sig = computeMinhash(records);
    expect(sig.length).toBe(128);
  });

  it('produces the same signature for the same data', () => {
    const records = [{ a: 1, b: 2 }];
    const sig1 = computeMinhash(records);
    const sig2 = computeMinhash(records);
    expect(sig1).toEqual(sig2);
  });

  it('produces different signatures for different data', () => {
    const sig1 = computeMinhash([{ a: 1, b: 2 }]);
    const sig2 = computeMinhash([{ x: 99, y: 100 }]);
    expect(sig1).not.toEqual(sig2);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical signatures', () => {
    const sig = new Array(128).fill(42);
    expect(jaccardSimilarity(sig, sig)).toBe(1);
  });

  it('returns 0 for completely different signatures', () => {
    const a = new Array(128).fill(0);
    const b = new Array(128).fill(999);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => jaccardSimilarity([1, 2], [1])).toThrow();
  });
});

describe('near-duplicate detection', () => {
  it('detects identical datasets as near-duplicates', () => {
    const data = [{ apy: 5.2, protocol: 'Aave' }, { apy: 3.1, protocol: 'Compound' }];
    const sig1 = computeMinhash(data);
    const sig2 = computeMinhash(data);
    const sim = jaccardSimilarity(sig1, sig2);
    expect(sim).toBe(1);
  });

  it('detects rephrased copies with high similarity', () => {
    const original = [
      { apy: 5.2, protocol: 'Aave', chain: 'Ethereum', tvl: 1000000 },
      { apy: 3.1, protocol: 'Compound', chain: 'Ethereum', tvl: 500000 },
    ];
    const rephrased = [
      { apy: 5.2, protocol: 'Aave', chain: 'Ethereum', tvl: 1000000 },
      { apy: 3.1, protocol: 'Compound', chain: 'Ethereum', tvl: 500000 },
    ];
    const sig1 = computeMinhash(original);
    const sig2 = computeMinhash(rephrased);
    const sim = jaccardSimilarity(sig1, sig2);
    expect(sim).toBeGreaterThanOrEqual(0.9);
  });

  it('gives low similarity to genuinely different datasets', () => {
    const data1 = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2024-01-${String(i + 1).padStart(2, '0')}`,
      apy: 5 + i * 0.1,
      protocol: `ProtocolAlpha${i}`,
      chain: 'Ethereum',
      category: 'lending',
    }));
    const data2 = Array.from({ length: 20 }, (_, i) => ({
      name: `Wallet ${i}`,
      balance: 100000 + i * 50000,
      chain: 'Solana',
      lastActive: `2024-06-${String(i + 1).padStart(2, '0')}`,
      riskScore: 0.1 + i * 0.05,
    }));
    const sig1 = computeMinhash(data1);
    const sig2 = computeMinhash(data2);
    const sim = jaccardSimilarity(sig1, sig2);
    expect(sim).toBeLessThan(0.5);
  });
});
