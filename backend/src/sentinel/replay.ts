/**
 * replay.ts — incident forensics: point Sentinel at a historical ledger
 * range and re-run the event-based invariants against it, without touching
 * the live cursor or the persisted alert table.
 *
 * The timer-based invariants (solvency, expiry, stream stall, upgrade
 * watch) aren't replayable — get_escrow/balance return *current* contract
 * state, not a historical snapshot at some past ledger — so replay only
 * covers what actually happened in that range's events.
 *
 * Usage:
 *   npx ts-node src/sentinel/replay.ts --start 100000 --end 100500
 */
import dotenv from 'dotenv';
dotenv.config();

import { createRpcEventSource, createRpcEscrowReader } from './rpc';
import * as pauseState from './invariants/pauseState';
import * as adminActions from './invariants/adminActions';
import * as feeBand from './invariants/feeBand';
import * as releaseConservation from './invariants/releaseConservation';
import * as unknownEscrow from './invariants/unknownEscrow';
import type { EscrowReader, EventSource, RaisedAlert, SentinelEvent } from './types';

interface ReplayOptions {
  startLedger: number;
  endLedger: number;
  pageLimit?: number;
}

function parseArgs(argv: string[]): ReplayOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const startLedger = Number(get('--start'));
  const endLedger = Number(get('--end'));
  if (!Number.isInteger(startLedger) || !Number.isInteger(endLedger) || startLedger > endLedger) {
    throw new Error('Usage: replay.ts --start <ledger> --end <ledger> [--limit <pageLimit>]');
  }
  const limitArg = get('--limit');
  return { startLedger, endLedger, pageLimit: limitArg ? Number(limitArg) : undefined };
}

async function evaluateEvent(event: SentinelEvent, reader: EscrowReader): Promise<RaisedAlert[]> {
  return [
    ...pauseState.evaluate(event),
    ...adminActions.evaluate(event),
    ...feeBand.evaluate(event),
    ...(await releaseConservation.evaluate(event, reader)),
    ...(await unknownEscrow.evaluate(event, reader)),
  ];
}

export async function replay(
  options: ReplayOptions,
  eventSource: EventSource,
  reader: EscrowReader,
): Promise<RaisedAlert[]> {
  const allAlerts: RaisedAlert[] = [];
  let cursor: string | undefined;
  let startLedger: number | undefined = options.startLedger;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- pages must be fetched in cursor order
    const page = await eventSource.getPage({
      cursor,
      startLedger: cursor ? undefined : startLedger,
      limit: options.pageLimit ?? 100,
    });

    const inRange = page.events.filter(e => e.ledger <= options.endLedger);
    for (const event of inRange) {
      // eslint-disable-next-line no-await-in-loop -- invariant reads must stay ordered with the events
      const alerts = await evaluateEvent(event, reader);
      allAlerts.push(...alerts);
    }

    const exhausted =
      page.events.length === 0 ||
      page.events.some(e => e.ledger > options.endLedger) ||
      page.cursor === cursor;
    if (exhausted) break;
    cursor = page.cursor;
    startLedger = undefined;
  }

  return allAlerts;
}

/* istanbul ignore next -- CLI entrypoint, exercised via replay() in tests */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[Sentinel Replay] Ledgers ${options.startLedger} → ${options.endLedger}`);

  const alerts = await replay(options, createRpcEventSource(), createRpcEscrowReader());

  if (alerts.length === 0) {
    console.log('No invariant violations found in this range.');
    return;
  }
  console.log(`${alerts.length} violation(s) found:\n`);
  for (const alert of alerts) {
    console.log(`[${alert.severity.toUpperCase()}] ${alert.invariant}: ${alert.message}`);
    if (alert.details) console.log('  ', JSON.stringify(alert.details));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Sentinel Replay] Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
