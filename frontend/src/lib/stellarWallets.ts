import {
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  signTransaction as freighterSignTransaction,
  isAllowed as freighterIsAllowed,
} from '@stellar/freighter-api';
import { getEnv } from './env';

export type StellarWalletProvider = 'freighter' | 'albedo';

export interface StellarPaymentRequest {
  paymentAddress: string;
  amount: number;
  memo: string;
}

export interface WalletDetectionResult {
  freighter: boolean;
  albedo: boolean;
}

interface AlbedoPayResult {
  tx_hash?: string;
  transaction_hash?: string;
}

interface AlbedoIntent {
  pay: (params: Record<string, string | boolean>) => Promise<AlbedoPayResult>;
}

declare global {
  interface Window {
    albedo?: AlbedoIntent;
  }
}

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const PUBLIC_HORIZON_URL = 'https://horizon.stellar.org';

function configuredUsdcIssuer() {
  const { usdcIssuer, stellarNetwork } = getEnv();
  if (usdcIssuer) return usdcIssuer;
  return stellarNetwork === 'public' ? MAINNET_USDC_ISSUER : TESTNET_USDC_ISSUER;
}

function albedoNetwork() {
  return getEnv().stellarNetwork === 'public' ? 'public' : 'testnet';
}

function networkPassphrase() {
  return albedoNetwork() === 'public' ? PUBLIC_PASSPHRASE : TESTNET_PASSPHRASE;
}

function appendParams(baseUrl: string, params: Record<string, string | boolean>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)));
  return `${baseUrl}?${query.toString()}`;
}

export function getStellarPaymentParams(payment: StellarPaymentRequest) {
  return {
    destination: payment.paymentAddress,
    amount: payment.amount.toFixed(7).replace(/\.?0+$/, ''),
    asset_code: 'USDC',
    asset_issuer: configuredUsdcIssuer(),
    memo: payment.memo,
    memo_type: 'MEMO_TEXT',
  };
}

export function buildFreighterPaymentUri(payment: StellarPaymentRequest) {
  return appendParams('web+stellar:pay', {
    ...getStellarPaymentParams(payment),
    network_passphrase: networkPassphrase(),
  });
}

export function buildAlbedoPaymentUrl(payment: StellarPaymentRequest) {
  return appendParams('https://albedo.link/intent/pay', {
    ...getStellarPaymentParams(payment),
    network: albedoNetwork(),
    submit: true,
  });
}

export async function detectWallets(): Promise<WalletDetectionResult> {
  let freighter = false;
  try {
    freighter = await freighterIsConnected();
  } catch {
    freighter = false;
  }

  const albedo = typeof window !== 'undefined' && !!window.albedo?.pay;

  return { freighter, albedo };
}

export async function connectFreighter(): Promise<string> {
  const connected = await freighterIsConnected();
  if (!connected) {
    throw new Error('Freighter extension is not installed. Please install it from freighter.app');
  }

  const allowed = await freighterIsAllowed();
  if (!allowed) {
    const publicKey = await freighterRequestAccess();
    return publicKey;
  }

  const publicKey = await freighterRequestAccess();
  return publicKey;
}

export async function signWithFreighter(xdr: string): Promise<string> {
  const signedXdr = await freighterSignTransaction(xdr, {
    networkPassphrase: networkPassphrase(),
  });
  return signedXdr;
}

function horizonUrl(): string {
  return albedoNetwork() === 'public' ? PUBLIC_HORIZON_URL : TESTNET_HORIZON_URL;
}

/**
 * Submits a fully-signed transaction envelope XDR directly to Horizon, using
 * the plain HTTP API rather than pulling in the full @stellar/stellar-sdk
 * dependency just to POST one transaction from the browser.
 */
export async function submitSignedTransaction(signedXdr: string): Promise<string> {
  const response = await fetch(`${horizonUrl()}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: signedXdr }).toString(),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data?.extras?.result_codes?.transaction ||
      data?.extras?.result_codes?.operations?.join(', ') ||
      data?.title ||
      'Transaction submission failed';
    throw new Error(detail);
  }

  return data.hash as string;
}

export async function launchStellarWalletProvider(
  provider: StellarWalletProvider,
  payment: StellarPaymentRequest,
) {
  if (provider === 'freighter') {
    try {
      await connectFreighter();
    } catch {
      // Freighter not available — fall back to SEP-7 URI
    }
    window.location.href = buildFreighterPaymentUri(payment);
    return null;
  }

  if (window.albedo?.pay) {
    const result = await window.albedo.pay({
      ...getStellarPaymentParams(payment),
      network: albedoNetwork(),
      submit: true,
    });
    return result.tx_hash ?? result.transaction_hash ?? null;
  }

  window.open(buildAlbedoPaymentUrl(payment), '_blank', 'noopener,noreferrer');
  return null;
}
