/**
 * store.ts — bridges the pure engine to the app's real persistence
 * (common/storage.ts). The only file in sentinel/ that touches the DB.
 */
import { getSentinelCursor, saveSentinelCursor, getTransactionByEscrowId } from '../common/storage';
import type { CursorStore, SentinelCursorState } from './types';

export function createStorageBackedCursorStore(): CursorStore {
  return {
    async load() {
      const cursor = await getSentinelCursor();
      if (!cursor) return null;
      return {
        cursor: cursor.cursor,
        lastLedger: cursor.lastLedger,
        lastProgressAt: cursor.lastProgressAt,
        lastWasmHash: cursor.lastWasmHash,
      };
    },
    async save(update: Partial<SentinelCursorState>) {
      const saved = await saveSentinelCursor(update);
      return {
        cursor: saved.cursor,
        lastLedger: saved.lastLedger,
        lastProgressAt: saved.lastProgressAt,
        lastWasmHash: saved.lastWasmHash,
      };
    },
  };
}

/** Backend delivery record check for the deliveryRecord invariant. */
export async function hasBackendDeliveryRecord(escrowId: number): Promise<boolean> {
  const tx = await getTransactionByEscrowId(escrowId);
  return tx?.status === 'completed' && tx?.deliveryStatus === 'delivered';
}
