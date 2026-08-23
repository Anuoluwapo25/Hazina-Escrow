import { defineConfig } from 'vitest/config';

/**
 * On-chain e2e suite. Slow, stateful, requires a running devnet — deliberately
 * NOT part of the fast PR lane. Start the network first:
 *
 *   npm run devnet && npm run e2e:chain
 *
 * Serial execution is not a performance concession, it is correctness: these
 * tests share deterministic accounts, so parallel files would race on the same
 * source account's sequence number and produce tx_bad_seq. `fileParallelism:
 * false` plus a single worker makes the ordering explicit rather than emergent.
 */
export default defineConfig({
  test: {
    include: ['test/chain/**/*.e2e.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A chain test that "passes" by silently skipping is worse than a failure.
    passWithNoTests: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/chain-e2e.xml' },
    retry: 0,
  },
});
