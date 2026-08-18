import { describe, it, expect } from 'vitest';
import { computeMinhash, jaccardSimilarity } from '../originality';

describe('deterministic reproducibility', () => {
  it('same data produces same deterministic sub-scores', () => {
    const data = {
      records: Array.from({ length: 30 }, (_, i) => ({
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
        apy: 3 + (i % 10) * 0.5,
        protocol: `Protocol_${i}`,
        chain: 'Ethereum',
        tvl: 1000000 + i * 100000,
      })),
    };

    const sig1 = computeMinhash(data.records);
    const sig2 = computeMinhash(data.records);
    expect(sig1).toEqual(sig2);

    const sim = jaccardSimilarity(sig1, sig2);
    expect(sim).toBe(1);
  });

  it('re-running originality check on unchanged data is deterministic', () => {
    const data1 = [{ a: 1, b: 2, c: 3 }];
    const data2 = [{ a: 1, b: 2, c: 3 }];

    const sig1 = computeMinhash(data1);
    const sig2 = computeMinhash(data2);
    expect(jaccardSimilarity(sig1, sig2)).toBe(1);
  });
});
