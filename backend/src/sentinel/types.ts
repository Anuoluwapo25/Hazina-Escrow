/**
 * types.ts — shared shapes for the Sentinel escrow-contract watcher.
 *
 * Kept dependency-free (no Stellar SDK imports) so invariant modules and
 * their tests never need a live RPC connection or network mocking — they
 * only ever see these plain, decoded shapes.
 */

/** The topic (first element of `env.events().publish((topic,), value)`) for every event the contract emits. */
export type SentinelEventTopic =
  | 'locked'
  | 'released'
  | 'refunded'
  | 'claimed'
  | 'confirm'
  | 'disp_up'
  | 'disp_res'
  | 'paused'
  | 'unpaused'
  | 'fee_upd'
  | 'dsf_upd'
  | 'dsf_clr'
  | 'treasury'
  | 'admin'
  | 'wl_mode'
  | 'addr_wl'
  | 'addr_bl'
  | 'cb_amt'
  | 'cb_rate'
  | 'arbit'
  | 'emerg_wd';

/** One decoded contract event, already stripped of raw XDR. */
export interface SentinelEvent {
  /** Soroban RPC event id — unique, monotonic within a ledger. */
  id: string;
  topic: SentinelEventTopic;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  /** Opaque paging token — this is what the persisted cursor stores. */
  pagingToken: string;
  /** The decoded event payload tuple, in the order the contract publishes it. */
  data: unknown[];
}

export type SentinelAlertSeverity = 'critical' | 'high' | 'medium';

/**
 * What an invariant evaluator produces — the alert router fills in the rest
 * (id, timestamps). Dedupe key is `${invariant}:${escrowId ?? dedupeSuffix ?? 'global'}`:
 *   - escrow-lifecycle invariants (release conservation, delivery record, ...)
 *     key by escrowId, since a given escrow can only trigger them once.
 *   - "any occurrence" invariants (pause, admin change, ...) set dedupeSuffix
 *     to the triggering event's stable id, so a restart-replay of the same
 *     event collapses but two genuinely different occurrences don't.
 *   - purely timer-based invariants (solvency, stream stall, ...) leave both
 *     unset — the condition persists across ticks, so 'global' is correct
 *     and the suppression window controls re-notification cadence.
 */
export interface RaisedAlert {
  invariant: string;
  severity: SentinelAlertSeverity;
  escrowId?: number;
  dedupeSuffix?: string;
  txHash?: string;
  ledger?: number;
  message: string;
  details?: Record<string, unknown>;
}

/** One open escrow, as read from the contract (or reconstructed from events). */
export interface OpenEscrow {
  escrowId: number;
  token: string;
  amount: bigint;
  deadline: number;
  released: boolean;
  refunded: boolean;
}

/** Ground-truth reads the invariant evaluators need, injected so tests can fake them. */
export interface EscrowReader {
  getEscrowCount(): Promise<number>;
  /** Returns null for an id the contract has no record of (should never happen post-lock). */
  getEscrow(escrowId: number): Promise<{
    token: string;
    amount: bigint;
    deadline: number;
    released: boolean;
    refunded: boolean;
  } | null>;
  /** SAC `balance(contract_address)` for one token contract address. */
  getTokenBalance(tokenAddress: string): Promise<bigint>;
  /** sha256 hex of the contract's current WASM — used to detect `upgrade()`, which emits no event. */
  getContractWasmHash(): Promise<string>;
  getLatestLedger(): Promise<number>;
}

/** One page of the event stream. `cursor` is the paging token to resume from. */
export interface EventPage {
  events: SentinelEvent[];
  cursor: string;
  latestLedger: number;
}

/** Fetches contract events; the only I/O boundary the ingestion loop depends on. */
export interface EventSource {
  /**
   * Fetch the next page after `cursor`, or starting at `startLedger` when no
   * cursor exists yet. Both may be omitted to mean "from the earliest ledger
   * the backend still retains events for".
   */
  getPage(params: { cursor?: string; startLedger?: number; limit: number }): Promise<EventPage>;
}

/**
 * The only state that must survive a Sentinel restart. Every invariant
 * evaluator reads ground truth live (get_escrow/get_escrow_count/balance)
 * rather than from a locally materialized escrow index, so this is it —
 * where ingestion left off, and the last-observed values the two
 * comparison-based timer checks (stream stall, upgrade watch) diff against.
 */
export interface SentinelCursorState {
  cursor: string | null;
  lastLedger: number;
  lastProgressAt: string;
  lastWasmHash: string | null;
}

export interface CursorStore {
  load(): Promise<SentinelCursorState | null>;
  save(update: Partial<SentinelCursorState>): Promise<SentinelCursorState>;
}
