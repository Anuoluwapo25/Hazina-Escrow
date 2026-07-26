import { beforeEach, describe, expect, it, vi } from 'vitest';

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const {
  mockTransactionCall,
  mockOperationCall,
  mockTransaction,
  mockTransactions,
  mockForTransaction,
  mockOperations,
} = vi.hoisted(() => {
  const transactionCall = vi.fn();
  const operationCall = vi.fn();
  const transaction = vi.fn(() => ({ call: transactionCall }));
  const transactions = vi.fn(() => ({ transaction }));
  const forTransaction = vi.fn(() => ({ call: operationCall }));
  const operations = vi.fn(() => ({ forTransaction }));

  return {
    mockTransactionCall: transactionCall,
    mockOperationCall: operationCall,
    mockTransaction: transaction,
    mockTransactions: transactions,
    mockForTransaction: forTransaction,
    mockOperations: operations,
  };
});

vi.mock('@stellar/stellar-sdk', () => {
  class MockServer {
    transactions = mockTransactions;
    operations = mockOperations;
  }

  return {
    Horizon: {
      Server: MockServer,
    },
  };
});

import { verifyStellarPayment, StellarTimeoutError } from './stellar.service';

const destinationAddress = `G${'A'.repeat(55)}`;

describe('verifyStellarPayment', () => {
  beforeEach(() => {
    mockTransactionCall.mockReset();
    mockOperationCall.mockReset();
    mockTransaction.mockClear();
    mockTransactions.mockClear();
    mockForTransaction.mockClear();
    mockOperations.mockClear();
    // Reset the timeout env var before each test
    delete process.env.STELLAR_TIMEOUT_MS;
  });

  it('returns valid for matching recent USDC payment', async () => {
    mockTransactionCall.mockResolvedValue({
      created_at: new Date().toISOString(),
      memo: 'haz-test',
    });
    mockOperationCall.mockResolvedValue({
      records: [
        {
          type: 'payment',
          to: destinationAddress,
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          amount: '1.0000',
        },
      ],
    });

    const result = await verifyStellarPayment({
      txHash: 'tx-valid',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    });

    expect(result.valid).toBe(true);
    expect(result.actualAmount).toBe(1);
    expect(result.memo).toBe('haz-test');
  });

  it('returns invalid for expired transactions', async () => {
    const oldDate = new Date(Date.now() - 301_000).toISOString();
    mockTransactionCall.mockResolvedValue({
      created_at: oldDate,
      memo: '',
    });
    mockOperationCall.mockResolvedValue({
      records: [
        {
          type: 'payment',
          to: destinationAddress,
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          amount: '1.0000',
        },
      ],
    });

    const result = await verifyStellarPayment({
      txHash: 'tx-expired',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('returns invalid for amount mismatch', async () => {
    mockTransactionCall.mockResolvedValue({
      created_at: new Date().toISOString(),
      memo: '',
    });
    mockOperationCall.mockResolvedValue({
      records: [
        {
          type: 'payment',
          to: destinationAddress,
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          amount: '0.7000',
        },
      ],
    });

    const result = await verifyStellarPayment({
      txHash: 'tx-amount-mismatch',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Amount mismatch');
    expect(result.actualAmount).toBe(0.7);
  });

  it('returns invalid for non-USDC (native XLM) payments', async () => {
    mockTransactionCall.mockResolvedValue({
      created_at: new Date().toISOString(),
      memo: '',
    });
    mockOperationCall.mockResolvedValue({
      records: [
        {
          type: 'payment',
          to: destinationAddress,
          asset_type: 'native',
          amount: '1.0000',
        },
      ],
    });

    const result = await verifyStellarPayment({
      txHash: 'tx-native-asset',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No USDC payment found');
  });

  it('returns transaction-not-found for 404 Horizon responses', async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 404 },
    });

    const result = await verifyStellarPayment({
      txHash: 'tx-not-found',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Transaction not found');
  });

  it('rethrows unexpected Horizon errors', async () => {
    mockTransactionCall.mockRejectedValue(new Error('network unavailable'));

    await expect(
      verifyStellarPayment({
        txHash: 'tx-network-error',
        expectedAmount: 1,
        destinationAddress,
        tokenCode: 'USDC',
      }),
    ).rejects.toThrow('Stellar network error');
  });

  // ── Timeout tests ──────────────────────────────────────────────────────────

  it('throws StellarTimeoutError when Horizon is slow (default 10 s, mocked to 50 ms)', async () => {
    // Override the env timeout to 50 ms so the test is fast
    process.env.STELLAR_TIMEOUT_MS = '50';

    // Simulate a Horizon call that never resolves within the deadline
    mockTransactionCall.mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 5_000)),
    );

    await expect(
      verifyStellarPayment({
        txHash: 'tx-slow',
        expectedAmount: 1,
        destinationAddress,
        tokenCode: 'USDC',
      }),
    ).rejects.toBeInstanceOf(StellarTimeoutError);
  }, 10_000);

  it('StellarTimeoutError message is user-friendly (no raw AbortError)', async () => {
    process.env.STELLAR_TIMEOUT_MS = '50';

    mockTransactionCall.mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 5_000)),
    );

    const err = await verifyStellarPayment({
      txHash: 'tx-slow-message',
      expectedAmount: 1,
      destinationAddress,
      tokenCode: 'USDC',
    }).catch(e => e);

    expect(err).toBeInstanceOf(StellarTimeoutError);
    expect(err.message).not.toContain('AbortError');
    expect(err.message).toMatch(/Stellar Horizon did not respond/i);
  }, 10_000);

  it('respects the STELLAR_TIMEOUT_MS env variable', async () => {
    process.env.STELLAR_TIMEOUT_MS = '100';

    const start = Date.now();
    mockTransactionCall.mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 5_000)),
    );

    await expect(
      verifyStellarPayment({
        txHash: 'tx-env-timeout',
        expectedAmount: 1,
        destinationAddress,
        tokenCode: 'USDC',
      }),
    ).rejects.toBeInstanceOf(StellarTimeoutError);

    // Should have timed out close to 100 ms, not 10 000 ms
    expect(Date.now() - start).toBeLessThan(2_000);
  }, 10_000);
});
