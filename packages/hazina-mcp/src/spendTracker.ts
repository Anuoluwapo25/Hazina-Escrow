/**
 * spendTracker.ts — server-side spend-limit enforcement and the purchase log
 * backing get_purchase_history (#593: "spending controls are the hard part
 * and must not be an afterthought").
 *
 * One instance lives for the lifetime of the MCP server process — the
 * "session" the per-session cap refers to.
 */

export interface SpendLogEntry {
  datasetId: string;
  amount: number;
  txHash: string;
  demo: boolean;
  timestamp: string;
}

export class SpendLimitError extends Error {
  constructor(
    message: string,
    public readonly limit: 'per-call' | 'per-session',
  ) {
    super(message);
    this.name = 'SpendLimitError';
  }
}

export class SpendTracker {
  private readonly log: SpendLogEntry[] = [];
  private sessionTotal = 0;

  constructor(
    private readonly maxSpendPerCall: number,
    private readonly maxSpendPerSession: number,
  ) {}

  /** Throws SpendLimitError when `amount` would breach either cap. Call before spending. */
  assertWithinLimits(amount: number): void {
    if (amount > this.maxSpendPerCall) {
      throw new SpendLimitError(
        `This purchase costs ${amount} USDC, over the per-call limit of ${this.maxSpendPerCall} USDC. ` +
          `Choose a cheaper dataset, or ask the user to raise HAZINA_MCP_MAX_SPEND_PER_CALL.`,
        'per-call',
      );
    }
    const projectedTotal = this.sessionTotal + amount;
    if (projectedTotal > this.maxSpendPerSession) {
      throw new SpendLimitError(
        `This purchase (${amount} USDC) would bring session spend to ${projectedTotal.toFixed(4)} USDC, ` +
          `over the session limit of ${this.maxSpendPerSession} USDC ` +
          `(already spent ${this.sessionTotal.toFixed(4)} USDC this session). ` +
          `Ask the user to raise HAZINA_MCP_MAX_SPEND_PER_SESSION, or start a new session.`,
        'per-session',
      );
    }
  }

  /** Record a completed purchase. Call only after the payment actually succeeded. */
  record(entry: Omit<SpendLogEntry, 'timestamp'>): SpendLogEntry {
    const full: SpendLogEntry = { ...entry, timestamp: new Date().toISOString() };
    this.log.push(full);
    this.sessionTotal += entry.amount;
    return full;
  }

  getLog(): SpendLogEntry[] {
    return [...this.log];
  }

  findByTxHash(txHash: string): SpendLogEntry | undefined {
    return this.log.find(entry => entry.txHash === txHash);
  }

  getSessionTotal(): number {
    return this.sessionTotal;
  }
}
