/**
 * access-pass.client.ts — dataset subscription access passes
 *
 * Typed client for the deployed Hazina access-pass Soroban contract
 * (contracts/hazina-access-pass). Modeled line-for-line on escrow.client.ts:
 *
 * Trust model:
 *   • subscribe() / renew()  — signed by the BUYER from their own wallet. The
 *     backend only assembles the unsigned XDR (buildSubscribeTx/buildRenewTx);
 *     funds move from the buyer's wallet into escrow custody via the contract,
 *     never through a Hazina-controlled key.
 *   • define_plan()          — signed by the SELLER from their own wallet.
 *   • has_access / get_pass /
 *     get_plan               — read-only simulations, no signature.
 *
 * Fail-closed rule (load-bearing): when Soroban RPC is unreachable, the shared
 * breaker is open, or a simulation/decode fails, hasAccess() THROWS an
 * AccessCheckUnavailableError. It never resolves `true` from a failure path
 * and never swallows an error into a `false`. A thrown error means DENY and
 * callers should surface a "verification temporarily unavailable" state.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { SOROBAN_RPC_URL, getNetworkPassphrase, getAccessPassContractId } from './stellar.config';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { getAgentPublicKey } from '../agent/agent.wallet';
import { logger } from './logger';
import { u64ToScVal, u32ToScVal, i128ToScVal, addressToScVal, stringToScVal } from './scval';

/** Decimals used by USDC/EURC/XLM on Stellar — plan prices are i128 stroops. */
const TOKEN_DECIMALS = 7;
const STROOPS_PER_UNIT = 10 ** TOKEN_DECIMALS;

// Shares the 'soroban-rpc' breaker instance with agent.wallet.ts's callContract
// and escrow.client.ts (getCircuitBreaker returns the existing registry entry
// by name) so subscription reads trip the same breaker during RPC outage.
const sorobanBreaker = getCircuitBreaker('soroban-rpc', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/**
 * Maps the access-pass contract's panic codes (HazinaAccessPassError in
 * contracts/hazina-access-pass/src/lib.rs) to safe, specific messages. Safe to
 * forward to HTTP callers; none reveal anything beyond business state.
 */
export const ACCESS_PASS_ERROR_MESSAGES: Record<number, string> = {
  1: 'Access pass contract already initialized',
  2: 'Access pass contract not initialized',
  3: 'Caller is not the access pass admin',
  4: 'Caller is not the plan seller',
  5: 'Dataset id cannot be empty',
  6: 'Invalid subscription amount',
  7: 'Invalid subscription period',
  8: 'Invalid seat count',
  9: 'Subscription plan not found',
  10: 'Subscription plan is inactive',
  11: 'All seats for this plan are taken',
  12: 'Already subscribed to this dataset',
  13: 'No active access pass found',
  14: 'Fee configuration lookup failed — subscription unavailable',
  15: 'Invalid payment recipient',
  16: 'Pass has not expired yet',
  17: 'Nothing to settle for this pass',
};

function extractContractErrorCode(rawDetail: string): number | null {
  const match = rawDetail.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? Number(match[1]) : null;
}

/**
 * Throw either an Error with a specific, safe message — when `rawDetail`
 * contains a recognised contract panic code — or a generic sanitized Error
 * otherwise. `rawDetail` (the raw sim/submit payload) is never included in the
 * thrown message; log it at the call site before calling this.
 */
function throwSanitized(rawDetail: string, fallbackMessage: string): never {
  const code = extractContractErrorCode(rawDetail);
  const knownMessage = code !== null ? ACCESS_PASS_ERROR_MESSAGES[code] : undefined;
  throw new AccessPassError(knownMessage ?? fallbackMessage);
}

/**
 * Thrown when access CANNOT be verified. Per the fail-closed rule, callers
 * must treat this as DENY plus surface a temporary-unavailability state.
 */
export class AccessCheckUnavailableError extends Error {
  constructor(message = 'Access verification is temporarily unavailable — try again shortly') {
    super(message);
    this.name = 'AccessCheckUnavailableError';
  }
}

/**
 * A subscription failure whose message we authored (contract panic-code map
 * or sanitized fallback) and is safe to show the user as-is — the access-pass
 * counterpart of payments' PaymentError. Routers map this to HTTP 400.
 */
export class AccessPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessPassError';
  }
}

/** Convert i128 stroops back to a decimal token amount (display only). */
export function stroopsToAmount(stroops: bigint | string): number {
  return Number(BigInt(stroops)) / STROOPS_PER_UNIT;
}

/** On-chain plan record, decoded from the contract's PlanRecord struct. */
export interface PlanState {
  planId: number;
  seller: string;
  datasetId: string;
  /** Raw stroops as a string — exact, no float drift. */
  pricePerPeriodStroops: string;
  pricePerPeriod: number;
  periodSeconds: number;
  maxSeats: number;
  active: boolean;
}

/** On-chain pass record, decoded from the contract's PassRecord struct. */
export interface AccessPassState {
  planId: number;
  buyer: string;
  datasetId: string;
  start: number;
  expiry: number;
  termPeriodSeconds: number;
  amountPaidStroops: string;
  amountPaid: number;
  feeBps: number;
  revoked: boolean;
}

/** Short-lived cache so page polls don't hammer Soroban RPC. Never caches errors. */
const READ_CACHE_TTL_MS = 15_000;
const readCache = new Map<string, { value: unknown; expiresAt: number }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = readCache.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    readCache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  readCache.set(key, { value, expiresAt: Date.now() + READ_CACHE_TTL_MS });
}

/** Test hook: drop every cached read immediately. */
export function clearAccessReadCache(): void {
  readCache.clear();
}

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

/**
 * Run a read-only simulation of `method` against the access-pass contract and
 * return the raw result ScVal. No signature required, no state mutated.
 * Every failure mode throws AccessCheckUnavailableError (fail closed).
 */
async function simulateRead(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.xdr.ScVal> {
  let contractId: string;
  try {
    contractId = getAccessPassContractId();
  } catch {
    // Unconfigured deployment: verification genuinely unavailable.
    throw new AccessCheckUnavailableError();
  }
  const sourceAddr = getSimulationSource(contractId);

  const rpc = getRpc();
  const contract = new StellarSdk.Contract(contractId);
  const account = await sorobanBreaker
    .execute(() => rpc.getAccount(sourceAddr))
    .catch(() => {
      // Simulation only needs a well-formed account; a fresh one is fine.
      return new StellarSdk.Account(sourceAddr, '0');
    });

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  let sim: StellarSdk.rpc.Api.SimulateTransactionResponse;
  try {
    sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) throw new AccessCheckUnavailableError();
    logger.error(
      `[AccessPass] ${method}() RPC failure: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new AccessCheckUnavailableError();
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    const rawDetail = JSON.stringify(sim);
    logger.error(`[AccessPass] ${method}() simulation failed: ${rawDetail}`);
    throw new AccessCheckUnavailableError();
  }
  return sim.result.retval;
}

function getSimulationSource(contractId: string): string {
  // Any account works as the simulation source for a read; fall back to the
  // contract address itself if no admin key is configured.
  return getAgentPublicKey() ?? contractId;
}

/**
 * True iff the buyer holds a non-revoked, unexpired pass for the dataset.
 * Total on-chain function: a missing pass decodes to a real `false` — only
 * infrastructure failures throw (fail closed).
 */
export async function hasAccess(buyer: string, datasetId: string): Promise<boolean> {
  const key = `has:${buyer}:${datasetId}`;
  const cached = cacheGet<boolean>(key);
  if (cached !== undefined) return cached;

  let value: boolean;
  try {
    const retval = await simulateRead('has_access', [
      addressToScVal(buyer),
      stringToScVal(datasetId),
    ]);
    value = Boolean(StellarSdk.scValToNative(retval));
  } catch (err) {
    if (err instanceof AccessCheckUnavailableError) throw err;
    logger.error(
      `[AccessPass] has_access(${buyer}, ${datasetId}) decode failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new AccessCheckUnavailableError();
  }

  cacheSet(key, value);
  return value;
}

/**
 * The buyer's pass record, or null when they hold none (contract returns the
 * Soroban Option None). Infrastructure failures still throw fail-closed.
 */
export async function getPass(buyer: string, datasetId: string): Promise<AccessPassState | null> {
  const key = `pass:${buyer}:${datasetId}`;
  const cached = cacheGet<AccessPassState | null>(key);
  if (cached !== undefined) return cached;

  let value: AccessPassState | null;
  try {
    const retval = await simulateRead('get_pass', [
      addressToScVal(buyer),
      stringToScVal(datasetId),
    ]);
    const native = StellarSdk.scValToNative(retval);
    value = native == null ? null : decodePassRecord(retval);
  } catch (err) {
    if (err instanceof AccessCheckUnavailableError) throw err;
    logger.error(
      `[AccessPass] get_pass(${buyer}, ${datasetId}) decode failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new AccessCheckUnavailableError();
  }

  cacheSet(key, value);
  return value;
}

/** Read a plan record by id. Throws (fail closed) on any infrastructure error. */
export async function getPlan(planId: number): Promise<PlanState> {
  const retval = await simulateRead('get_plan', [u64ToScVal(planId)]);
  return decodePlanRecord(retval);
}

/** Decode a contract PlanRecord ScVal into a PlanState. */
export function decodePlanRecord(retval: StellarSdk.xdr.ScVal): PlanState {
  const raw = StellarSdk.scValToNative(retval) as Record<string, unknown>;
  const priceStroops = BigInt(raw.price_per_period as string | number | bigint).toString();
  return {
    planId: Number(raw.plan_id),
    seller: String(raw.seller),
    datasetId: String(raw.dataset_id ?? ''),
    pricePerPeriodStroops: priceStroops,
    pricePerPeriod: stroopsToAmount(priceStroops),
    periodSeconds: Number(raw.period_seconds),
    maxSeats: Number(raw.max_seats),
    active: Boolean(raw.active),
  };
}

/** Decode a contract PassRecord ScVal into an AccessPassState. */
export function decodePassRecord(retval: StellarSdk.xdr.ScVal): AccessPassState {
  const raw = StellarSdk.scValToNative(retval) as Record<string, unknown>;
  const paidStroops = BigInt(raw.amount_paid as string | number | bigint).toString();
  return {
    planId: Number(raw.plan_id),
    buyer: String(raw.buyer),
    datasetId: String(raw.dataset_id ?? ''),
    start: Number(raw.start),
    expiry: Number(raw.expiry),
    termPeriodSeconds: Number(raw.term_period_seconds),
    amountPaidStroops: paidStroops,
    amountPaid: stroopsToAmount(paidStroops),
    feeBps: Number(raw.fee_bps),
    revoked: Boolean(raw.revoked),
  };
}

/**
 * Shared helper: assemble an unsigned, simulation-prepared invocation of
 * `method` on the access-pass contract, sourced from `sourceAddress` (the
 * buyer/seller who will sign it in their own wallet).
 */
async function buildSignedCall(
  method: string,
  sourceAddress: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<{ xdr: string; contractId: string }> {
  const contractId = getAccessPassContractId();
  const rpc = getRpc();
  const contract = new StellarSdk.Contract(contractId);
  const account = await sorobanBreaker.execute(() => rpc.getAccount(sourceAddress));

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();

  const sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const rawDetail = JSON.stringify(sim);
    logger.error(`[AccessPass] ${method}() simulation failed: ${rawDetail}`);
    throwSanitized(rawDetail, `${method}() simulation failed — please try again`);
  }
  const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  return { xdr: assembled.toXDR(), contractId };
}

/**
 * Build an UNSIGNED transaction that invokes `define_plan(...)` on the
 * access-pass contract, authorised by the seller. Returns the plan id the
 * contract will assign (sequential from 0) alongside the XDR so the UI can
 * reference it right after submission without another round-trip.
 */
export async function buildDefinePlanTx(params: {
  seller: string;
  datasetId: string;
  /** Price per period in display units (e.g. 0.05 USDC); converted to stroops here. */
  pricePerPeriod: number;
  periodSeconds: number;
  maxSeats: number;
}): Promise<{ xdr: string; contractId: string }> {
  return buildSignedCall('define_plan', params.seller, [
    addressToScVal(params.seller),
    stringToScVal(params.datasetId),
    i128ToScVal(BigInt(Math.round(params.pricePerPeriod * STROOPS_PER_UNIT))),
    u64ToScVal(params.periodSeconds),
    u32ToScVal(params.maxSeats),
  ]);
}

/**
 * Build an UNSIGNED `subscribe(buyer, dataset_id, plan_id)` XDR for the buyer
 * to sign. Subscribing charges the first period through escrow custody.
 */
export async function buildSubscribeTx(params: {
  buyer: string;
  datasetId: string;
  planId: number;
}): Promise<{ xdr: string; contractId: string }> {
  return buildSignedCall('subscribe', params.buyer, [
    addressToScVal(params.buyer),
    stringToScVal(params.datasetId),
    u64ToScVal(params.planId),
  ]);
}

/** Build an UNSIGNED `renew(buyer, dataset_id)` XDR for the buyer to sign. */
export async function buildRenewTx(params: {
  buyer: string;
  datasetId: string;
}): Promise<{ xdr: string; contractId: string }> {
  return buildSignedCall('renew', params.buyer, [
    addressToScVal(params.buyer),
    stringToScVal(params.datasetId),
  ]);
}

/**
 * Submit a wallet-signed access-pass transaction (define_plan / subscribe /
 * renew) and wait for on-chain confirmation. The backend only relays the
 * already-signed XDR — it never signs and never holds funds.
 */
export async function submitSignedAccessTx(signedXdr: string): Promise<{ txHash: string }> {
  const rpc = getRpc();
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase());

  const sendResult = await sorobanBreaker.execute(() =>
    rpc.sendTransaction(tx as StellarSdk.Transaction),
  );
  if (sendResult.status === 'ERROR') {
    logger.error(`[AccessPass] submit error: ${JSON.stringify(sendResult.errorResult)}`);
    throwSanitized(
      JSON.stringify(sendResult.errorResult ?? {}),
      'subscription transaction submit error — please try again',
    );
  }

  const txHash = sendResult.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await sorobanBreaker.execute(() => rpc.getTransaction(txHash));
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      logger.info(`[AccessPass] Transaction confirmed (${txHash})`);
      return { txHash };
    }
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      logger.error(`[AccessPass] Transaction failed on-chain (${txHash})`);
      throw new AccessPassError('subscription transaction failed on-chain');
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new AccessPassError(`subscription transaction confirmation timed out (${txHash})`);
}
