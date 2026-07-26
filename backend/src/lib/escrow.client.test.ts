import { beforeEach, describe, expect, it, vi } from 'vitest';

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ADMIN_KEYPAIR = StellarSdk.Keypair.random();

// Mock the admin-signed contract layer and the RPC server.
const { mockCallContract, mockGetAgentPublicKey, mockSimulate, mockGetAccount } = vi.hoisted(
  () => ({
    mockCallContract: vi.fn(),
    mockGetAgentPublicKey: vi.fn(),
    mockSimulate: vi.fn(),
    mockGetAccount: vi.fn(),
  }),
);

// Keep the real ContractCallError class (escrow.client.ts does `instanceof`
// checks on it to map contract panic codes) while stubbing the network-facing
// callContract/getAgentPublicKey functions.
vi.mock('../agent/agent.wallet', async () => {
  const actual =
    await vi.importActual<typeof import('../agent/agent.wallet')>('../agent/agent.wallet');
  return {
    ...actual,
    callContract: mockCallContract,
    getAgentPublicKey: mockGetAgentPublicKey,
  };
});

// Use the real Stellar SDK for encoding helpers, but stub the RPC server so no
// network call is made during simulation-backed reads/builds.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual =
    await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockRpcServer {
    simulateTransaction = mockSimulate;
    getAccount = mockGetAccount;
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
import { ContractCallError } from '../agent/agent.wallet';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { PaymentError } from '../payments/stellar.service';
import {
  toStroops,
  fromStroops,
  releaseEscrow,
  refundEscrow,
  getEscrow,
  buildLockTx,
} from './escrow.client';

const ADMIN_PUBLIC = ADMIN_KEYPAIR.publicKey();
const BUYER = StellarSdk.Keypair.random().publicKey();
const SELLER = StellarSdk.Keypair.random().publicKey();

/** Build a real EscrowRecord ScVal so decode logic runs against genuine XDR. */
function makeEscrowRecordScVal(overrides: Partial<Record<string, unknown>> = {}) {
  const record = {
    escrow_id: 7n,
    dataset_id: 'ds-abc',
    buyer: BUYER,
    seller: SELLER,
    amount: 10_000_000n, // 1.0 token in stroops
    token: CONTRACT_ID,
    deadline: 1_800_000_000n,
    buyer_confirmed: false,
    platform_fee_bps: 500,
    released: false,
    refunded: false,
    disputed: false,
    dispute_deadline: null,
    ...overrides,
  };

  return StellarSdk.nativeToScVal(record, {
    type: {
      escrow_id: ['symbol', 'u64'],
      dataset_id: ['symbol', 'string'],
      buyer: ['symbol', 'address'],
      seller: ['symbol', 'address'],
      amount: ['symbol', 'i128'],
      token: ['symbol', 'address'],
      deadline: ['symbol', 'u64'],
      buyer_confirmed: ['symbol', 'bool'],
      platform_fee_bps: ['symbol', 'u32'],
      released: ['symbol', 'bool'],
      refunded: ['symbol', 'bool'],
      disputed: ['symbol', 'bool'],
      dispute_deadline: ['symbol', 'option'],
    },
  });
}

describe('escrow.client', () => {
  beforeEach(() => {
    mockCallContract.mockReset();
    mockGetAgentPublicKey.mockReset();
    mockSimulate.mockReset();
    mockGetAccount.mockReset();
    process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;
    process.env.USDC_SAC_ADDRESS = CONTRACT_ID;
    mockGetAgentPublicKey.mockReturnValue(ADMIN_PUBLIC);
    mockGetAccount.mockResolvedValue(new StellarSdk.Account(ADMIN_PUBLIC, '0'));
    // release/refund/getEscrow share the 'soroban-rpc' breaker with
    // agent.wallet.ts's callContract — reset between tests for isolation.
    getCircuitBreaker('soroban-rpc').reset();
  });

  describe('unit conversion', () => {
    it('round-trips stroops without FP drift', () => {
      expect(toStroops(1)).toBe(10_000_000n);
      expect(toStroops(0.1)).toBe(1_000_000n);
      expect(fromStroops(10_000_000n)).toBe(1);
      expect(fromStroops('1000000')).toBe(0.1);
    });
  });

  describe('releaseEscrow', () => {
    it('calls release() as admin and returns the tx hash', async () => {
      mockCallContract.mockResolvedValue('release-hash');
      const hash = await releaseEscrow(7);
      expect(hash).toBe('release-hash');
      expect(mockCallContract).toHaveBeenCalledWith(CONTRACT_ID, 'release', expect.any(Array));
    });

    it('throws when the admin key is not configured', async () => {
      mockGetAgentPublicKey.mockReturnValue(null);
      await expect(releaseEscrow(7)).rejects.toThrow('AGENT_WALLET_SECRET');
      expect(mockCallContract).not.toHaveBeenCalled();
    });

    it('throws a clear error when ESCROW_CONTRACT_ID is unset', async () => {
      delete process.env.ESCROW_CONTRACT_ID;
      await expect(releaseEscrow(7)).rejects.toThrow('ESCROW_CONTRACT_ID');
    });

    it('maps a recognised contract panic code to a safe PaymentError, never the raw payload', async () => {
      mockCallContract.mockRejectedValue(
        new ContractCallError(
          'Contract simulation failed for release',
          '{"error":"HostError: Error(Contract, #6)","accountId":"GLEAKEDSEQUENCE"}',
        ),
      );
      const err: Error = await releaseEscrow(7).catch(e => e);
      expect(err).toBeInstanceOf(PaymentError);
      expect(err.message).toBe('Escrow already released');
      expect(err.message).not.toContain('GLEAKEDSEQUENCE');
    });

    it('falls back to a generic sanitized error for an unrecognised contract failure', async () => {
      mockCallContract.mockRejectedValue(
        new ContractCallError(
          'Contract simulation failed for release',
          '{"accountId":"GLEAKEDSEQUENCE","sequence":"12345"}',
        ),
      );
      const err: Error = await releaseEscrow(7).catch(e => e);
      expect(err).not.toBeInstanceOf(PaymentError);
      expect(err.message).toBe('Failed to release escrow #7 — please try again');
      expect(err.message).not.toContain('GLEAKEDSEQUENCE');
    });
  });

  describe('refundEscrow', () => {
    it('calls refund() as admin and returns the tx hash', async () => {
      mockCallContract.mockResolvedValue('refund-hash');
      const hash = await refundEscrow(3);
      expect(hash).toBe('refund-hash');
      expect(mockCallContract).toHaveBeenCalledWith(CONTRACT_ID, 'refund', expect.any(Array));
    });
  });

  describe('getEscrow', () => {
    it('decodes a contract EscrowRecord from a successful simulation', async () => {
      mockSimulate.mockResolvedValue({
        // isSimulationSuccess() checks for `transactionData`; retval carries the record.
        transactionData: {},
        result: { retval: makeEscrowRecordScVal() },
      });

      const state = await getEscrow(7);
      expect(state).toMatchObject({
        escrowId: 7,
        datasetId: 'ds-abc',
        buyer: BUYER,
        seller: SELLER,
        amount: 1,
        amountStroops: '10000000',
        platformFeeBps: 500,
        released: false,
        refunded: false,
        disputed: false,
        buyerConfirmed: false,
      });
    });

    it('reflects released/disputed flags', async () => {
      mockSimulate.mockResolvedValue({
        transactionData: {},
        result: {
          retval: makeEscrowRecordScVal({ released: true, disputed: true, buyer_confirmed: true }),
        },
      });
      const state = await getEscrow(7);
      expect(state.released).toBe(true);
      expect(state.disputed).toBe(true);
      expect(state.buyerConfirmed).toBe(true);
    });

    it('throws when the simulation fails', async () => {
      mockSimulate.mockResolvedValue({ error: 'boom' });
      await expect(getEscrow(7)).rejects.toThrow('get_escrow');
    });

    it('maps a recognised contract panic code from a failed read to PaymentError', async () => {
      mockSimulate.mockResolvedValue({ error: 'Error(Contract, #8)' });
      const err: Error = await getEscrow(7).catch(e => e);
      expect(err).toBeInstanceOf(PaymentError);
      expect(err.message).toBe('Escrow not found');
    });

    it('opens the circuit breaker after repeated RPC failures and fails fast without simulating again', async () => {
      // getEscrow's getAccount call swallows a rejection with a fallback
      // account, but the breaker still records the failure before that
      // fallback kicks in — so a flaky RPC endpoint still trips the breaker.
      mockGetAccount.mockRejectedValue(new Error('network down'));
      mockSimulate.mockRejectedValue(new Error('network down'));

      for (let i = 0; i < 5; i++) {
        await expect(getEscrow(7)).rejects.toThrow();
      }

      mockSimulate.mockClear();
      await expect(getEscrow(7)).rejects.toThrow(CircuitBreakerOpenError);
      expect(mockSimulate).not.toHaveBeenCalled();
    });
  });

  describe('buildLockTx', () => {
    it('assembles an unsigned lock() XDR authorised by the buyer', async () => {
      mockGetAccount.mockResolvedValue(new StellarSdk.Account(BUYER, '0'));
      // assembleTransaction reads sorobanData / minResourceFee off the sim; provide
      // a realistic success shape by simulating a genuine build.
      const spy = vi.spyOn(StellarSdk.rpc, 'assembleTransaction').mockReturnValue({
        build: () =>
          ({
            toXDR: () => 'unsigned-xdr',
          }) as unknown as StellarSdk.Transaction,
      } as unknown as ReturnType<typeof StellarSdk.rpc.assembleTransaction>);
      mockSimulate.mockResolvedValue({
        result: { retval: StellarSdk.nativeToScVal(0, { type: 'u64' }) },
        transactionData: {},
      });

      const { xdr, contractId } = await buildLockTx({
        buyer: BUYER,
        seller: SELLER,
        amount: 1,
        datasetId: 'ds-abc',
        tokenCode: 'USDC',
      });

      expect(xdr).toBe('unsigned-xdr');
      expect(contractId).toBe(CONTRACT_ID);
      spy.mockRestore();
    });

    it('throws when no SAC address is configured for the token', async () => {
      mockGetAccount.mockResolvedValue(new StellarSdk.Account(BUYER, '0'));
      await expect(
        buildLockTx({
          buyer: BUYER,
          seller: SELLER,
          amount: 1,
          datasetId: 'ds',
          tokenCode: 'EURC',
        }),
      ).rejects.toThrow('EURC_SAC_ADDRESS');
    });
  });
});
