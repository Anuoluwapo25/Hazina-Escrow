# Fee Calculation Invariants

This document describes the invariants and potential divergences between the contract-side and backend-side fee calculations.

## Contract Fee Calculation (src/lib.rs)

The contract calculates fees using integer arithmetic with basis points:

```rust
let calculated_cut = amount * fee_bps / MAX_BASIS_POINTS; // MAX_BASIS_POINTS = 10_000
let platform_cut = 
    if calculated_cut == 0 && amount > 0 && fee_bps > 0 {
        1
    } else {
        calculated_cut
    };
let seller_cut = amount - platform_cut;
```

Key characteristics:
- Uses integer division (truncates toward zero)
- Implements a "min-1-stroop rule": when the fee calculation would result in zero but the amount and fee are both positive, the platform fee is set to 1 stroop
- Platform fee + seller fee = original amount (conservation property)

## Backend Fee Calculation (src/common/constants.ts)

The backend calculates fees using floating-point arithmetic with specific rounding:

```typescript
export const PLATFORM_FEE_RATE = parseFloat(process.env.PLATFORM_FEE_RATE ?? '0.05'); // Default 0.05 (5%)
export const SELLER_PAYOUT_RATE = 1 - PLATFORM_FEE_RATE;

export function platformFee(pricePerQuery: number): number {
    return parseFloat((pricePerQuery * PLATFORM_FEE_RATE).toFixed(4)); // Rounded to 4 decimals
}

export function sellerShare(pricePerQuery: number): number {
    return parseFloat((pricePerQuery * SELLER_PAYOUT_RATE).toFixed(7)); // Rounded to 7 decimals
}
```

Key characteristics:
- Uses floating-point multiplication
- Platform fee rounded to 4 decimal places
- Seller share rounded to 7 decimal places
- Due to separate rounding, platform_fee + seller_share may not exactly equal pricePerQuery

## Points of Divergence

### 1. Precision Differences
- Contract: Integer arithmetic with basis points (1/100th of a percent)
- Backend: Floating-point with decimal rounding

### 2. Minimum Fee Rule
- Contract: Implements min-1-stroop rule to ensure non-zero fees when amount > 0 and fee_bps > 0
- Backend: No equivalent minimum fee rule; very small fees may round to zero

### 3. Rounding Behavior
- Contract: Truncation via integer division
- Backend: Specific decimal place rounding (4 for platform fee, 7 for seller share)

### 4. Conservation Property
- Contract: Platform fee + seller fee = original amount (by construction)
- Backend: Due to independent rounding, platform_fee + seller_share may differ from pricePerQuery

## Test Results

See the test suite for specific quantified differences across input grids.

## Recommendations

1. For critical financial calculations, consider aligning the precision and rounding strategies
2. Document expected tolerances for UI display vs actual contract execution
3. Monitor the min-1-stroop boundary where contract behavior deviates most from floating-point expectations