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

/** One payee in a `lock_multi` call — mirrors the contract's `SellerShare` struct. */
export interface SellerShareInput {
  seller: string;
  /** Exact stroop amount for this seller — not a basis-points share. */
  amount: number | bigint;
}

/**
 * Encode a single `SellerShare { seller: Address, amount: i128 }` struct.
 * Field order in the input object doesn't matter — `nativeToScVal` sorts map
 * entries by the symbol key, not by insertion order, matching how the
 * contract's `#[contracttype]` struct is serialized on-chain.
 */
export function sellerShareToScVal(share: SellerShareInput): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(
    { seller: share.seller, amount: share.amount },
    { type: { seller: ['symbol', 'address'], amount: ['symbol', 'i128'] } },
  );
}

/** Encode a Soroban `Vec<SellerShare>` argument for `lock_multi`. */
export function sellerSharesToScVal(shares: SellerShareInput[]): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec(shares.map(sellerShareToScVal));
}

/** Encode a Soroban `Vec<String>` argument (e.g. `lock_multi`'s dataset ids). */
export function stringsToScVal(values: string[]): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec(values.map(stringToScVal));
}

/** Encode a Soroban `Vec<u64>` argument (e.g. `release_multi`'s escrow ids). */
export function u64sToScVal(values: Array<number | bigint>): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec(values.map(u64ToScVal));
}
