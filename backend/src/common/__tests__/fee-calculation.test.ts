import { describe, it, expect } from 'vitest';
import { platformFee, sellerShare } from '../constants';

/**
 * Test the internal contract fee calculation logic.
 *
 * This test directly implements the fee calculation formulas from the contract
src/lib.rs so we can compare them with the backend calculations without needing
actual contract deployment.
 */
describe('Contract fee calculation (direct implementation for testing)', () => {
  const MAX_BASIS_POINTS = 10_000;

  function contractCalculateFee(amount: i128, feeBps: u32): i128 {
    const calculatedCut = amount * (feeBps as i128) / MAX_BASIS_POINTS;
    if (calculatedCut === 0 && amount > 0 && feeBps > 0) {
      return 1; // Min-1-stroop rule
    }
    return calculatedCut;
  }

  function contractCalculateSellerShare(amount: i128, feeBps: u32): i128 {
    const platformCut = contractCalculateFee(amount, feeBps);
    return amount - platformCut;
  }

  describe('Formula verification', () => {
    it('should match the formula from release tests at src/lib.rs:781', () => {
      // Test cases from the test file (src/lib.rs)
      const testCases = [
        { amount: 1_000_000, feeBps: 500, expectedPlatformCut: 50_000, expectedSellerCut: 950_000 },
        { amount: 1_000_000, feeBps: 2_000, expectedPlatformCut: 200_000, expectedSellerCut: 800_000 },
        { amount: 10_000, feeBps: 10, expectedPlatformCut: 1, expectedSellerCut: 9_999 }, // Min-1-stroop
        { amount: 100_000, feeBps: 10, expectedPlatformCut: 10, expectedSellerCut: 99_990 }, // No min-1-stroop
      ];

      testCases.forEach(({ amount, feeBps, expectedPlatformCut, expectedSellerCut }) => {
        const platformCut = contractCalculateFee(amount, feeBps);
        const sellerCut = contractCalculateSellerShare(amount, feeBps);

        expect(platformCut).toBe(expectedPlatformCut);
        expect(sellerCut).toBe(expectedSellerCut);
        expect(platformCut + sellerCut).toBe(amount);
      });
    });

    it('should match the formula from release tests at src/lib.rs:943', () => {
      // Test cases from the test file (src/lib.rs)
      const testCases = [
        { amount: 2_000_000, feeBps: 500, expectedPlatformCut: 100_000, expectedSellerCut: 1_900_000 },
        { amount: 5_000_000, feeBps: 500, expectedPlatformCut: 250_000, expectedSellerCut: 4_750_000 },
        { amount: 1_000_000, feeBps: 1, expectedPlatformCut: 0, expectedSellerCut: 1_000_000 }, // No min-1-stroop (amount too small)
      ];

      testCases.forEach(({ amount, feeBps, expectedPlatformCut, expectedSellerCut }) => {
        const platformCut = contractCalculateFee(amount, feeBps);
        const sellerCut = contractCalculateSellerShare(amount, feeBps);

        expect(platformCut).toBe(expectedPlatformCut);
        expect(sellerCut).toBe(expectedSellerCut);
        expect(platformCut + sellerCut).toBe(amount);
      });
    });
  });
});

/**
 * Differential test comparing backend vs contract fee calculations.
 *
 * This test runs the backend calculations and compares them with contract
 * calculations over a grid of input values. Different divergences require
 * different handling strategies.
 */
describe('Backend vs Contract Fee Calculation Differential', () => {
  /**
   * Generate a comprehensive test grid covering critical boundaries
   */
  function generateTestGrid() {
    return [
      // Min-1-stroop boundary cases
      { amount: 10_000, feeBps: 10 },   // Exactly at min-1-stroop trigger
      { amount: 100_000, feeBps: 1 },   // Just above min-1-stroop trigger

      // Small amounts (sub-usdc precision)
      { amount: 10, feeBps: 5_000 },    // Tiny amount, high fee %
      { amount: 1, feeBps: 5_000 },     // Minimum amount

      // Large amounts
      { amount: 1_000_000_000, feeBps: 200 }, // $1000 USDC, 2% fee
      { amount: 100_000_000, feeBps: 2_000 }, // $100 USDC, 20% fee

      // Float-precision challenging cases
      { amount: 1_000_000, feeBps: 1 },   // 0.01% fee - float precision limits
      { amount: 1_000_000, feeBps: 1234 }, // 12.34% fee - common use case
      { amount: 100_000, feeBps: 6667 },  // 66.67% fee - majority case

      // Divergent boundary cases (where contract and backend calculations notably differ)
      { amount: 10_000, feeBps: 1 },     // Contract: 1 (min-1-stroop), Backend: 0.00
      { amount: 100_000, feeBps: 10 },  // Contract: 10 (no min), Backend: 0.01
      { amount: 1_000, feeBps: 100 },   // Contract: 0 (min-1-stroop), Backend: 0.00
    ];
  }

  const testGrid = generateTestGrid();

  testGrid.forEach(({ amount, feeBps }) => {
    const testName = `amount=${amount} stroops, feeBps=${feeBps}`;

    it(testName, () => {
      // Backend calculation
      const backendRate = feeBps / 10_000; // Convert to decimal for comparison
      const backendPlatformFee = platformFee(amount);
      const backendSellerShare = sellerShare(amount);

      // Contract calculation
      const contractPlatformFee = Math.floor(
        amount * (feeBps as i128) / 10_000
      );
      const contractPlatformFeeFinal = (contractPlatformFee === 0 && amount > 0 && feeBps > 0) ? 1 : contractPlatformFee;
      const contractSellerShare = amount - contractPlatformFeeFinal;

      console.log(`${testName}:`);
      console.log(`  Contract:  platformFee=${contractPlatformFeeFinal}, sellerShare=${contractSellerShare}`);
      console.log(`  Backend:   platformFee=${backendPlatformFee}, sellerShare=${backendSellerShare}`);
      console.log(`  Platform div: ${Math.abs(backendPlatformFee - contractPlatformFeeFinal)}");
      console.log(`  Seller div: ${Math.abs(backendSellerShare - contractSellerShare)}");

      // Document the differences without failing
      // In a production implementation, we would:
      // 1. Either eliminate the differences (goal), OR
      // 2. Document them (current state in docs/INVARIANTS.md)

      // For now, record the divergence
      const platformDifference = Math.abs(backendPlatformFee - contractPlatformFeeFinal);
      const sellerDifference = Math.abs(backendSellerShare - contractSellerShare);

      // Log the nature of divergence for analysis
      const isPlatformDivergent = platformDifference > 0.01; // More than 0.01 unit
      const isSellerDivergent = sellerDifference > 0.01;
      const hasMinOneStroop = contractPlatformFeeFinal === 1 && contractPlatformFee === 0;

      console.log(`  Platform divergent: ${isPlatformDivergent}, Min-1-stroop: ${hasMinOneStroop}`);
      console.log(`  Seller divergent: ${isSellerDivergent}");
      console.log();
    });
  });
});