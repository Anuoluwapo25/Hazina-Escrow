/**
 * claimable.service.ts — payout escape hatch (#589)
 *
 * When a seller's wallet can't receive a direct payment (no trustline,
 * unfunded account, account merged away), Hazina settles their earnings into
 * a Stellar claimable balance instead of parking the payout in the
 * retry/DLQ (payout-retry.service.ts) forever. The money leaves Hazina's
 * control immediately and is provably reserved for the seller on-chain; they
 * claim it whenever they set up their wallet, via a sponsored transaction
 * that also opens the missing trustline for them at zero XLM cost.
 *
 * Two claimants are attached to every balance created here:
 *   - the seller, unconditional — they can claim any time.
 *   - the Hazina treasury, gated by `not(before relative time = N)` — so an
 *     abandoned balance can be swept back after N seconds (sweepReclaimableBalances)
 *     instead of being stranded on-chain forever.
 *
 * The treasury/sponsor is the same wallet agent.wallet.ts already uses to
 * pay sellers directly (AGENT_WALLET_SECRET) — no new secret to provision.
 *
 * SECURITY: buildSponsoredClaimTx signs ONLY as the sponsor. The seller's
 * changeTrust/claimClaimableBalance operations are left unsigned — Hazina
 * must never hold or use a seller's signing key.
 */
import { v4 as uuidv4 } from 'uuid';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { domainMetrics } from '../common/datadog';
import {
  HORIZON_URL,
  getTokenByCode,
  getNetworkPassphrase,
  getClaimReclaimSeconds,
} from '../lib/stellar.config';
import { logger } from '../lib/logger';
import { parsePositiveInt } from '../common/env';
import { checkDestinationReady } from './trustline.service';
import { notifySeller } from '../webhooks/webhook.service';
import { sendClaimableBalanceEmail } from '../notifications/email.service';
import {
  addClaimableBalance,
  getReclaimableBalances,
  updateClaimableBalance,
  updateTransactionByHash,
  type ClaimableBalance,
} from '../common/storage';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

const claimableBreaker = getCircuitBreaker('stellar-horizon-claimable', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

const getClaimableTimeoutMs = () => parsePositiveInt(process.env.STELLAR_TIMEOUT_MS, 10000);

async function withClaimableTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const timeoutMs = getClaimableTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`Horizon did not respond within ${timeoutMs / 1000}s`));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireTreasurySecret(): string {
  const secret = process.env.AGENT_WALLET_SECRET;
  if (!secret) {
    throw new Error(
      'AGENT_WALLET_SECRET not configured — Hazina treasury cannot sponsor claimable balances',
    );
  }
  return secret;
}

/** The `not(before relative time = N)` predicate used for the treasury's reclaim claimant. */
export function reclaimPredicate(reclaimSeconds: number): StellarSdk.xdr.ClaimPredicate {
  return StellarSdk.Claimant.predicateNot(
    StellarSdk.Claimant.predicateBeforeRelativeTime(String(Math.trunc(reclaimSeconds))),
  );
}

function buildClaimUrl(sellerWallet: string): string {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/claim?seller=${encodeURIComponent(sellerWallet)}`;
}

function parseAssetString(assetString: string): { code: string; issuer?: string } {
  if (assetString === 'native') return { code: 'native' };
  const [code, issuer] = assetString.split(':');
  return { code: code ?? '', issuer };
}

function toAsset(code: string, issuer?: string): StellarSdk.Asset {
  return code === 'native' ? StellarSdk.Asset.native() : new StellarSdk.Asset(code, issuer);
}

// ── Stellar layer ────────────────────────────────────────────────────────────

/**
 * Submits the createClaimableBalance transaction. Pure Stellar operation —
 * no storage writes. Callers use settleAsClaimableBalance for the full
 * settlement flow (DB record + notifications).
 */
export async function createSellerClaimableBalance(params: {
  sellerWallet: string;
  amount: string; // decimal string, e.g. "4.7500000"
  tokenCode: string;
}): Promise<{ balanceId: string; txHash: string; reclaimSeconds: number }> {
  const secret = requireTreasurySecret();
  const treasuryKeypair = StellarSdk.Keypair.fromSecret(secret);

  const token = getTokenByCode(params.tokenCode);
  if (params.tokenCode !== 'XLM' && !token?.issuer) {
    throw new Error(`Unsupported token for claimable balance: ${params.tokenCode}`);
  }
  const asset =
    params.tokenCode === 'XLM'
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(params.tokenCode, token!.issuer!);

  const reclaimSeconds = getClaimReclaimSeconds();
  const sellerClaimant = new StellarSdk.Claimant(
    params.sellerWallet,
    StellarSdk.Claimant.predicateUnconditional(),
  );
  const treasuryClaimant = new StellarSdk.Claimant(
    treasuryKeypair.publicKey(),
    reclaimPredicate(reclaimSeconds),
  );

  const account = await withClaimableTimeout(() =>
    claimableBreaker.execute(() => server.loadAccount(treasuryKeypair.publicKey())),
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.createClaimableBalance({
        asset,
        amount: params.amount,
        claimants: [sellerClaimant, treasuryClaimant],
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(treasuryKeypair);

  const result = await withClaimableTimeout(() =>
    claimableBreaker.execute(() => server.submitTransaction(tx)),
  );

  const ops = await withClaimableTimeout(() =>
    claimableBreaker.execute(() => server.operations().forTransaction(result.hash).call()),
  );
  const createOp = ops.records.find(
    (o: { type: string }) => o.type === 'create_claimable_balance',
  ) as { balance_id?: string } | undefined;
  if (!createOp?.balance_id) {
    throw new Error('createClaimableBalance succeeded but Horizon did not return a balance_id');
  }

  return { balanceId: createOp.balance_id, txHash: result.hash, reclaimSeconds };
}

export interface ClaimableBalanceListItem {
  balanceId: string;
  amount: string;
  assetCode: string;
  /** Ledger the balance was last modified in — Horizon doesn't expose a timestamp here directly. */
  lastModifiedLedger: number;
  sponsor?: string;
}

/** Lists a wallet's pending claimable balances directly from Horizon. */
export async function listClaimableBalancesForSeller(
  sellerWallet: string,
): Promise<ClaimableBalanceListItem[]> {
  const result = await withClaimableTimeout(() =>
    claimableBreaker.execute(() => server.claimableBalances().claimant(sellerWallet).call()),
  );
  return result.records.map(record => {
    const { code } = parseAssetString(record.asset);
    return {
      balanceId: record.id,
      amount: record.amount,
      assetCode: code,
      lastModifiedLedger: record.last_modified_ledger,
      sponsor: record.sponsor,
    };
  });
}

/**
 * Builds the operation list for the sponsored claim transaction. Pure — no
 * network I/O — so op ordering and the sponsor-only signature can be
 * verified in tests without a live Horizon connection.
 */
export function buildClaimTransaction(params: {
  treasuryKeypair: StellarSdk.Keypair;
  treasuryAccount: StellarSdk.Account;
  sellerWallet: string;
  balanceId: string;
  asset: StellarSdk.Asset;
  needsTrustline: boolean;
}): StellarSdk.Transaction {
  const builder = new StellarSdk.TransactionBuilder(params.treasuryAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  }).addOperation(
    StellarSdk.Operation.beginSponsoringFutureReserves({ sponsoredId: params.sellerWallet }),
  );

  if (params.needsTrustline) {
    builder.addOperation(
      StellarSdk.Operation.changeTrust({ asset: params.asset, source: params.sellerWallet }),
    );
  }

  builder
    .addOperation(
      StellarSdk.Operation.claimClaimableBalance({
        balanceId: params.balanceId,
        source: params.sellerWallet,
      }),
    )
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({ source: params.sellerWallet }),
    );

  const tx = builder.setTimeout(180).build();
  // SECURITY: sign only as the sponsor. The seller's wallet must sign the
  // returned XDR client-side — Hazina never holds or uses seller key material.
  tx.sign(params.treasuryKeypair);
  return tx;
}

/**
 * Assembles the sponsored claim transaction: begin sponsoring → (changeTrust
 * if the seller doesn't already trust the asset) → claimClaimableBalance →
 * end sponsoring. Signed by Hazina as sponsor only; the returned XDR still
 * needs the seller's signature before it can be submitted.
 */
export async function buildSponsoredClaimTx(params: {
  sellerWallet: string;
  balanceId: string;
}): Promise<{ xdr: string }> {
  const secret = requireTreasurySecret();
  const treasuryKeypair = StellarSdk.Keypair.fromSecret(secret);

  const balanceRecord = await withClaimableTimeout(() =>
    claimableBreaker.execute(() =>
      server.claimableBalances().claimableBalance(params.balanceId).call(),
    ),
  );
  const { code, issuer } = parseAssetString(balanceRecord.asset);
  const asset = toAsset(code, issuer);

  const needsTrustline =
    code !== 'native' &&
    (await checkDestinationReady(params.sellerWallet, code)).reason === 'no_trustline';

  const treasuryAccount = await withClaimableTimeout(() =>
    claimableBreaker.execute(() => server.loadAccount(treasuryKeypair.publicKey())),
  );

  const tx = buildClaimTransaction({
    treasuryKeypair,
    treasuryAccount,
    sellerWallet: params.sellerWallet,
    balanceId: params.balanceId,
    asset,
    needsTrustline,
  });

  return { xdr: tx.toXDR() };
}

/** Sweeps treasury-reclaimable (expired, still-pending) balances back to the treasury. */
export async function sweepReclaimableBalances(): Promise<{ swept: string[]; failed: string[] }> {
  const nowIso = new Date().toISOString();
  const due = await getReclaimableBalances(nowIso);
  const swept: string[] = [];
  const failed: string[] = [];

  for (const cb of due) {
    try {
      const secret = requireTreasurySecret();
      const treasuryKeypair = StellarSdk.Keypair.fromSecret(secret);
      const account = await withClaimableTimeout(() =>
        claimableBreaker.execute(() => server.loadAccount(treasuryKeypair.publicKey())),
      );
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: cb.balanceId }))
        .setTimeout(30)
        .build();
      tx.sign(treasuryKeypair);

      const result = await withClaimableTimeout(() =>
        claimableBreaker.execute(() => server.submitTransaction(tx)),
      );

      await updateClaimableBalance(cb.id, {
        status: 'reclaimed',
        reclaimedTxHash: result.hash,
        reclaimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      swept.push(cb.balanceId);
    } catch (err) {
      logger.error(
        `[Claimable] Sweep failed for balance ${cb.balanceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed.push(cb.balanceId);
    }
  }

  return { swept, failed };
}

// ── Settlement orchestration ─────────────────────────────────────────────────

/**
 * Full settlement fallback: creates the on-chain claimable balance, records
 * it, links it to the originating transaction, and notifies the seller.
 * This is the entry point the payout path (payments.router.ts,
 * payout-retry.service.ts) calls when a direct payment isn't possible.
 */
export async function settleAsClaimableBalance(params: {
  datasetId: string;
  sellerWallet: string;
  buyerTxHash: string;
  amount: number;
  tokenCode: string;
  notificationEmail?: string;
}): Promise<ClaimableBalance> {
  const { balanceId, txHash, reclaimSeconds } = await createSellerClaimableBalance({
    sellerWallet: params.sellerWallet,
    amount: params.amount.toFixed(7),
    tokenCode: params.tokenCode,
  });

  const nowIso = new Date().toISOString();
  const record: ClaimableBalance = {
    id: `claim-${uuidv4()}`,
    balanceId,
    datasetId: params.datasetId,
    sellerWallet: params.sellerWallet,
    buyerTxHash: params.buyerTxHash,
    amount: params.amount,
    paymentToken: params.tokenCode,
    status: 'pending',
    creationTxHash: txHash,
    reclaimableAt: new Date(Date.now() + reclaimSeconds * 1000).toISOString(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await addClaimableBalance(record);
  await updateTransactionByHash(params.buyerTxHash, { balanceId });

  domainMetrics.paymentDeliveryFailed({
    datasetType: 'unknown',
    mode: 'real',
    reason: 'settled_as_claimable_balance',
  });

  const claimUrl = buildClaimUrl(params.sellerWallet);

  notifySeller(params.sellerWallet, 'payout.claimable', {
    datasetId: params.datasetId,
    balanceId,
    amount: params.amount,
    paymentToken: params.tokenCode,
    claimUrl,
  }).catch(() => {});

  if (params.notificationEmail) {
    sendClaimableBalanceEmail({
      to: params.notificationEmail,
      amount: params.amount,
      paymentToken: params.tokenCode,
      claimUrl,
    }).catch((err: unknown) => {
      logger.error(
        `[Claimable] Notification email failed for ${params.sellerWallet}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  logger.warn(
    `[Claimable] Settled payout for ${params.sellerWallet} as claimable balance ${balanceId} (creation tx ${txHash})`,
  );

  return record;
}

// ── Background sweep worker ─────────────────────────────────────────────────

let sweepWorker: NodeJS.Timeout | null = null;

/** Periodically sweeps treasury-reclaimable balances. Call once at startup. */
export function startClaimableSweepWorker(intervalMs = 6 * 60 * 60_000): void {
  if (sweepWorker) return;

  void sweepReclaimableBalances().catch(err => {
    logger.error(
      `[Claimable] Initial sweep run failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  sweepWorker = setInterval(() => {
    void sweepReclaimableBalances().catch(err => {
      logger.error(
        `[Claimable] Sweep worker run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);
}

export function stopClaimableSweepWorker(): void {
  if (!sweepWorker) return;
  clearInterval(sweepWorker);
  sweepWorker = null;
}
