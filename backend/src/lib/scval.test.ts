import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  u64ToScVal,
  u32ToScVal,
  i128ToScVal,
  addressToScVal,
  stringToScVal,
  boolToScVal,
  scValToNative,
  sellerShareToScVal,
  sellerSharesToScVal,
  stringsToScVal,
  u64sToScVal,
} from './scval';

describe('scval', () => {
  it('round-trips u64 values, including bigint precision beyond Number.MAX_SAFE_INTEGER', () => {
    expect(scValToNative<bigint>(u64ToScVal(7))).toBe(7n);
    expect(scValToNative<bigint>(u64ToScVal(0))).toBe(0n);
    const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(scValToNative<bigint>(u64ToScVal(big))).toBe(big);
  });

  it('round-trips u32 values', () => {
    expect(scValToNative<number>(u32ToScVal(500))).toBe(500);
    expect(scValToNative<number>(u32ToScVal(0))).toBe(0);
  });

  it('round-trips i128 values, including bigint amounts', () => {
    expect(scValToNative<bigint>(i128ToScVal(10_000_000))).toBe(10_000_000n);
    expect(scValToNative<bigint>(i128ToScVal(-1))).toBe(-1n);
    expect(scValToNative<bigint>(i128ToScVal(1_000_000_000_000n))).toBe(1_000_000_000_000n);
  });

  it('round-trips a Stellar G-address', () => {
    const address = Keypair.random().publicKey();
    expect(scValToNative<string>(addressToScVal(address))).toBe(address);
  });

  it('round-trips a Soroban contract C-address', () => {
    const address = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
    expect(scValToNative<string>(addressToScVal(address))).toBe(address);
  });

  it('throws for a malformed address instead of silently encoding garbage', () => {
    expect(() => addressToScVal('not-a-real-address')).toThrow();
  });

  it('round-trips string values, including empty and unicode', () => {
    expect(scValToNative<string>(stringToScVal('ds-abc-123'))).toBe('ds-abc-123');
    expect(scValToNative<string>(stringToScVal(''))).toBe('');
    expect(scValToNative<string>(stringToScVal('café ☕'))).toBe('café ☕');
  });

  it('round-trips bool values', () => {
    expect(scValToNative<boolean>(boolToScVal(true))).toBe(true);
    expect(scValToNative<boolean>(boolToScVal(false))).toBe(false);
  });

  describe('sellerShareToScVal', () => {
    it('round-trips a single SellerShare struct', () => {
      const seller = Keypair.random().publicKey();
      const decoded = scValToNative<{ seller: string; amount: bigint }>(
        sellerShareToScVal({ seller, amount: 1_000_000 }),
      );
      expect(decoded.seller).toBe(seller);
      expect(decoded.amount).toBe(1_000_000n);
    });

    it('preserves large i128 amounts as bigint with no precision loss', () => {
      const seller = Keypair.random().publicKey();
      const amount = 1_000_000_000_000n;
      const decoded = scValToNative<{ seller: string; amount: bigint }>(
        sellerShareToScVal({ seller, amount }),
      );
      expect(decoded.amount).toBe(amount);
    });

    it('encodes to the same struct regardless of which field is listed first in the input', () => {
      const seller = Keypair.random().publicKey();
      const a = sellerShareToScVal({ seller, amount: 42 });
      const b = sellerShareToScVal({ amount: 42, seller } as { seller: string; amount: number });
      expect(a.toXDR('base64')).toBe(b.toXDR('base64'));
    });
  });

  describe('sellerSharesToScVal', () => {
    it('round-trips an empty Vec<SellerShare>', () => {
      expect(scValToNative<unknown[]>(sellerSharesToScVal([]))).toEqual([]);
    });

    it('round-trips a multi-element Vec<SellerShare>, preserving order', () => {
      const shares: { seller: string; amount: number }[] = [
        { seller: Keypair.random().publicKey(), amount: 100 },
        { seller: Keypair.random().publicKey(), amount: 200 },
        { seller: Keypair.random().publicKey(), amount: 300 },
      ];
      const decoded = scValToNative<{ seller: string; amount: bigint }[]>(
        sellerSharesToScVal(shares),
      );
      expect(decoded).toHaveLength(3);
      decoded.forEach((entry, i) => {
        const expected = shares[i];
        if (!expected) throw new Error(`Expected a fixture share at index ${i}`);
        expect(entry.seller).toBe(expected.seller);
        expect(entry.amount).toBe(BigInt(expected.amount));
      });
    });
  });

  describe('stringsToScVal', () => {
    it('round-trips an empty Vec<String>', () => {
      expect(scValToNative<string[]>(stringsToScVal([]))).toEqual([]);
    });

    it('round-trips a Vec<String>, preserving order and duplicates', () => {
      const ids = ['ds-001', 'ds-002', 'ds-001'];
      expect(scValToNative<string[]>(stringsToScVal(ids))).toEqual(ids);
    });
  });

  describe('u64sToScVal', () => {
    it('round-trips a Vec<u64> as bigints, preserving order', () => {
      const ids = [0, 1, 7, 999_999];
      const decoded = scValToNative<bigint[]>(u64sToScVal(ids));
      expect(decoded).toEqual(ids.map(BigInt));
    });
  });
});
