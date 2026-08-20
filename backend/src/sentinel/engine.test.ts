import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SentinelAlert } from '../common/storage';

// ── In-memory storage mock (same pattern as payout-retry.service.test.ts) ──

const { alertStore } = vi.hoisted(() => ({ alertStore: new Map<string, SentinelAlert>() }));

vi.mock('../common/storage', () => ({
  addSentinelAlert: vi.fn((alert: SentinelAlert) => {
    alertStore.set(alert.id, alert);
    return Promise.resolve();
  }),
  getSentinelAlertByDedupeKey: vi.fn((dedupeKey: string) =>
    Promise.resolve([...alertStore.values()].find(a => a.dedupeKey === dedupeKey)),
  ),
  updateSentinelAlert: vi.fn((id: string, updates: Partial<SentinelAlert>) => {
    const existing = alertStore.get(id);
    if (!existing) return Promise.resolve(null);
    const merged = { ...existing, ...updates } as SentinelAlert;
    alertStore.set(id, merged);
    return Promise.resolve(merged);
  }),
  getOpenSentinelAlerts: vi.fn(() =>
    Promise.resolve([...alertStore.values()].filter(a => a.status === 'open')),
  ),
  getAllSentinelAlerts: vi.fn(() => Promise.resolve([...alertStore.values()])),
}));

import { SentinelEngine, type SentinelEngineDeps } from './engine';
import type {
  CursorStore,
  EscrowReader,
  EventPage,
  EventSource,
  SentinelCursorState,
  SentinelEvent,
} from './types';
import type { AlertChannel } from './alerts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_A = 'CTOKENA00000000000000000000000000000000000000000000000000000';
const SELLER = 'GSELLER0000000000000000000000000000000000000000000000000';
const BUYER = 'GBUYER00000000000000000000000000000000000000000000000000';
const ADMIN = 'GADMIN00000000000000000000000000000000000000000000000000';

function ev(
  partial: Partial<SentinelEvent> & Pick<SentinelEvent, 'topic' | 'data'>,
): SentinelEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    ledger: 100,
    ledgerClosedAt: new Date().toISOString(),
    txHash: `tx-${Math.random().toString(36).slice(2)}`,
    pagingToken: `${100}-0`,
    ...partial,
  };
}

/** Fixed-page fake EventSource: serves one static list of events, paginating by cursor index. */
class FixtureEventSource implements EventSource {
  constructor(
    private events: SentinelEvent[],
    private latestLedger: number,
  ) {}

  async getPage({ cursor, limit }: { cursor?: string; limit: number }): Promise<EventPage> {
    const startIdx = cursor ? Number(cursor) : 0;
    const page = this.events.slice(startIdx, startIdx + limit);
    const nextIdx = startIdx + page.length;
    return { events: page, cursor: String(nextIdx), latestLedger: this.latestLedger };
  }
}

interface FixtureEscrowRecord {
  token: string;
  amount: bigint;
  deadline: number;
  released: boolean;
  refunded: boolean;
}

class FixtureEscrowReader implements EscrowReader {
  constructor(
    public escrows: Map<number, FixtureEscrowRecord>,
    public balances: Map<string, bigint>,
    public latestLedger = 100,
    public wasmHash = 'wasm-hash-v1',
  ) {}

  async getEscrowCount() {
    return this.escrows.size === 0 ? 0 : Math.max(...this.escrows.keys()) + 1;
  }
  async getEscrow(escrowId: number) {
    return this.escrows.get(escrowId) ?? null;
  }
  async getTokenBalance(tokenAddress: string) {
    return this.balances.get(tokenAddress) ?? 0n;
  }
  async getContractWasmHash() {
    return this.wasmHash;
  }
  async getLatestLedger() {
    return this.latestLedger;
  }
}

class InMemoryCursorStore implements CursorStore {
  constructor(private state: SentinelCursorState | null = null) {}
  async load() {
    return this.state;
  }
  async save(update: Partial<SentinelCursorState>) {
    this.state = {
      cursor: this.state?.cursor ?? null,
      lastLedger: this.state?.lastLedger ?? 0,
      lastProgressAt: this.state?.lastProgressAt ?? new Date(0).toISOString(),
      lastWasmHash: this.state?.lastWasmHash ?? null,
      ...update,
    };
    return this.state;
  }
  snapshot(): SentinelCursorState | null {
    return this.state;
  }
}

class RecordingChannel implements AlertChannel {
  name = 'recording';
  dispatched: SentinelAlert[] = [];
  async dispatch(alert: SentinelAlert) {
    this.dispatched.push(alert);
  }
}

function makeDeps(overrides: Partial<SentinelEngineDeps> = {}): {
  deps: SentinelEngineDeps;
  channel: RecordingChannel;
  cursorStore: InMemoryCursorStore;
} {
  const channel = new RecordingChannel();
  const cursorStore = overrides.cursorStore
    ? (overrides.cursorStore as InMemoryCursorStore)
    : new InMemoryCursorStore();
  const deps: SentinelEngineDeps = {
    eventSource: new FixtureEventSource([], 100),
    reader: new FixtureEscrowReader(new Map(), new Map()),
    cursorStore,
    channels: [channel],
    hasDeliveryRecord: async () => true,
    startLedger: 0,
    pageLimit: 100,
    stallThresholdSeconds: 120,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  return { deps, channel, cursorStore };
}

beforeEach(() => {
  alertStore.clear();
});

describe('SentinelEngine — event-based invariants (one violation each)', () => {
  it('fires a high alert on pause', async () => {
    const source = new FixtureEventSource([ev({ topic: 'paused', data: [ADMIN] })], 100);
    const { deps, channel } = makeDeps({ eventSource: source });
    const engine = new SentinelEngine(deps);

    await engine.processNextBatch();

    expect(channel.dispatched).toHaveLength(1);
    expect(channel.dispatched[0]).toMatchObject({ invariant: 'pause_state', severity: 'high' });
  });

  it('fires a critical alert on emergency_withdraw', async () => {
    const source = new FixtureEventSource(
      [ev({ topic: 'emerg_wd', data: [TOKEN_A, ADMIN, '1000000'] })],
      100,
    );
    const { deps, channel } = makeDeps({ eventSource: source });
    await new SentinelEngine(deps).processNextBatch();

    expect(channel.dispatched).toHaveLength(1);
    expect(channel.dispatched[0]).toMatchObject({
      invariant: 'admin_action',
      severity: 'critical',
    });
  });

  it('fires a critical alert on transfer_admin/set_admin', async () => {
    const source = new FixtureEventSource([ev({ topic: 'admin', data: [ADMIN] })], 100);
    const { deps, channel } = makeDeps({ eventSource: source });
    await new SentinelEngine(deps).processNextBatch();

    expect(channel.dispatched).toHaveLength(1);
    expect(channel.dispatched[0]).toMatchObject({
      invariant: 'admin_action',
      severity: 'critical',
    });
  });

  it('fires a high alert when a fee is set outside the configured band', async () => {
    process.env.SENTINEL_FEE_BAND_MIN_BPS = '0';
    process.env.SENTINEL_FEE_BAND_MAX_BPS = '2000';
    const source = new FixtureEventSource([ev({ topic: 'fee_upd', data: [ADMIN, 5000] })], 100);
    const { deps, channel } = makeDeps({ eventSource: source });
    await new SentinelEngine(deps).processNextBatch();

    expect(channel.dispatched).toHaveLength(1);
    expect(channel.dispatched[0]).toMatchObject({ invariant: 'fee_band', severity: 'high' });
    delete process.env.SENTINEL_FEE_BAND_MIN_BPS;
    delete process.env.SENTINEL_FEE_BAND_MAX_BPS;
  });

  it('does not alert when a fee change stays inside the band', async () => {
    const source = new FixtureEventSource([ev({ topic: 'fee_upd', data: [ADMIN, 500] })], 100);
    const { deps, channel } = makeDeps({ eventSource: source });
    await new SentinelEngine(deps).processNextBatch();

    expect(channel.dispatched).toHaveLength(0);
  });

  it('fires a critical alert when a release does not conserve the locked amount', async () => {
    const escrows = new Map([
      [
        1,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: 9999999999,
          released: true,
          refunded: false,
        },
      ],
    ]);
    const source = new FixtureEventSource(
      [ev({ topic: 'released', data: [1, SELLER, '400000', '400000'] })], // sums to 800_000, not 1_000_000
      100,
    );
    const { deps, channel } = makeDeps({
      eventSource: source,
      reader: new FixtureEscrowReader(escrows, new Map()),
    });
    await new SentinelEngine(deps).processNextBatch();

    const relevant = channel.dispatched.filter(a => a.invariant === 'release_conservation');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toMatchObject({ severity: 'critical', escrowId: 1 });
  });

  it('does not alert when a release correctly conserves the locked amount', async () => {
    const escrows = new Map([
      [
        1,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: 9999999999,
          released: true,
          refunded: false,
        },
      ],
    ]);
    const source = new FixtureEventSource(
      [ev({ topic: 'released', data: [1, SELLER, '950000', '50000'] })],
      100,
    );
    const { deps, channel } = makeDeps({
      eventSource: source,
      reader: new FixtureEscrowReader(escrows, new Map()),
    });
    await new SentinelEngine(deps).processNextBatch();

    expect(channel.dispatched.filter(a => a.invariant === 'release_conservation')).toHaveLength(0);
  });

  it('fires a critical alert when a release/refund/claim references an unknown escrow', async () => {
    const source = new FixtureEventSource(
      [ev({ topic: 'refunded', data: [42, BUYER, '1000000'] })],
      100,
    );
    const { deps, channel } = makeDeps({
      eventSource: source,
      reader: new FixtureEscrowReader(new Map(), new Map()), // no escrow #42 on record
    });
    await new SentinelEngine(deps).processNextBatch();

    const relevant = channel.dispatched.filter(a => a.invariant === 'unknown_escrow_settlement');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toMatchObject({ severity: 'critical', escrowId: 42 });
  });

  it('fires a high alert when a release has no backend delivery record', async () => {
    const escrows = new Map([
      [
        1,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: 9999999999,
          released: true,
          refunded: false,
        },
      ],
    ]);
    const source = new FixtureEventSource(
      [ev({ topic: 'released', data: [1, SELLER, '950000', '50000'] })],
      100,
    );
    const { deps, channel } = makeDeps({
      eventSource: source,
      reader: new FixtureEscrowReader(escrows, new Map()),
      hasDeliveryRecord: async () => false,
    });
    await new SentinelEngine(deps).processNextBatch();

    const relevant = channel.dispatched.filter(a => a.invariant === 'delivery_record');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toMatchObject({ severity: 'high', escrowId: 1 });
  });
});

describe('SentinelEngine — timer-based invariants', () => {
  it('fires a critical solvency alert when the on-chain balance is short', async () => {
    const escrows = new Map([
      [
        0,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: 9999999999,
          released: false,
          refunded: false,
        },
      ],
    ]);
    const balances = new Map([[TOKEN_A, 600_000n]]); // short by 400_000
    const { deps, channel } = makeDeps({
      reader: new FixtureEscrowReader(escrows, balances),
    });
    await new SentinelEngine(deps).runTimerChecks();

    const relevant = channel.dispatched.filter(a => a.invariant === 'solvency');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.severity).toBe('critical');
    expect(relevant[0]!.details).toMatchObject({ delta: '-400000' });
  });

  it('does not alert when the on-chain balance covers open liability', async () => {
    const escrows = new Map([
      [
        0,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: 9999999999,
          released: false,
          refunded: false,
        },
      ],
    ]);
    const balances = new Map([[TOKEN_A, 1_000_000n]]);
    const { deps, channel } = makeDeps({ reader: new FixtureEscrowReader(escrows, balances) });
    await new SentinelEngine(deps).runTimerChecks();

    expect(channel.dispatched.filter(a => a.invariant === 'solvency')).toHaveLength(0);
  });

  it('fires a medium alert for an open escrow past its deadline', async () => {
    const pastDeadline = Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000) - 3600;
    const escrows = new Map([
      [
        0,
        {
          token: TOKEN_A,
          amount: 1_000_000n,
          deadline: pastDeadline,
          released: false,
          refunded: false,
        },
      ],
    ]);
    const { deps, channel } = makeDeps({
      reader: new FixtureEscrowReader(escrows, new Map([[TOKEN_A, 1_000_000n]])),
    });
    await new SentinelEngine(deps).runTimerChecks();

    const relevant = channel.dispatched.filter(a => a.invariant === 'expiry_without_claim');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toMatchObject({ severity: 'medium', escrowId: 0 });
  });

  it('fires a high alert when the ledger stalls past the threshold', async () => {
    const cursorStore = new InMemoryCursorStore({
      cursor: '0',
      lastLedger: 100,
      lastProgressAt: '2026-01-01T00:00:00.000Z',
      lastWasmHash: 'wasm-hash-v1',
    });
    const { deps, channel } = makeDeps({
      cursorStore,
      reader: new FixtureEscrowReader(new Map(), new Map(), 100, 'wasm-hash-v1'), // ledger never advances
      stallThresholdSeconds: 60,
      now: () => new Date('2026-01-01T00:05:00.000Z'), // 5 minutes later, still ledger 100
    });
    await new SentinelEngine(deps).runTimerChecks();

    const relevant = channel.dispatched.filter(a => a.invariant === 'stream_stall');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.severity).toBe('high');
  });

  it('does not stall-alert when the ledger has advanced', async () => {
    const cursorStore = new InMemoryCursorStore({
      cursor: '0',
      lastLedger: 100,
      lastProgressAt: '2026-01-01T00:00:00.000Z',
      lastWasmHash: 'wasm-hash-v1',
    });
    const { deps, channel } = makeDeps({
      cursorStore,
      reader: new FixtureEscrowReader(new Map(), new Map(), 150, 'wasm-hash-v1'),
      stallThresholdSeconds: 60,
      now: () => new Date('2026-01-01T00:05:00.000Z'),
    });
    await new SentinelEngine(deps).runTimerChecks();

    expect(channel.dispatched.filter(a => a.invariant === 'stream_stall')).toHaveLength(0);
  });

  it('fires a critical alert when the contract WASM hash changes (upgrade)', async () => {
    const cursorStore = new InMemoryCursorStore({
      cursor: '0',
      lastLedger: 100,
      lastProgressAt: '2026-01-01T00:00:00.000Z',
      lastWasmHash: 'wasm-hash-v1',
    });
    const { deps, channel } = makeDeps({
      cursorStore,
      reader: new FixtureEscrowReader(new Map(), new Map(), 101, 'wasm-hash-v2'),
    });
    await new SentinelEngine(deps).runTimerChecks();

    const relevant = channel.dispatched.filter(a => a.invariant === 'contract_upgrade');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.severity).toBe('critical');
  });

  it('does not alert on the very first WASM-hash observation', async () => {
    const cursorStore = new InMemoryCursorStore(null); // no prior cursor at all
    const { deps, channel } = makeDeps({
      cursorStore,
      reader: new FixtureEscrowReader(new Map(), new Map(), 1, 'wasm-hash-v1'),
    });
    await new SentinelEngine(deps).runTimerChecks();

    expect(channel.dispatched.filter(a => a.invariant === 'contract_upgrade')).toHaveLength(0);
  });
});

describe('SentinelEngine — restart safety (no gap, no duplicate)', () => {
  it('resumes from the persisted cursor and never re-fires an already-notified alert', async () => {
    const allEvents = [
      ev({ topic: 'paused', data: [ADMIN], pagingToken: '0-0' }),
      ev({ topic: 'unpaused', data: [ADMIN], pagingToken: '1-0' }),
    ];
    const cursorStore = new InMemoryCursorStore();
    const channel = new RecordingChannel();

    // First run: only the first event is "available" (simulating the engine
    // crashing/restarting right after this page, before the second event
    // was ever fetched).
    const firstDeps = makeDeps({
      eventSource: new FixtureEventSource([allEvents[0]!], 100),
      cursorStore,
      channels: [channel],
    }).deps;
    const firstEngine = new SentinelEngine(firstDeps);
    const processed1 = await firstEngine.processNextBatch();

    expect(processed1).toBe(1);
    expect(channel.dispatched).toHaveLength(1);
    expect(channel.dispatched[0]).toMatchObject({ invariant: 'pause_state' });
    const cursorAfterFirstRun = cursorStore.snapshot();
    expect(cursorAfterFirstRun?.cursor).toBe('1'); // one event consumed

    // "Restart": a brand new engine instance, same persisted cursor store,
    // now pointed at a source that serves BOTH events again (as a real RPC
    // backfill would, since it doesn't know what was already processed).
    const secondDeps = makeDeps({
      eventSource: new FixtureEventSource(allEvents, 100),
      cursorStore,
      channels: [channel],
    }).deps;
    const secondEngine = new SentinelEngine(secondDeps);
    const processed2 = await secondEngine.processNextBatch();

    // No gap: the second (unpaused) event was processed exactly once.
    expect(processed2).toBe(1);
    const relevant = channel.dispatched.filter(a => a.invariant === 'pause_state');
    expect(relevant).toHaveLength(2); // one 'paused', one 'unpaused' — genuinely distinct occurrences
    expect(relevant.map(a => a.details?.action)).toEqual(['paused', 'unpaused']);

    // No duplicate: re-running processNextBatch against the same already-
    // consumed page again must not re-dispatch either alert a second time.
    const thirdDeps = makeDeps({
      eventSource: new FixtureEventSource(allEvents, 100),
      cursorStore,
      channels: [channel],
    }).deps;
    await new SentinelEngine(thirdDeps).processNextBatch();
    expect(channel.dispatched.filter(a => a.invariant === 'pause_state')).toHaveLength(2);
  });

  it('replaying the exact same event twice never dispatches a duplicate notification', async () => {
    const channel = new RecordingChannel();
    const pausedEvent = ev({ topic: 'paused', data: [ADMIN], pagingToken: '0-0' });

    // Same event served twice across two separate engine instances — e.g. a
    // crash after evaluating but before the cursor write landed, so the next
    // start re-fetches and re-evaluates the same page. Each engine gets its
    // own (never-advanced) cursor store, matching "crashed before persisting
    // progress"; the alert router's dedupe store (mocked common/storage) is
    // shared, which is what must catch the repeat.
    const deps1 = makeDeps({
      eventSource: new FixtureEventSource([pausedEvent], 100),
      cursorStore: new InMemoryCursorStore(),
      channels: [channel],
    }).deps;
    await new SentinelEngine(deps1).processNextBatch();

    const deps2 = makeDeps({
      eventSource: new FixtureEventSource([pausedEvent], 100),
      cursorStore: new InMemoryCursorStore(),
      channels: [channel],
    }).deps;
    await new SentinelEngine(deps2).processNextBatch();

    // Dedupe (keyed by the event's own stable id) collapses the replay —
    // exactly one notification reaches the channel, not two.
    expect(channel.dispatched.filter(a => a.invariant === 'pause_state')).toHaveLength(1);
  });
});
