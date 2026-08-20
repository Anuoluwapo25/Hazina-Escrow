/**
 * escrow.client.ts — Issue #546
 *
 * Typed client for the deployed Hazina escrow Soroban contract. This is the
 * bridge that was missing from the live system: the contract enforces the
 * 95/5 split on-chain, and this module is how the backend (as admin) drives
 * release / refund and how it reads authoritative escrow state.
 *
 * Trust model:
 *   • lock()    — signed by the BUYER from their own wallet. The backend only
 *                 assembles the unsigned XDR (buildLockTx); user funds never
 *                 pass through a Hazina-controlled key.
 *   • release() — signed by the ADMIN (AGENT_WALLET_SECRET). Moves 95% to the
 *                 seller and 5% to the treasury. The admin can only trigger the
 *                 contract's pre-programmed split, never redirect funds.
 *   • refund()  — signed by the ADMIN. Returns 100% to the buyer.
 *   • get_escrow — read-only simulation, no signature.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import {
  SOROBAN_RPC_URL,
  getNetworkPassphrase,
  getEscrowContractId,
  getTokenSacAddress,
} from './stellar.config';
import { callContract, getAgentPublicKey, ContractCallError } from '../agent/agent.wallet';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { PaymentError } from '../payments/stellar.service';
import { logger } from './logger';
import { u64ToScVal, i128ToScVal, addressToScVal, stringToScVal, boolToScVal, arrayToScVal } from './scval';
import type { Quote } from '../payments/quote.service';

/** Decimals used by USDC/EURC/XLM on Stellar — amounts are i128 stroops. */
const TOKEN_DECIMALS = 7;
const STROOPS_PER_UNIT = 10 ** TOKEN_DECIMALS;

/** Default escrow expiry when the caller does not specify one (24h, seconds). */
export const DEFAULT_ESCROW_EXPIRY_SECONDS = 24 * 60 * 60;

// Shares the 'soroban-rpc' breaker instance with agent.wallet.ts's callContract
// (getCircuitBreaker returns the existing registry entry by name) so admin
// writes and read-only simulations trip the same breaker on RPC outage.
const sorobanBreaker = getCircuitBreaker('soroban-rpc', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/**
 * Maps the Hazina escrow contract's panic codes (see HazinaEscrowError in
 * contracts/hazina-escrow/src/lib.rs) to safe, specific messages. None of
 * these reveal anything beyond escrow business state, so they're safe to
 * forward to an HTTP caller via PaymentError.
 */
const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: 'Escrow contract already initialized',
  2: 'Escrow contract not initialized',
  3: 'Caller is not the escrow admin',
  4: 'Invalid platform fee',
  5: 'Invalid escrow amount',
  6: 'Escrow already released',
  7: 'Escrow already refunded',
  8: 'Escrow not found',
  9: 'Address is blacklisted',
  10: 'Address is not whitelisted',
  11: 'Dataset id cannot be empty',
  12: 'Escrow contract is paused',
  13: 'Amount exceeds the escrow circuit breaker limit',
  14: 'Escrow rate limit exceeded for this ledger — try again shortly',
  15: 'Escrow contract is not paused',
  16: 'Caller is not the escrow buyer',
  17: 'Buyer has not confirmed delivery yet',
  18: 'Delivery already confirmed',
  19: 'Caller is not the escrow seller',
  20: 'Escrow has not expired yet',
  21: 'Escrow already disputed',
  22: 'Dispute window has passed',
  23: 'Caller is not the arbitrator',
  24: 'Escrow is under dispute',
  25: 'Escrow is not under dispute',
};

function extractContractErrorCode(rawDetail: string): number | null {
  const match = rawDetail.match(/Error\(Contract,\s*#(\d+)\)/);
  return match ? Number(match[1]) : null;
}

/**
 * Throw either a PaymentError with a specific, safe message — when
 * `rawDetail` contains a recognised contract panic code — or a generic
 * sanitized Error otherwise. `rawDetail` (the raw sim/submit payload, which
 * can contain account ids and sequence numbers) is never included in the
 * thrown message; log it at the call site before calling this.
 */
function throwSanitized(rawDetail: string, fallbackMessage: string): never {
  const code = extractContractErrorCode(rawDetail);
  const knownMessage = code !== null ? CONTRACT_ERROR_MESSAGES[code] : undefined;
  throw knownMessage ? new PaymentError(knownMessage) : new Error(fallbackMessage);
}

/**
 * Translate a ContractCallError (thrown by callContract) the same way —
 * used by the admin-signed write paths (release/refund/resolve_dispute).
 */
function translateContractError(err: unknown, fallbackMessage: string): never {
  if (err instanceof ContractCallError) {
    throwSanitized(err.rawDetail, fallbackMessage);
  }
  throw new Error(fallbackMessage);
}

/**
 * On-chain escrow record, decoded from the contract's EscrowRecord struct.
 * Amount is returned both as raw stroops (string, exact) and as a decimal
 * number for display convenience.
 */
export interface EscrowState {
  escrowId: number;
  datasetId: string;
  buyer: string;
  seller: string;
  amountStroops: string;
  amount: number;
  token: string;
  deadline: number;
  buyerConfirmed: boolean;
  platformFeeBps: number;
  released: boolean;
  refunded: boolean;
  disputed: boolean;
}

/** Convert a human token amount (e.g. 1.5 USDC) to i128 stroops. */
export function toStroops(amount: number): bigint {
  // Round to the nearest stroop to avoid FP drift (e.g. 0.1 * 1e7).
  return BigInt(Math.round(amount * STROOPS_PER_UNIT));
}

/** Convert i128 stroops back to a decimal token amount. */
export function fromStroops(stroops: bigint | string): number {
  return Number(BigInt(stroops)) / STROOPS_PER_UNIT;
}

function getRpc(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

/**
 * Build an UNSIGNED transaction XDR that invokes `lock(...)` on the escrow
 * contract, authorised by the buyer. The buyer signs this with their own wallet
 * (e.g. Freighter) and submits it — no Hazina key ever touches the funds.
 *
 * The returned XDR is simulation-assembled (Soroban footprint + auth included)
 * so the buyer's wallet only needs to sign and submit.
 */
export async function buildLockTx(params: {
  buyer: string;
  seller: string;
  amount: number;
  datasetId: string;
  tokenCode?: string;
  expirySeconds?: number;
  quote?: Quote;
}): Promise<{ xdr: string; contractId: string }> {
  const { buyer, seller, amount, datasetId, quote } = params;
  const tokenCode = params.tokenCode ?? 'USDC';
  const expirySeconds = params.expirySeconds ?? DEFAULT_ESCROW_EXPIRY_SECONDS;

  const contractId = getEscrowContractId();
  const tokenAddress = getTokenSacAddress(tokenCode);
  if (!tokenAddress) {
    throw new Error(
      `No Soroban token contract (SAC) configured for ${tokenCode} — cannot build on-chain lock. ` +
        `Set ${tokenCode}_SAC_ADDRESS.`,
    );
  }

  const rpc = getRpc();
  const contract = new StellarSdk.Contract(contractId);
  const buyerAccount = await sorobanBreaker.execute(() => rpc.getAccount(buyer));

  const args: StellarSdk.xdr.ScVal[] = [
    addressToScVal(buyer),
    addressToScVal(seller),
    addressToScVal(tokenAddress),
    i128ToScVal(toStroops(amount)),
    stringToScVal(datasetId),
    u64ToScVal(expirySeconds),
  ];

  const txBuilder = new StellarSdk.TransactionBuilder(buyerAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  });

  if (quote && quote.source.asset !== quote.destination.asset) {
    const routerId = process.env.SOROSWAP_ROUTER_ID;
    if (!routerId) throw new Error('SOROSWAP_ROUTER_ID not configured for swap');
    const router = new StellarSdk.Contract(routerId);
    
    // Convert path to addresses (Assuming SACs are used)
    const pathAddresses = quote.path.map(p => {
      if (p === 'native') return getTokenSacAddress('XLM') as string;
      const code = p.split(':')[0] || '';
      return getTokenSacAddress(code) || (p.split(':')[1] as string);
    });
    // Add source and dest
    const sourceCode = quote.source.asset.split(':')[0] || '';
    const sourceAddr = quote.source.asset === 'native' ? (getTokenSacAddress('XLM') as string) : getTokenSacAddress(sourceCode) || (quote.source.asset.split(':')[1] as string);
    
    const destCode = quote.destination.asset.split(':')[0] || '';
    const destAddr = quote.destination.asset === 'native' ? (getTokenSacAddress('XLM') as string) : getTokenSacAddress(destCode) || (quote.destination.asset.split(':')[1] as string);
    
    const fullPath = [sourceAddr, ...pathAddresses, destAddr].filter(Boolean) as string[];

    const swapArgs = [
      i128ToScVal(toStroops(parseFloat(quote.source.maxAmount))), // amount_in
      i128ToScVal(toStroops(parseFloat(quote.destination.amount))), // amount_out_min
      arrayToScVal(fullPath.map(p => addressToScVal(p))), // path
      addressToScVal(buyer), // to
      u64ToScVal(Math.floor(Date.now() / 1000) + 300) // deadline
    ];
    
    // We'll use swap_exact_tokens_for_tokens to provide the exact amount_in and expect at least amount_out_min.
    txBuilder.addOperation(router.call('swap_exact_tokens_for_tokens', ...swapArgs));
  }

  const tx = txBuilder
    .addOperation(contract.call('lock', ...args))
    .setTimeout(300)
    .build();

  const sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    const rawDetail = JSON.stringify(sim);
    logger.error(`[Escrow] lock() simulation failed: ${rawDetail}`);
    throwSanitized(rawDetail, 'lock() simulation failed — please try again');
  }

  const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  return { xdr: assembled.toXDR(), contractId };
}

/**
 * Submit a buyer-signed `lock()` transaction and return the on-chain escrow id.
 *
 * The transaction was signed by the buyer's own wallet — the backend only
 * relays the already-signed XDR to the network (relaying costs the submitter a
 * trivial base fee but never touches the locked funds). The contract returns
 * the new escrow id as the invocation result, which we decode and return so the
 * rest of the flow has an authoritative handle on the escrow.
 */
export async function submitSignedLock(
  signedXdr: string,
): Promise<{ txHash: string; escrowId: number }> {
  const rpc = getRpc();
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase());

  const sendResult = await sorobanBreaker.execute(() =>
    rpc.sendTransaction(tx as StellarSdk.Transaction),
  );
  if (sendResult.status === 'ERROR') {
    logger.error(`[Escrow] lock() submit error: ${JSON.stringify(sendResult.errorResult)}`);
    throw new Error('lock() submit error — please try again');
  }

  const txHash = sendResult.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await sorobanBreaker.execute(() => rpc.getTransaction(txHash));
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      if (!result.returnValue) {
        throw new Error('lock() succeeded but returned no escrow id');
      }
      const escrowId = Number(StellarSdk.scValToNative(result.returnValue));
      logger.info(`[Escrow] Buyer locked funds → escrow #${escrowId} (${txHash})`);
      return { txHash, escrowId };
    }
    if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      logger.error(`[Escrow] lock() failed on-chain (${txHash})`);
      throw new Error('lock() failed on-chain');
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error(`lock() confirmation timed out (${txHash})`);
}

/**
 * Release an escrow as admin. The contract splits the funds 95% seller /
 * 5% treasury according to the fee snapshotted at lock time. Returns the
 * confirmed transaction hash.
 */
export async function releaseEscrow(escrowId: number): Promise<string> {
  const admin = getAgentPublicKey();
  if (!admin) {
    throw new Error('AGENT_WALLET_SECRET not configured — cannot release escrow as admin');
  }
  const contractId = getEscrowContractId();
  logger.info(`[Escrow] Releasing escrow #${escrowId} on ${contractId}`);
  try {
    return await callContract(contractId, 'release', [addressToScVal(admin), u64ToScVal(escrowId)]);
  } catch (err) {
    translateContractError(err, `Failed to release escrow #${escrowId} — please try again`);
  }
}

/**
 * Refund an escrow as admin. The contract returns 100% of the locked amount to
 * the buyer. Returns the confirmed transaction hash.
 */
export async function refundEscrow(escrowId: number): Promise<string> {
  const admin = getAgentPublicKey();
  if (!admin) {
    throw new Error('AGENT_WALLET_SECRET not configured — cannot refund escrow as admin');
  }
  const contractId = getEscrowContractId();
  logger.info(`[Escrow] Refunding escrow #${escrowId} on ${contractId}`);
  try {
    return await callContract(contractId, 'refund', [addressToScVal(admin), u64ToScVal(escrowId)]);
  } catch (err) {
    translateContractError(err, `Failed to refund escrow #${escrowId} — please try again`);
  }
}

/**
 * Lock funds as the agent (server-controlled wallet acting as buyer) and return
 * the escrow id. Used by the autonomous research agent (#550): the agent locks
 * into the contract, then the backend releases so the 95/5 split happens
 * on-chain rather than the agent paying the seller 100% directly.
 *
 * The agent's wallet (AGENT_WALLET_SECRET) is both buyer and signer here, so the
 * transaction is built and submitted server-side — the agent is not a
 * third-party user whose funds we must never touch.
 */
export async function lockAsAgent(params: {
  seller: string;
  amount: number;
  datasetId: string;
  tokenCode?: string;
  expirySeconds?: number;
}): Promise<{ txHash: string; escrowId: number }> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) {
    throw new Error('AGENT_WALLET_SECRET not configured — agent cannot lock escrow');
  }
  const keypair = StellarSdk.Keypair.fromSecret(secret);

  const { xdr } = await buildLockTx({
    buyer: keypair.publicKey(),
    seller: params.seller,
    amount: params.amount,
    datasetId: params.datasetId,
    tokenCode: params.tokenCode,
    expirySeconds: params.expirySeconds,
  });

  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, getNetworkPassphrase());
  (tx as StellarSdk.Transaction).sign(keypair);

  return submitSignedLock(tx.toXDR());
}

/**
 * Resolve a dispute as the arbitrator (defaults to admin). When `favourBuyer`
 * is true the contract refunds the buyer; otherwise it releases to the seller.
 * Returns the confirmed transaction hash.
 */
export async function resolveDispute(escrowId: number, favourBuyer: boolean): Promise<string> {
  const arbitrator = getAgentPublicKey();
  if (!arbitrator) {
    throw new Error('AGENT_WALLET_SECRET not configured — cannot resolve dispute as arbitrator');
  }
  const contractId = getEscrowContractId();
  logger.info(`[Escrow] Resolving dispute for escrow #${escrowId} (favourBuyer=${favourBuyer})`);
  try {
    return await callContract(contractId, 'resolve_dispute', [
      addressToScVal(arbitrator),
      u64ToScVal(escrowId),
      boolToScVal(favourBuyer),
    ]);
  } catch (err) {
    translateContractError(
      err,
      `Failed to resolve dispute for escrow #${escrowId} — please try again`,
    );
  }
}

/**
 * Build an UNSIGNED `confirm_delivery(escrow_id, buyer)` XDR for the buyer to
 * sign. Confirming delivery unblocks the admin `release` call.
 */
export async function buildConfirmDeliveryTx(params: {
  buyer: string;
  escrowId: number;
}): Promise<{ xdr: string }> {
  return buildBuyerSignedCall('confirm_delivery', params.buyer, [
    u64ToScVal(params.escrowId),
    addressToScVal(params.buyer),
  ]);
}

/**
 * Build an UNSIGNED `raise_dispute(buyer, escrow_id, evidence_hash)` XDR for the
 * buyer to sign. `evidenceHash` is a 32-byte hash of off-chain evidence; when
 * omitted a zero hash is used.
 */
export async function buildRaiseDisputeTx(params: {
  buyer: string;
  escrowId: number;
  evidenceHash?: Buffer;
}): Promise<{ xdr: string }> {
  const evidence = params.evidenceHash ?? Buffer.alloc(32);
  if (evidence.length !== 32) {
    throw new Error('evidenceHash must be exactly 32 bytes');
  }
  return buildBuyerSignedCall('raise_dispute', params.buyer, [
    addressToScVal(params.buyer),
    u64ToScVal(params.escrowId),
    StellarSdk.xdr.ScVal.scvBytes(evidence),
  ]);
}

/**
 * Shared helper: assemble an unsigned, simulation-prepared invocation of
 * `method` on the escrow contract, sourced from `sourceAddress` (the buyer).
 */
async function buildBuyerSignedCall(
  method: string,
  sourceAddress: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<{ xdr: string; contractId: string }> {
  const contractId = getEscrowContractId();
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
    logger.error(`[Escrow] ${method}() simulation failed: ${rawDetail}`);
    throwSanitized(rawDetail, `${method}() simulation failed — please try again`);
  }
  const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  return { xdr: assembled.toXDR(), contractId };
}

/**
 * Read an escrow record from the contract via read-only simulation.
 * No signature required and no state is mutated.
 */
export async function getEscrow(escrowId: number): Promise<EscrowState> {
  const contractId = getEscrowContractId();
  const admin = getAgentPublicKey();
  // Any account works as the simulation source for a read; fall back to the
  // contract address itself if no admin key is set.
  const sourceAddr = admin ?? contractId;

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
    .addOperation(contract.call('get_escrow', u64ToScVal(escrowId)))
    .setTimeout(30)
    .build();

  const sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    const rawDetail = JSON.stringify(sim);
    logger.error(`[Escrow] get_escrow(${escrowId}) simulation failed: ${rawDetail}`);
    throwSanitized(rawDetail, 'get_escrow() simulation failed — please try again');
  }

  return decodeEscrowRecord(sim.result.retval);
}

/**
 * Read the contract's escrow counter via read-only simulation. Escrow ids are
 * assigned sequentially from 0, so this is also the exclusive upper bound for
 * a full `get_escrow` sweep (used by Sentinel's solvency reconciliation).
 */
export async function getEscrowCount(): Promise<number> {
  const contractId = getEscrowContractId();
  const admin = getAgentPublicKey();
  const sourceAddr = admin ?? contractId;

  const rpc = getRpc();
  const contract = new StellarSdk.Contract(contractId);
  const account = await sorobanBreaker
    .execute(() => rpc.getAccount(sourceAddr))
    .catch(() => new StellarSdk.Account(sourceAddr, '0'));

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call('get_escrow_count'))
    .setTimeout(30)
    .build();

  const sim = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    const rawDetail = JSON.stringify(sim);
    logger.error(`[Escrow] get_escrow_count() simulation failed: ${rawDetail}`);
    throwSanitized(rawDetail, 'get_escrow_count() simulation failed — please try again');
  }

  return Number(StellarSdk.scValToNative(sim.result.retval));
}

/**
 * Decode a contract EscrowRecord ScVal into an EscrowState. The struct is
 * returned as a map keyed by field name; scValToNative gives us a plain object.
 */
export function decodeEscrowRecord(retval: StellarSdk.xdr.ScVal): EscrowState {
  const raw = StellarSdk.scValToNative(retval) as Record<string, unknown>;

  const amountStroops = BigInt(raw.amount as string | number | bigint).toString();

  return {
    escrowId: Number(raw.escrow_id),
    datasetId: String(raw.dataset_id ?? ''),
    buyer: String(raw.buyer),
    seller: String(raw.seller),
    amountStroops,
    amount: fromStroops(amountStroops),
    token: String(raw.token),
    deadline: Number(raw.deadline),
    buyerConfirmed: Boolean(raw.buyer_confirmed),
    platformFeeBps: Number(raw.platform_fee_bps),
    released: Boolean(raw.released),
    refunded: Boolean(raw.refunded),
    disputed: Boolean(raw.disputed),
  };
}
