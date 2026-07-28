import * as StellarSdk from '@stellar/stellar-sdk';
import {
  HORIZON_URL,
  SOROBAN_RPC_URL,
  getNetworkPassphrase,
  getTokenByCode,
} from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { parsePositiveInt } from '../common/env';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

// Read per-call (not at module load) so tests can shrink the timeout without
// re-importing the module — matching the STELLAR_TIMEOUT_MS pattern in
// stellar.service.ts.
const getContractCallTimeoutMs = () =>
  parsePositiveInt(process.env.CONTRACT_CALL_TIMEOUT_MS, 30_000);

const sorobanBreaker = getCircuitBreaker('soroban-rpc', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/**
 * Thrown when a Soroban contract invocation fails. `message` is always a safe,
 * human-readable summary — never the raw SDK error/simulation payload, which
 * can contain sequence numbers and account ids that must not reach an HTTP
 * client. The raw detail is still logged server-side (via `logger.error`) at
 * the throw site, and is available on `rawDetail` for internal error-code
 * mapping (see escrow.client.ts).
 */
export class ContractCallError extends Error {
  constructor(
    message: string,
    public readonly rawDetail: string,
  ) {
    super(message);
    this.name = 'ContractCallError';
  }
}

// SECURITY: The raw value of AGENT_WALLET_SECRET must NEVER appear in any log,
// error message, or exception payload shipped to Datadog or Sentry.
// Always derive and log the public key instead.

export interface SendPaymentParams {
  destinationAddress: string;
  amount: string; // string to match Stellar SDK precision
  memo?: string;
  tokenCode?: string; // defaults to USDC
}

export interface SendPaymentResult {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  tokenCode: string;
}

/**
 * Sends a token payment from the agent's own wallet to a data seller.
 * Supports USDC, EURC, or XLM (native).
 * Requires AGENT_WALLET_SECRET in env.
 */
export async function sendTokenPayment(params: SendPaymentParams): Promise<SendPaymentResult> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) {
    throw new Error('AGENT_WALLET_SECRET not configured — agent cannot send payments');
  }

  const tokenCode = params.tokenCode || 'USDC';
  const token = getTokenByCode(tokenCode);
  if (!token) {
    throw new Error(`Unsupported token: ${tokenCode}`);
  }

  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());

  // For XLM (native), just check native balance; for tokens, check trustline
  if (tokenCode === 'XLM') {
    const nativeBal = account.balances.find(b => b.asset_type === 'native');
    if (!nativeBal || parseFloat(nativeBal.balance) < parseFloat(params.amount)) {
      throw new Error(
        `Insufficient XLM balance: need ${params.amount} XLM, have ${nativeBal?.balance || '0'} XLM`,
      );
    }
  } else {
    // For USDC/EURC
    const tokenBal = account.balances.find(b => {
      if (b.asset_type === 'native') return false;
      const bal = b as { asset_code: string; asset_issuer: string };
      return bal.asset_code === tokenCode && bal.asset_issuer === token.issuer;
    }) as { balance: string } | undefined;

    if (!tokenBal) {
      throw new Error(`Agent wallet has no ${tokenCode} trustline — cannot send payment`);
    }
    if (parseFloat(tokenBal.balance) < parseFloat(params.amount)) {
      throw new Error(
        `Insufficient ${tokenCode} balance: need ${params.amount} ${tokenCode}, have ${tokenBal.balance} ${tokenCode}`,
      );
    }
  }

  // Build asset object
  let asset: StellarSdk.Asset;
  if (tokenCode === 'XLM') {
    asset = StellarSdk.Asset.native();
  } else {
    if (!token.issuer) {
      throw new Error(`Token ${tokenCode} is missing an issuer configuration`);
    }
    asset = new StellarSdk.Asset(tokenCode, token.issuer);
  }

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: params.destinationAddress,
      asset,
      amount: params.amount,
    }),
  );

  if (params.memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(params.memo.slice(0, 28))); // Stellar memo max 28 bytes
  }

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);
  return {
    txHash: result.hash,
    from: keypair.publicKey(),
    to: params.destinationAddress,
    amount: params.amount,
    tokenCode,
  };
}

/**
 * Deprecated: Use sendTokenPayment instead
 */
export async function sendUsdcPayment(params: SendPaymentParams): Promise<SendPaymentResult> {
  return sendTokenPayment({ ...params, tokenCode: 'USDC' });
}

/**
 * Invokes a Soroban contract function as admin (AGENT_WALLET_SECRET).
 * Simulates, assembles auth, signs, submits, and polls for confirmation.
 * Returns the confirmed transaction hash.
 */
export async function callContract(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<string> {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) throw new Error('AGENT_WALLET_SECRET not configured');

  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const rpc = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const contract = new StellarSdk.Contract(contractId);

  // Each RPC round-trip is wrapped individually so a business-level rejection
  // (e.g. simulateTransaction resolving with a failed simulation, or
  // sendTransaction resolving with status ERROR) does NOT count as a circuit
  // failure — only a thrown/network-level fault does. That mirrors how
  // stellar.service.ts's breaker only sees genuine Horizon faults, not
  // "payment not found" style results.
  const account = await sorobanBreaker.execute(() => rpc.getAccount(keypair.publicKey()));
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await sorobanBreaker.execute(() => rpc.simulateTransaction(tx));
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
    // The raw simulation payload can contain the caller's account id and
    // sequence number — log it server-side only, never in the thrown message.
    const rawDetail = JSON.stringify(simResult);
    logger.error(`[Escrow] Contract simulation failed for ${method}: ${rawDetail}`);
    throw new ContractCallError(`Contract simulation failed for ${method}`, rawDetail);
  }

  const assembled = StellarSdk.rpc.assembleTransaction(tx, simResult).build();
  assembled.sign(keypair);

  const sendResult = await sorobanBreaker.execute(() => rpc.sendTransaction(assembled));
  if (sendResult.status === 'ERROR') {
    const rawDetail = JSON.stringify(sendResult.errorResult);
    logger.error(`[Escrow] Contract submit error for ${method}: ${rawDetail}`);
    throw new ContractCallError(`Contract submit error for ${method}`, rawDetail);
  }

  const txHash = sendResult.hash;
  const deadline = Date.now() + getContractCallTimeoutMs();
  while (Date.now() < deadline) {
    const txResult = await sorobanBreaker.execute(() => rpc.getTransaction(txHash));
    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) return txHash;
    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      logger.error(`[Escrow] Contract call ${method} failed on-chain (${txHash})`);
      throw new ContractCallError(`Contract call ${method} failed on-chain`, txHash);
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new ContractCallError(
    `Contract call ${method} timed out after ${getContractCallTimeoutMs()}ms`,
    txHash,
  );
}

// SECURITY: returns only the derived PUBLIC key — the raw secret is never exposed.
export function getAgentPublicKey(): string | null {
  const rawSecret = process.env.AGENT_WALLET_SECRET;
  if (!rawSecret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(rawSecret).publicKey();
  } catch {
    // Do NOT log the exception message here — it may echo key material.
    return null;
  }
}

/**
 * Call once at application startup to verify the agent wallet is properly
 * configured. Logs ONLY the derived public key — never the secret.
 * Throws if the secret is absent or malformed.
 */
export function validateAgentWallet(): void {
  const rawSecret = process.env.AGENT_WALLET_SECRET;

  if (!rawSecret) {
    throw new Error(
      '[AgentWallet] AGENT_WALLET_SECRET is not set. ' +
        'The agent wallet cannot sign transactions.',
    );
  }

  let publicKey: string;
  try {
    // Only the derived public key is ever passed to the logger — not the secret.
    publicKey = StellarSdk.Keypair.fromSecret(rawSecret).publicKey();
  } catch {
    // Do NOT include the caught error in this throw — it may echo key material.
    throw new Error(
      '[AgentWallet] AGENT_WALLET_SECRET is set but is not a valid Stellar secret key. ' +
        'Check the value in your environment configuration.',
    );
  }

  // Safe to log — publicKey is the on-chain address, not secret key material.
  logger.info(`[AgentWallet] Wallet ready. Public key: ${publicKey}`);
}
