import { MINHASH_NUM_PERM } from './types';

const BASE_HASH = 0x9747b28c;
const MAX_HASH = 0xffffffff;

function createHashers(numPerms: number): Array<(val: string) => number> {
  const hashers: Array<(val: string) => number> = [];
  for (let i = 0; i < numPerms; i++) {
    const a = ((BASE_HASH * (i + 1) + 0x6d2b79f5) | 0) >>> 0;
    const b = (((i + 1) * 13397 + 0xab41bad1) | 0) >>> 0;
    hashers.push((val: string) => {
      let hash = 0;
      for (let j = 0; j < val.length; j++) {
        hash = ((hash << 5) - hash + val.charCodeAt(j)) | 0;
      }
      const h = (((a * hash + b) | 0) >>> 0) % (MAX_HASH + 1);
      return h;
    });
  }
  return hashers;
}

const hashers = createHashers(MINHASH_NUM_PERM);

function shingle(text: string, k: number = 3): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (normalized.length < k) return [normalized];
  const shingles: string[] = [];
  for (let i = 0; i <= normalized.length - k; i++) {
    shingles.push(normalized.slice(i, i + k));
  }
  return shingles;
}

function canonicalize(records: Record<string, unknown>[]): string {
  return records
    .map(r => JSON.stringify(r, Object.keys(r).sort()))
    .sort()
    .join('\n');
}

export function computeMinhash(records: Record<string, unknown>[]): number[] {
  const canonical = canonicalize(records);
  const shingles = shingle(canonical);

  const signature = new Array(MINHASH_NUM_PERM).fill(MAX_HASH);

  for (const shingle of shingles) {
    for (let i = 0; i < hashers.length; i++) {
      const hasher = hashers[i];
      if (!hasher) continue;
      const h = hasher(shingle);
      if (h < signature[i]) {
        signature[i] = h;
      }
    }
  }

  return signature;
}

export function jaccardSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Signature lengths must match');
  }
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}
