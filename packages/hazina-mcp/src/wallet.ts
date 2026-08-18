/**
 * wallet.ts — signs and submits the classic memo-based USDC payment this
 * server's purchase_dataset tool needs for a real (non-demo) purchase.
 *
 * Mirrors the tested pattern in `backend/src/agent/agent.wallet.ts`'s
 * `sendTokenPayment` (load account via Horizon, verify a trustline balance
 * covers the amount, build+sign+submit a payment operation with a text
 * memo) rather than importing it — this package has no workspace link to
 * `backend/`, and the wallet-signing primitive is generic infrastructure,
 * not marketplace business logic.
 *
 * The secret key never leaves this module: it is read once from config and
 * only ever used to construct a `Keypair` for signing here.
 */
import * as StellarSdk from '@stellar/stellar-sdk';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const DEFAULT_TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const DEFAULT_PUBLIC_HORIZON = 'https://horizon.stellar.org';
const DEFAULT_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export interface WalletConfig {
  secret: string;
  network?: 'testnet' | 'public';
  horizonUrl?: string;
  usdcIssuer?: string;
}

export interface SentPayment {
  txHash: string;
  from: string;
  to: string;
  amount: string;
}

export function publicKeyFromSecret(secret: string): string {
  return StellarSdk.Keypair.fromSecret(secret).publicKey();
}

/**
 * Send a USDC (or other token-code) memo-tagged payment from this server's
 * wallet — the same custodial-demo payment shape `WalletConnectButton`'s
 * Freighter/Albedo paths produce, just signed server-side.
 */
export async function sendPayment(
  config: WalletConfig,
  params: { destinationAddress: string; amount: number; memo: string; tokenCode?: string },
): Promise<SentPayment> {
  const network = config.network ?? 'testnet';
  const horizonUrl =
    config.horizonUrl ?? (network === 'public' ? DEFAULT_PUBLIC_HORIZON : DEFAULT_TESTNET_HORIZON);
  const networkPassphrase = network === 'public' ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE;
  const usdcIssuer = config.usdcIssuer ?? DEFAULT_TESTNET_USDC_ISSUER;
  const tokenCode = params.tokenCode ?? 'USDC';

  const keypair = StellarSdk.Keypair.fromSecret(config.secret);
  const server = new StellarSdk.Horizon.Server(horizonUrl);
  const account = await server.loadAccount(keypair.publicKey());

  const asset =
    tokenCode === 'XLM' ? StellarSdk.Asset.native() : new StellarSdk.Asset(tokenCode, usdcIssuer);
  const amountStr = params.amount.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');

  if (asset.getCode() !== 'XLM') {
    const trustline = account.balances.find(
      b => 'asset_code' in b && b.asset_code === tokenCode && b.asset_issuer === usdcIssuer,
    );
    if (!trustline) {
      throw new Error(
        `Hazina MCP wallet ${keypair.publicKey()} has no ${tokenCode} trustline — fund it and add a trustline before purchasing.`,
      );
    }
    if (Number(trustline.balance) < params.amount) {
      throw new Error(
        `Hazina MCP wallet has ${trustline.balance} ${tokenCode}, short of the ${params.amount} needed for this purchase.`,
      );
    }
  }

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: params.destinationAddress,
        asset,
        amount: amountStr,
      }),
    )
    .addMemo(StellarSdk.Memo.text(params.memo.slice(0, 28)))
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);

  return {
    txHash: result.hash,
    from: keypair.publicKey(),
    to: params.destinationAddress,
    amount: amountStr,
  };
}
