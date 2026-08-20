/**
 * rpc.ts — the only file in sentinel/ that touches Soroban RPC directly.
 *
 * Everything else (engine, invariants, alert router) depends only on the
 * plain interfaces in types.ts, so it can be exercised with fixture data —
 * this module is what wires those interfaces to the real network.
 */
import crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL, getNetworkPassphrase, getEscrowContractId } from '../lib/stellar.config';
import { getAgentPublicKey } from '../agent/agent.wallet';
import { getEscrow, getEscrowCount } from '../lib/escrow.client';
import { PaymentError } from '../payments/stellar.service';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { addressToScVal } from '../lib/scval';
import { logger } from '../lib/logger';
import type {
  EscrowReader,
  EventPage,
  EventSource,
  SentinelEvent,
  SentinelEventTopic,
} from './types';

const sentinelBreaker = getCircuitBreaker('soroban-rpc', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

/** Retries a transient failure with exponential backoff — used around every RPC call in the ingest loop. */
export async function withReconnectBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * 2 ** attempt;
      logger.warn(
        `[Sentinel] RPC call failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

const KNOWN_TOPICS: ReadonlySet<string> = new Set<SentinelEventTopic>([
  'locked',
  'released',
  'refunded',
  'claimed',
  'confirm',
  'disp_up',
  'disp_res',
  'paused',
  'unpaused',
  'fee_upd',
  'dsf_upd',
  'dsf_clr',
  'treasury',
  'admin',
  'wl_mode',
  'addr_wl',
  'addr_bl',
  'cb_amt',
  'cb_rate',
  'arbit',
  'emerg_wd',
]);

function decodeEvent(raw: StellarSdk.rpc.Api.EventResponse): SentinelEvent | null {
  const topicSymbol = raw.topic[0] ? StellarSdk.scValToNative(raw.topic[0]) : undefined;
  if (typeof topicSymbol !== 'string' || !KNOWN_TOPICS.has(topicSymbol)) {
    // Not one of the escrow contract's known events (or a diagnostic/system
    // event slipping through a broad filter) — ignore rather than crash the
    // ingest loop on an event shape we don't model.
    return null;
  }
  const value = StellarSdk.scValToNative(raw.value);
  const data = Array.isArray(value) ? value : [value];

  return {
    id: raw.id,
    topic: topicSymbol as SentinelEventTopic,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    pagingToken: raw.pagingToken,
    data,
  };
}

/** Real Soroban-RPC-backed EventSource for the deployed escrow contract. */
export function createRpcEventSource(): EventSource {
  const rpc = getRpc();
  const contractId = getEscrowContractId();

  return {
    async getPage({ cursor, startLedger, limit }): Promise<EventPage> {
      const request: Parameters<typeof rpc.getEvents>[0] = {
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit,
        ...(cursor ? { cursor } : { startLedger }),
      };
      const response = await withReconnectBackoff(() =>
        sentinelBreaker.execute(() => rpc.getEvents(request)),
      );
      const events = response.events.map(decodeEvent).filter((e): e is SentinelEvent => e !== null);
      return { events, cursor: response.cursor, latestLedger: response.latestLedger };
    },
  };
}

/** Real Soroban-RPC-backed EscrowReader — ground truth for solvency reconciliation. */
export function createRpcEscrowReader(): EscrowReader {
  const rpc = getRpc();
  const contractId = getEscrowContractId();

  return {
    getEscrowCount,

    async getEscrow(escrowId) {
      try {
        const record = await getEscrow(escrowId);
        return {
          token: record.token,
          amount: BigInt(record.amountStroops),
          deadline: record.deadline,
          released: record.released,
          refunded: record.refunded,
        };
      } catch (err) {
        if (err instanceof PaymentError && err.message === 'Escrow not found') {
          return null;
        }
        throw err;
      }
    },

    async getTokenBalance(tokenAddress) {
      const admin = getAgentPublicKey();
      const sourceAddr = admin ?? contractId;
      const contract = new StellarSdk.Contract(tokenAddress);
      const account = await sentinelBreaker
        .execute(() => rpc.getAccount(sourceAddr))
        .catch(() => new StellarSdk.Account(sourceAddr, '0'));

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(contract.call('balance', addressToScVal(contractId)))
        .setTimeout(30)
        .build();

      const sim = await withReconnectBackoff(() =>
        sentinelBreaker.execute(() => rpc.simulateTransaction(tx)),
      );
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
        throw new Error(`balance() simulation failed for token ${tokenAddress}`);
      }
      return BigInt(StellarSdk.scValToNative(sim.result.retval) as string | number | bigint);
    },

    async getContractWasmHash() {
      const wasm = await withReconnectBackoff(() =>
        sentinelBreaker.execute(() => rpc.getContractWasmByContractId(contractId)),
      );
      return crypto.createHash('sha256').update(wasm).digest('hex');
    },

    async getLatestLedger() {
      const latest = await withReconnectBackoff(() =>
        sentinelBreaker.execute(() => rpc.getLatestLedger()),
      );
      return latest.sequence;
    },
  };
}
