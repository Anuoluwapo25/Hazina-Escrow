/**
 * scan.ts — shared open-escrow sweep used by both the solvency and
 * expiry-without-claim timer checks, so one contract with a large escrow
 * count doesn't get swept twice per tick.
 */
import { parsePositiveInt } from '../../common/env';
import type { EscrowReader } from '../types';

export interface ScannedEscrow {
  escrowId: number;
  token: string;
  amount: bigint;
  deadline: number;
}

const getMaxScan = () => parsePositiveInt(process.env.SENTINEL_SOLVENCY_MAX_SCAN, 5_000);

/**
 * Reads every escrow up to `get_escrow_count()` (capped at
 * SENTINEL_SOLVENCY_MAX_SCAN) and returns the ones still open — locked but
 * neither released nor refunded. `claim_expired` sets `released = true`, so
 * a claimed escrow is correctly excluded here.
 */
export async function scanOpenEscrows(reader: EscrowReader): Promise<ScannedEscrow[]> {
  const count = await reader.getEscrowCount();
  const maxScan = getMaxScan();
  const scanCount = Math.min(count, maxScan);
  const open: ScannedEscrow[] = [];

  for (let id = 0; id < scanCount; id++) {
    // eslint-disable-next-line no-await-in-loop -- ids must be read in order; a Promise.all fan-out would hammer RPC with thousands of concurrent requests
    const record = await reader.getEscrow(id);
    if (!record || record.released || record.refunded) continue;
    open.push({
      escrowId: id,
      token: record.token,
      amount: record.amount,
      deadline: record.deadline,
    });
  }

  return open;
}
