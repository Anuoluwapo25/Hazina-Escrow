import { faultInjector } from './inject';
import { validateInvariants } from './invariants';
import { processPayment, processEscrowPayment } from '../../src/payments/payments.service';

/**
 * Executes a function with a given fault configuration, then validates invariants.
 */
export async function runChaosScenario(
  name: string,
  scenarioFn: () => Promise<void>,
  faults: Array<{ operation: string; probability: number; type: 'timeout' | 'network_error' | 'db_drop' | 'mock_delay' }>
) {
  console.log(`\n--- Running Chaos Scenario: ${name} ---`);
  
  // Register faults
  faultInjector.clear();
  for (const f of faults) {
    faultInjector.inject(f.operation, { type: f.type, probability: f.probability });
  }

  try {
    await scenarioFn();
    console.log(`Scenario ${name} completed (possibly with expected errors)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Scenario ${name} threw (expected): ${msg}`);
  } finally {
    faultInjector.clear();
  }
}

/**
 * Example Chaos Scenarios (for use in a test runner or manual script)
 */
export async function runAllScenarios(datasetId: string) {
  
  // Scenario 1: Horizon Timeout + Retry
  await runChaosScenario(
    'Horizon Timeout + Retry',
    async () => {
      // Assuming a mock transaction is set up in DB
      try {
        await processPayment({
          txHash: 'chaos-timeout-tx',
          datasetId,
          memo: 'test-memo-123'
        });
      } catch (e) {
        // App might throw timeout, then we retry
        await processPayment({
          txHash: 'chaos-timeout-tx',
          datasetId,
          memo: 'test-memo-123'
        });
      }
      await validateInvariants(datasetId);
    },
    [{ operation: 'stellar_horizon_submit', probability: 0.5, type: 'timeout' }]
  );

  // Scenario 2: Concurrent same-txHash requests (Double spend attempt)
  await runChaosScenario(
    'Concurrent same-txHash requests',
    async () => {
      await Promise.allSettled([
        processPayment({ txHash: 'chaos-concurrent-tx', datasetId, memo: 'memo2' }),
        processPayment({ txHash: 'chaos-concurrent-tx', datasetId, memo: 'memo2' }),
        processPayment({ txHash: 'chaos-concurrent-tx', datasetId, memo: 'memo2' }),
      ]);
      await validateInvariants(datasetId);
    },
    [{ operation: 'db_read_tx', probability: 0.3, type: 'mock_delay' }] // Mock delays read to encourage race condition
  );

  // Scenario 3: DB Drop Mid-Delivery
  await runChaosScenario(
    'DB Drop Mid-Delivery',
    async () => {
      try {
        await processEscrowPayment({ escrowId: 999, datasetId });
      } catch (e) {
        // Retry
        await processEscrowPayment({ escrowId: 999, datasetId });
      }
      await validateInvariants(datasetId);
    },
    [{ operation: 'db_update_tx', probability: 0.2, type: 'db_drop' }]
  );
  
}
