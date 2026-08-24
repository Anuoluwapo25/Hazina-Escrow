/**
 * chain.ts — the only place in the devnet that signs and submits.
 *
 * Two submission paths, because they genuinely differ:
 *
 *   • Classic ops (create account, change trust, payment) go through Horizon.
 *   • Soroban ops must be simulated first, then assembled with the footprint and
 *     auth entries the simulation returned, then submitted through RPC and
 *     polled to a final status.
 *
 * Every entry point re-checks the guard. That is deliberate belt-and-braces: a
 * caller that constructs a client itself, or a config mutated after startup,
 * still cannot reach a public network from here.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { CLASSIC_FEE, HEALTH_TIMEOUTS_MS, SOROBAN_FEE } from './config.ts';
import { assertLocalEndpoint, assertLocalPassphrase } from './guard.ts';
import { sleep } from './health.ts';

export interface ChainContext {
  horizonUrl: string;
  rpcUrl: string;
  friendbotUrl: string;
  passphrase: string;
}

export class ChainError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'ChainError';
    this.detail = detail;
  }
}

export function rpcClient(ctx: ChainContext): rpc.Server {
  assertLocalPassphrase(ctx.passphrase);
  assertLocalEndpoint(ctx.rpcUrl, 'Soroban RPC');
  return new rpc.Server(ctx.rpcUrl, { allowHttp: true });
}

export function horizonClient(ctx: ChainContext): Horizon.Server {
  assertLocalPassphrase(ctx.passphrase);
  assertLocalEndpoint(ctx.horizonUrl, 'Horizon');
  return new Horizon.Server(ctx.horizonUrl, { allowHttp: true });
}

// ── Funding ──────────────────────────────────────────────────────────────────

/**
 * Funds an account via friendbot, retrying while friendbot is still starting.
 * Idempotent: an already-funded account is a success, not an error, which is
 * what makes re-running `npm run devnet` against a live devnet safe.
 */
export async function fundAccount(
  ctx: ChainContext,
  publicKey: string,
  maxAttempts = 40,
): Promise<'created' | 'already-funded'> {
  assertLocalEndpoint(ctx.friendbotUrl, 'Friendbot');
  let lastError = 'no attempt made';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`${ctx.friendbotUrl}?addr=${publicKey}`);
      const body = await res.text();
      if (res.ok) {
        return 'created';
      }
      if (body.includes('already funded')) {
        return 'already-funded';
      }
      lastError = `HTTP ${res.status}: ${body.slice(0, 160)}`;
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) {
        throw new ChainError(`friendbot refused to fund ${publicKey}: ${lastError}`);
      }
    } catch (err) {
      if (err instanceof ChainError) {
        throw err;
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(Math.min(250 * 1.6 ** attempt, 2_000));
  }
  throw new ChainError(`friendbot never funded ${publicKey}. Last error: ${lastError}`);
}

// ── Classic ──────────────────────────────────────────────────────────────────

/**
 * Builds, signs and submits a classic transaction through Horizon.
 * Loads the source account fresh every time — caching a sequence number across
 * calls is the classic way to produce tx_bad_seq races.
 */
export async function submitClassic(
  ctx: ChainContext,
  source: Keypair,
  operations: xdr.Operation[],
  extraSigners: Keypair[] = [],
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  assertLocalPassphrase(ctx.passphrase);
  const server = horizonClient(ctx);
  const account = await server.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: CLASSIC_FEE,
    networkPassphrase: ctx.passphrase,
  });
  for (const op of operations) {
    builder.addOperation(op);
  }
  const tx = builder.setTimeout(60).build();
  tx.sign(source, ...extraSigners);
  try {
    return await server.submitTransaction(tx);
  } catch (err) {
    throw new ChainError(
      `classic submit failed: ${describeHorizonError(err)}`,
      (err as { response?: { data?: unknown } })?.response?.data,
    );
  }
}

function describeHorizonError(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (!data) {
    return err instanceof Error ? err.message : String(err);
  }
  const extras = data.extras as { result_codes?: unknown } | undefined;
  return JSON.stringify(extras?.result_codes ?? data).slice(0, 400);
}

/** Reads a classic balance for `asset`, in whole units. Returns 0 with no trustline. */
export async function classicBalance(
  ctx: ChainContext,
  publicKey: string,
  asset: Asset,
): Promise<number> {
  const server = horizonClient(ctx);
  const account = await server.loadAccount(publicKey);
  const match = account.balances.find(b => {
    if (asset.isNative()) {
      return b.asset_type === 'native';
    }
    return (
      'asset_code' in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer()
    );
  });
  return match ? Number.parseFloat(match.balance) : 0;
}

/** True when `publicKey` holds a trustline to `asset`. */
export async function hasTrustline(
  ctx: ChainContext,
  publicKey: string,
  asset: Asset,
): Promise<boolean> {
  const server = horizonClient(ctx);
  const account = await server.loadAccount(publicKey);
  return account.balances.some(
    b =>
      'asset_code' in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

// ── Soroban ──────────────────────────────────────────────────────────────────

export interface SorobanResult {
  hash: string;
  returnValue: xdr.ScVal | undefined;
  /** Native-decoded return value, when the contract returned something. */
  native: unknown;
}

/**
 * Simulate → assemble → sign → submit → poll, the full Soroban round trip.
 *
 * `assembleTransaction` is what stamps the resource footprint and the auth
 * entries the simulation computed onto the transaction. Skipping it is the most
 * common cause of "transaction simulation succeeded but submission failed".
 */
export async function submitSoroban(
  ctx: ChainContext,
  source: Keypair,
  operation: xdr.Operation,
  options: { fee?: string; timeoutMs?: number } = {},
): Promise<SorobanResult> {
  assertLocalPassphrase(ctx.passphrase);
  const server = rpcClient(ctx);
  const account = await server.getAccount(source.publicKey());
  const built = new TransactionBuilder(account, {
    fee: options.fee ?? SOROBAN_FEE,
    networkPassphrase: ctx.passphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ChainError(`simulation failed: ${sim.error}`, sim);
  }
  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(source);
  return submitPrepared(ctx, prepared, options.timeoutMs);
}

/**
 * Submits an already-signed transaction and polls to a final status. Split out
 * from `submitSoroban` so the double-spend test can submit the exact same signed
 * envelope twice without rebuilding it.
 */
export async function submitPrepared(
  ctx: ChainContext,
  prepared: Transaction,
  timeoutMs: number = HEALTH_TIMEOUTS_MS.transaction,
): Promise<SorobanResult> {
  const server = rpcClient(ctx);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new ChainError(
      `submission rejected: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 400)}`,
      sent,
    );
  }
  if (sent.status === 'DUPLICATE') {
    throw new ChainError(`submission rejected as DUPLICATE (hash ${sent.hash})`, sent);
  }

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'SUCCESS') {
      return {
        hash: sent.hash,
        returnValue: got.returnValue,
        native: got.returnValue === undefined ? undefined : scValToNative(got.returnValue),
      };
    }
    if (got.status === 'FAILED') {
      throw new ChainError(
        `transaction ${sent.hash} failed on-chain: ${JSON.stringify(got.resultXdr ?? '').slice(0, 400)}`,
        got,
      );
    }
    await sleep(Math.min(200 * 1.4 ** attempt, 1_500));
    attempt += 1;
  }
  throw new ChainError(`transaction ${sent.hash} was still pending after ${timeoutMs}ms`);
}

/**
 * Read-only contract call. Simulation only — never submitted, so it costs
 * nothing and cannot mutate state. This is how the e2e suite reads authoritative
 * on-chain balances instead of trusting an API response body.
 */
export async function simulateCall(
  ctx: ChainContext,
  readerPublicKey: string,
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const server = rpcClient(ctx);
  const account = await server.getAccount(readerPublicKey);
  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_FEE,
    networkPassphrase: ctx.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ChainError(`read ${method} failed: ${sim.error}`, sim);
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval === undefined ? undefined : scValToNative(retval);
}

/**
 * Builds (but does not submit) a signed Soroban transaction. The double-spend
 * test needs the envelope in hand so it can replay it byte-for-byte.
 */
export async function prepareSoroban(
  ctx: ChainContext,
  source: Keypair,
  operation: xdr.Operation,
  fee: string = SOROBAN_FEE,
): Promise<Transaction> {
  assertLocalPassphrase(ctx.passphrase);
  const server = rpcClient(ctx);
  const account = await server.getAccount(source.publicKey());
  const built = new TransactionBuilder(account, { fee, networkPassphrase: ctx.passphrase })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ChainError(`simulation failed: ${sim.error}`, sim);
  }
  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(source);
  return prepared;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the contract panic code from a failed call, or null if the failure
 * was not a contract panic.
 *
 * Soroban surfaces `panic_with_error!(env, SomeError)` as `Error(Contract, #N)`
 * in both simulation errors and diagnostic events, where N is the enum
 * discriminant from HazinaEscrowError in contracts/hazina-escrow/src/lib.rs
 * (1 = AlreadyInitialized, 2 = NotInitialized, …).
 *
 * This matters for idempotency: several of the contract's getters return a
 * default via `unwrap_or` rather than panicking, so "did this already happen?"
 * cannot be answered by reading state. Attempting the call and recognising the
 * specific panic is the reliable check.
 */
export function contractErrorCode(err: unknown): number | null {
  const haystack = [
    err instanceof Error ? err.message : String(err),
    err instanceof ChainError ? JSON.stringify(err.detail ?? '') : '',
  ].join(' ');
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(haystack);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Contract panic codes the devnet tooling reasons about by name. */
export const CONTRACT_ERROR = {
  AlreadyInitialized: 1,
  NotInitialized: 2,
  NotAdmin: 3,
  AlreadyReleased: 6,
  AlreadyRefunded: 7,
  BuyerNotConfirmed: 17,
  AlreadyDisputed: 21,
  NotArbitrator: 23,
  DisputedEscrow: 24,
  NotDisputed: 25,
} as const;

export { Account, Asset, BASE_FEE, Contract, Keypair, Operation, TransactionBuilder, xdr };
