import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAccount, mockSimulate, mockSend, mockGetTransaction } = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockSimulate: vi.fn(),
  mockSend: vi.fn(),
  mockGetTransaction: vi.fn(),
}));

// Stub the RPC server so no network call is made; keep the rest of the SDK
// real so encoding/decoding (ScVal, Keypair, TransactionBuilder) is genuine.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual =
    await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockRpcServer {
    getAccount = mockGetAccount;
    simulateTransaction = mockSimulate;
    sendTransaction = mockSend;
    getTransaction = mockGetTransaction;
  }
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: MockRpcServer,
    },
  };
});

import * as StellarSdk from '@stellar/stellar-sdk';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { callContract, ContractCallError } from './agent.wallet';

const ADMIN_KEYPAIR = StellarSdk.Keypair.random();
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('agent.wallet callContract', () => {
  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSimulate.mockReset();
    mockSend.mockReset();
    mockGetTransaction.mockReset();
    process.env.AGENT_WALLET_SECRET = ADMIN_KEYPAIR.secret();
    delete process.env.CONTRACT_CALL_TIMEOUT_MS;
    // Contract calls share the 'soroban-rpc' breaker with escrow.client.ts —
    // reset it between tests so failures in one test don't leak into another.
    getCircuitBreaker('soroban-rpc').reset();
    mockGetAccount.mockResolvedValue(new StellarSdk.Account(ADMIN_KEYPAIR.publicKey(), '0'));
  });

  afterEach(() => {
    delete process.env.AGENT_WALLET_SECRET;
    delete process.env.CONTRACT_CALL_TIMEOUT_MS;
  });

  it('throws immediately when AGENT_WALLET_SECRET is not configured, without touching the network', async () => {
    delete process.env.AGENT_WALLET_SECRET;
    await expect(callContract(CONTRACT_ID, 'release', [])).rejects.toThrow(
      'AGENT_WALLET_SECRET not configured',
    );
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('sanitizes a simulation failure: throws ContractCallError with a safe message, keeping the raw payload only on rawDetail', async () => {
    mockSimulate.mockResolvedValue({ error: 'Error(Contract, #8)' });

    const err: ContractCallError = await callContract(CONTRACT_ID, 'release', []).catch(e => e);
    expect(err).toBeInstanceOf(ContractCallError);
    expect(err.message).not.toContain('Error(Contract, #8)');
    expect(err.message).toBe('Contract simulation failed for release');
    expect(err.rawDetail).toContain('Error(Contract, #8)');
  });

  it('sanitizes a submit error: never puts the raw errorResult in the thrown message', async () => {
    mockSimulate.mockResolvedValue({
      transactionData: {
        build: () => ({}),
      },
      minResourceFee: '100',
      result: { retval: StellarSdk.xdr.ScVal.scvVoid() },
    });
    vi.spyOn(StellarSdk.rpc.Api, 'isSimulationSuccess').mockReturnValueOnce(true);
    vi.spyOn(StellarSdk.rpc, 'assembleTransaction').mockReturnValueOnce({
      build: () => ({
        sign: () => {},
      }),
    } as unknown as ReturnType<typeof StellarSdk.rpc.assembleTransaction>);
    mockSend.mockResolvedValue({
      status: 'ERROR',
      errorResult: { accountId: 'GSECRETLOOKING...' },
    });

    const err: ContractCallError = await callContract(CONTRACT_ID, 'release', []).catch(e => e);
    expect(err).toBeInstanceOf(ContractCallError);
    expect(err.message).not.toContain('GSECRETLOOKING');
    expect(err.rawDetail).toContain('GSECRETLOOKING');
  });

  it('times out and throws ContractCallError when the transaction never confirms', async () => {
    process.env.CONTRACT_CALL_TIMEOUT_MS = '50';
    vi.spyOn(StellarSdk.rpc.Api, 'isSimulationSuccess').mockReturnValueOnce(true);
    mockSimulate.mockResolvedValue({ result: { retval: StellarSdk.xdr.ScVal.scvVoid() } });
    vi.spyOn(StellarSdk.rpc, 'assembleTransaction').mockReturnValueOnce({
      build: () => ({ sign: () => {} }),
    } as unknown as ReturnType<typeof StellarSdk.rpc.assembleTransaction>);
    mockSend.mockResolvedValue({ status: 'PENDING', hash: 'tx-hash-1' });
    mockGetTransaction.mockResolvedValue({
      status: StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND,
    });

    await expect(callContract(CONTRACT_ID, 'release', [])).rejects.toThrow(/timed out after 50ms/);
  }, 10_000);

  it('opens the circuit breaker after repeated RPC-level failures and fails fast without calling simulateTransaction again', async () => {
    mockGetAccount.mockRejectedValue(new Error('network down'));

    for (let i = 0; i < 5; i++) {
      await expect(callContract(CONTRACT_ID, 'release', [])).rejects.toThrow();
    }

    mockGetAccount.mockClear();
    mockSimulate.mockClear();
    await expect(callContract(CONTRACT_ID, 'release', [])).rejects.toThrow(CircuitBreakerOpenError);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });
});
