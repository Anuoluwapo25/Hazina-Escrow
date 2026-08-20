/**
 * Fault injector for Chaos Testing Suite
 * Allows intercepting and failing specific network and DB operations.
 */

export type FaultType = 'timeout' | 'network_error' | 'db_drop' | 'mock_delay';

export interface FaultConfig {
  type: FaultType;
  probability: number; // 0.0 to 1.0
  errorMessage?: string;
  delayMs?: number;
}

export class FaultInjector {
  private activeFaults: Map<string, FaultConfig> = new Map();

  /**
   * Register a fault to be injected at a specific operation point
   * @param operationName e.g., 'stellar_horizon_submit', 'db_write'
   * @param config The fault configuration
   */
  inject(operationName: string, config: FaultConfig) {
    this.activeFaults.set(operationName, config);
  }

  /**
   * Clear all active faults
   */
  clear() {
    this.activeFaults.clear();
  }

  /**
   * Called by the application code (or mock wrappers) to potentially trigger a fault.
   * If the fault triggers, this method throws an error or delays execution.
   */
  async check(operationName: string): Promise<void> {
    const config = this.activeFaults.get(operationName);
    if (!config) return;

    if (Math.random() < config.probability) {
      if (config.type === 'mock_delay' && config.delayMs) {
        await new Promise(r => setTimeout(r, config.delayMs));
      } else if (config.type === 'timeout') {
        throw new Error(config.errorMessage || `Fault injected: Timeout at ${operationName}`);
      } else if (config.type === 'network_error') {
        throw new Error(config.errorMessage || `Fault injected: Network Error at ${operationName}`);
      } else if (config.type === 'db_drop') {
        throw new Error(config.errorMessage || `Fault injected: DB connection dropped at ${operationName}`);
      }
    }
  }
}

// Global singleton for tests
export const faultInjector = new FaultInjector();
