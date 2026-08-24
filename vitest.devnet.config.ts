import { defineConfig } from 'vitest/config';

/**
 * Devnet GATE tests: deterministic, offline, free, fast.
 *
 * Per CLAUDE.md's two test lanes, this is the lane that runs on every commit.
 * Nothing here may touch Docker, the network, or the filesystem outside a temp
 * dir — if a test needs a running chain it belongs in vitest.chain.config.ts.
 */
export default defineConfig({
  test: {
    include: ['scripts/devnet/__tests__/**/*.test.ts'],
    testTimeout: 5_000,
    passWithNoTests: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/devnet-gate.xml' },
  },
});
