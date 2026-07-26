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
});
