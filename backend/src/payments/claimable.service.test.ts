import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const {
  mockLoadAccount,
  mockSubmitTransaction,
  mockOperationCall,
  mockForTransaction,
  mockClaimantCall,
  mockClaimant,
} = vi.hoisted(() => {
  const loadAccount = vi.fn();
  const submitTransaction = vi.fn();
  const operationCall = vi.fn();
  const forTransaction = vi.fn(() => ({ call: operationCall }));
  const claimantCall = vi.fn();
  const claimant = vi.fn(() => ({ call: claimantCall }));
  return {
    mockLoadAccount: loadAccount,
    mockSubmitTransaction: submitTransaction,
    mockOperationCall: operationCall,
    mockForTransaction: forTransaction,
    mockClaimantCall: claimantCall,
    mockClaimant: claimant,
  };
});

vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  class MockServer {
    loadAccount = mockLoadAccount;
    submitTransaction = mockSubmitTransaction;
    operations = () => ({ forTransaction: mockForTransaction });
    claimableBalances = () => ({ claimant: mockClaimant });
  }
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockServer },
  };
});

vi.mock('../webhooks/webhook.service', () => ({
  notifySeller: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../notifications/email.service', () => ({
  sendClaimableBalanceEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../common/storage', () => ({
  addClaimableBalance: vi.fn().mockResolvedValue(undefined),
  updateTransactionByHash: vi.fn().mockResolvedValue(null),
  getReclaimableBalances: vi.fn().mockResolvedValue([]),
  updateClaimableBalance: vi.fn().mockResolvedValue(null),
}));

import {
  reclaimPredicate,
  buildClaimTransaction,
  createSellerClaimableBalance,
  listClaimableBalancesForSeller,
} from './claimable.service';
import { getCircuitBreaker } from '../common/circuit-breaker';

const treasuryKeypair = StellarSdk.Keypair.random();
const sellerKeypair = StellarSdk.Keypair.random();

describe('reclaimPredicate', () => {
  it('builds a not(before relative time = N) predicate', () => {
    const predicate = reclaimPredicate(15_552_000); // 180 days
    expect(predicate.switch().name).toBe('claimPredicateNot');
    const inner = predicate.notPredicate()!;
    expect(inner.switch().name).toBe('claimPredicateBeforeRelativeTime');
    expect(inner.relBefore()!.toString()).toBe('15552000');
  });

  it('truncates fractional seconds', () => {
    const predicate = reclaimPredicate(10.9);
    expect(predicate.notPredicate()!.relBefore()!.toString()).toBe('10');
  });
});

describe('buildClaimTransaction', () => {
  const treasuryAccount = () => new StellarSdk.Account(treasuryKeypair.publicKey(), '100');
  const asset = new StellarSdk.Asset('USDC', TESTNET_USDC_ISSUER);

  it('orders operations begin → changeTrust → claim → end when a trustline is needed', () => {
    const tx = buildClaimTransaction({
      treasuryKeypair,
      treasuryAccount: treasuryAccount(),
      sellerWallet: sellerKeypair.publicKey(),
      balanceId: '0'.repeat(72),
      asset,
      needsTrustline: true,
    });

    const ops = tx.operations;
    expect(ops.map(op => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'claimClaimableBalance',
      'endSponsoringFutureReserves',
    ]);

    // Sponsor (implicit tx source) opens the sponsorship window; the seller's
    // own operations must carry an explicit seller source so the seller's
    // signature — not the sponsor's — authorizes them.
    expect(ops[0]!.source).toBeUndefined();
    expect(ops[1]!.source).toBe(sellerKeypair.publicKey());
    expect(ops[2]!.source).toBe(sellerKeypair.publicKey());
    expect(ops[3]!.source).toBe(sellerKeypair.publicKey());
  });

  it('omits changeTrust when the seller already trusts the asset', () => {
    const tx = buildClaimTransaction({
      treasuryKeypair,
      treasuryAccount: treasuryAccount(),
      sellerWallet: sellerKeypair.publicKey(),
      balanceId: '0'.repeat(72),
      asset,
      needsTrustline: false,
    });

    expect(tx.operations.map(op => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'claimClaimableBalance',
      'endSponsoringFutureReserves',
    ]);
  });

  it('signs only as the sponsor — the seller signature is never attached', () => {
    const tx = buildClaimTransaction({
      treasuryKeypair,
      treasuryAccount: treasuryAccount(),
      sellerWallet: sellerKeypair.publicKey(),
      balanceId: '0'.repeat(72),
      asset,
      needsTrustline: true,
    });

    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.hint()).toEqual(treasuryKeypair.signatureHint());
    expect(tx.signatures[0]!.hint()).not.toEqual(sellerKeypair.signatureHint());

    // Re-parsing the XDR the API would hand back to a client confirms the
    // seller's signature slot is genuinely empty, not just unchecked here.
    const reparsed = new StellarSdk.Transaction(tx.toXDR(), StellarSdk.Networks.TESTNET);
    expect(reparsed.signatures).toHaveLength(1);
  });
});

describe('createSellerClaimableBalance', () => {
  const sellerWallet = sellerKeypair.publicKey();

  beforeEach(() => {
    mockLoadAccount.mockReset();
    mockSubmitTransaction.mockReset();
    mockOperationCall.mockReset();
    mockForTransaction.mockClear();
    getCircuitBreaker('stellar-horizon-claimable').reset();
    process.env.AGENT_WALLET_SECRET = treasuryKeypair.secret();
    delete process.env.CLAIM_RECLAIM_SECONDS;
  });

  it('throws when the treasury wallet is not configured', async () => {
    delete process.env.AGENT_WALLET_SECRET;
    await expect(
      createSellerClaimableBalance({ sellerWallet, amount: '1.0000000', tokenCode: 'USDC' }),
    ).rejects.toThrow('AGENT_WALLET_SECRET');
  });

  it('submits createClaimableBalance and returns the Horizon-assigned balance id', async () => {
    mockLoadAccount.mockResolvedValue(new StellarSdk.Account(treasuryKeypair.publicKey(), '1'));
    mockSubmitTransaction.mockResolvedValue({ hash: 'creation-tx-hash' });
    mockOperationCall.mockResolvedValue({
      records: [{ type: 'create_claimable_balance', balance_id: 'balance-abc' }],
    });

    const result = await createSellerClaimableBalance({
      sellerWallet,
      amount: '4.7500000',
      tokenCode: 'USDC',
    });

    expect(result).toEqual({
      balanceId: 'balance-abc',
      txHash: 'creation-tx-hash',
      reclaimSeconds: 180 * 24 * 60 * 60,
    });
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it('throws if Horizon never returns a balance_id for the operation', async () => {
    mockLoadAccount.mockResolvedValue(new StellarSdk.Account(treasuryKeypair.publicKey(), '1'));
    mockSubmitTransaction.mockResolvedValue({ hash: 'creation-tx-hash' });
    mockOperationCall.mockResolvedValue({ records: [{ type: 'create_claimable_balance' }] });

    await expect(
      createSellerClaimableBalance({ sellerWallet, amount: '1.0000000', tokenCode: 'USDC' }),
    ).rejects.toThrow('balance_id');
  });
});

describe('listClaimableBalancesForSeller', () => {
  beforeEach(() => {
    mockClaimantCall.mockReset();
    mockClaimant.mockClear();
    getCircuitBreaker('stellar-horizon-claimable').reset();
  });

  it('maps Horizon claimable balance records for a claimant', async () => {
    mockClaimantCall.mockResolvedValue({
      records: [
        {
          id: 'balance-1',
          amount: '10.0000000',
          asset: `USDC:${TESTNET_USDC_ISSUER}`,
          last_modified_ledger: 42,
          sponsor: treasuryKeypair.publicKey(),
        },
      ],
    });

    const result = await listClaimableBalancesForSeller(sellerKeypair.publicKey());

    expect(mockClaimant).toHaveBeenCalledWith(sellerKeypair.publicKey());
    expect(result).toEqual([
      {
        balanceId: 'balance-1',
        amount: '10.0000000',
        assetCode: 'USDC',
        lastModifiedLedger: 42,
        sponsor: treasuryKeypair.publicKey(),
      },
    ]);
  });
});
