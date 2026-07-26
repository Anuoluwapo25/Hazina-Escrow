/**
 * scval.ts — small typed helpers for converting native JS values to/from the
 * Soroban ScVal types the Hazina escrow contract expects. Centralising these
 * avoids re-deriving the right `nativeToScVal` shape at every call site.
 */

import * as StellarSdk from '@stellar/stellar-sdk';

/** Encode a Soroban `u64` argument (e.g. an escrow id). */
export function u64ToScVal(value: number | bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: 'u64' });
}

/** Encode a Soroban `u32` argument (e.g. a basis-points fee). */
export function u32ToScVal(value: number): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: 'u32' });
}

/** Encode a Soroban `i128` argument (e.g. a token amount in stroops). */
export function i128ToScVal(value: number | bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: 'i128' });
}

/** Encode a Stellar G… or C… address as a Soroban `Address` argument. */
export function addressToScVal(address: string): StellarSdk.xdr.ScVal {
  return new StellarSdk.Address(address).toScVal();
}

/** Encode a Soroban `String` argument (e.g. a dataset id). */
export function stringToScVal(value: string): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: 'string' });
}

/** Encode a Soroban `bool` argument. */
export function boolToScVal(value: boolean): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: 'bool' });
}

/** Decode any ScVal back into a plain JS value. */
export function scValToNative<T = unknown>(scVal: StellarSdk.xdr.ScVal): T {
  return StellarSdk.scValToNative(scVal) as T;
}
