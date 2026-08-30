import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ADMIN_PUBLIC = StellarSdk.Keypair.random().publicKey();

// Mock the admin-signed contract layer and the RPC server.
const {
  mockGetAgentPublicKey,
  mockSimulate,
  mockGetAccount,
  mockSendTransaction,
  mockGetTransaction,
} = vi.hoisted(() => ({
  mockGetAgentPublicKey: vi.fn(),
  mockSimulate: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockGetTransaction: vi.fn(),
}));

// Keep the real agent.wallet module (access-pass.client only uses
// getAgentPublicKey for a simulation source) while stubbing its return value.
vi.mock('../agent/agent.wallet', async () => {
  const actual =
    await vi.importActual<typeof import('../agent/agent.wallet')>('../agent/agent.wallet');
  return {
    ...actual,
    getAgentPublicKey: mockGetAgentPublicKey,
  };
});

// Use the real Stellar SDK for encoding helpers, but stub the RPC server so no
// network call is made during simulation-backed reads/builds or relays.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual =
    await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockRpcServer {
    simulateTransaction = mockSimulate;
    getAccount = mockGetAccount;
    sendTransaction = mockSendTransaction;
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
import { getCircuitBreaker } from '../common/circuit-breaker';
import { addressToScVal, stringToScVal } from './scval';
import {
  AccessCheckUnavailableError,
  AccessPassError,
  stroopsToAmount,
  hasAccess,
  getPass,
  getPlan,
  getSeatsUsed,
  decodePlanRecord,
  decodePassRecord,
  buildDefinePlanTx,
  buildSubscribeTx,
  buildRenewTx,
  submitSignedAccessTx,
  clearAccessReadCache,
  ACCESS_PASS_ERROR_MESSAGES,
} from './access-pass.client';

const BUYER = StellarSdk.Keypair.random().publicKey();
const SELLER = StellarSdk.Keypair.random().publicKey();

function makePlanRecordScVal(overrides: Partial<Record<string, unknown>> = {}) {
  const record = {
    plan_id: 3n,
    seller: SELLER,
    dataset_id: 'ds-abc',
    price_per_period: 500_000n, // 0.05 token
    period_seconds: 604_800n, // one week
    max_seats: 25,
    active: true,
    ...overrides,
  };

  return StellarSdk.nativeToScVal(record, {
    type: {
      plan_id: ['symbol', 'u64'],
      seller: ['symbol', 'address'],
      dataset_id: ['symbol', 'string'],
      price_per_period: ['symbol', 'i128'],
      period_seconds: ['symbol', 'u64'],
      max_seats: ['symbol', 'u32'],
      active: ['symbol', 'bool'],
    },
  });
}

function makePassRecordScVal(overrides: Partial<Record<string, unknown>> = {}) {
  const record = {
    plan_id: 3n,
    buyer: BUYER,
    dataset_id: 'ds-abc',
    start: 1_800_000_000n,
    expiry: 1_800_864_000n,
    term_period_seconds: 604_800n,
    amount_paid: 500_000n,
    fee_bps: 500,
    revoked: false,
    ...overrides,
  };

  return StellarSdk.nativeToScVal(record, {
    type: {
      plan_id: ['symbol', 'u64'],
      buyer: ['symbol', 'address'],
      dataset_id: ['symbol', 'string'],
      start: ['symbol', 'u64'],
      expiry: ['symbol', 'u64'],
      term_period_seconds: ['symbol', 'u64'],
      amount_paid: ['symbol', 'i128'],
      fee_bps: ['symbol', 'u32'],
      revoked: ['symbol', 'bool'],
    },
  });
}

/** A successful simulation response shape carrying `retval`. */
function simOk(retval: StellarSdk.xdr.ScVal) {
  // isSimulationSuccess() checks for `transactionData`; retval carries the result.
  return { transactionData: {}, result: { retval } };
}

describe('access-pass.client', () => {
  beforeEach(() => {
    mockGetAgentPublicKey.mockReset();
    mockSimulate.mockReset();
    mockGetAccount.mockReset();
    mockSendTransaction.mockReset();
    mockGetTransaction.mockReset();
    process.env.ACCESS_PASS_CONTRACT_ID = CONTRACT_ID;
    mockGetAgentPublicKey.mockReturnValue(ADMIN_PUBLIC);
    mockGetAccount.mockResolvedValue(new StellarSdk.Account(BUYER, '0'));
    clearAccessReadCache();
    // Reads share the 'soroban-rpc' breaker with agent.wallet and
    // escrow.client — reset between tests for isolation.
    getCircuitBreaker('soroban-rpc').reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('unit conversion + error table', () => {
    it('round-trips stroops to display amounts without FP drift at typical prices', () => {
      expect(stroopsToAmount(10_000_000n)).toBe(1);
      expect(stroopsToAmount(500_000n)).toBeCloseTo(0.05, 10);
      expect(stroopsToAmount('1000000')).toBe(0.1);
    });

    it('defines a safe message for every contract panic code 1-17 with no leaks', () => {
      for (let code = 1; code <= 17; code++) {
        const message = ACCESS_PASS_ERROR_MESSAGES[code];
        expect(message, `code ${code} must have a mapped message`).toBeTruthy();
        // None of our authored messages leak env var names or key material.
        expect(message).not.toMatch(/SECRET|KEY|env/i);
      }
      expect(Object.keys(ACCESS_PASS_ERROR_MESSAGES).length).toBe(17);
    });
  });

  describe('hasAccess (fail-closed read)', () => {
    it('returns true when the contract reports an active pass', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(true, { type: 'bool' })));
      await expect(hasAccess(BUYER, 'ds-abc')).resolves.toBe(true);
    });

    it('returns false when the contract reports no access — a real answer, not an error', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(false, { type: 'bool' })));
      await expect(hasAccess(BUYER, 'ds-abc')).resolves.toBe(false);
    });

    it('throws AccessCheckUnavailableError when the simulation fails (never silently false)', async () => {
      mockSimulate.mockRejectedValue(new Error('rpc exploded'));
      const err: Error = await hasAccess(BUYER, 'ds-abc').catch(e => e);
      expect(err).toBeInstanceOf(AccessCheckUnavailableError);
    });

    it('throws AccessCheckUnavailableError when ESCROW-style contract id is unset', async () => {
      delete process.env.ACCESS_PASS_CONTRACT_ID;
      await expect(hasAccess(BUYER, 'ds-abc')).rejects.toThrow(AccessCheckUnavailableError);
    });

    it('fails closed through an open circuit breaker without touching the RPC again', async () => {
      mockGetAccount.mockRejectedValue(new Error('network down'));
      mockSimulate.mockRejectedValue(new Error('network down'));

      for (let i = 0; i < 5; i++) {
        await expect(hasAccess(BUYER, 'ds-abc')).rejects.toThrow(AccessCheckUnavailableError);
      }

      mockSimulate.mockClear();
      // The open breaker short-circuits before any new network attempt, and
      // the failure surfaces as the documented fail-closed error — never as
      // a raw breaker exception leaking to callers.
      await expect(hasAccess(BUYER, 'ds-abc')).rejects.toThrow(AccessCheckUnavailableError);
      expect(mockSimulate).not.toHaveBeenCalled();
    });
  });

  describe('read cache', () => {
    it('serves repeated reads within the TTL from cache without new simulations', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(true, { type: 'bool' })));

      await hasAccess(BUYER, 'ds-abc');
      await hasAccess(BUYER, 'ds-abc');
      expect(mockSimulate).toHaveBeenCalledTimes(1);

      // Different key → fresh read; feed a genuine PassRecord this time.
      mockSimulate.mockResolvedValue(simOk(makePassRecordScVal()));
      await getPass(BUYER, 'ds-abc');
      expect(mockSimulate).toHaveBeenCalledTimes(2);
    });

    it('expires entries after the TTL and re-simulates; errors are never cached', async () => {
      vi.useFakeTimers();
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(true, { type: 'bool' })));
      await hasAccess(BUYER, 'ds-abc');

      vi.advanceTimersByTime(15_001); // READ_CACHE_TTL_MS + 1
      await hasAccess(BUYER, 'ds-abc');
      expect(mockSimulate).toHaveBeenCalledTimes(2);
      vi.useRealTimers();

      // A failing read must not poison the cache: next call retries.
      mockSimulate.mockRejectedValueOnce(new Error('transient'));
      await expect(hasAccess(SELLER, 'ds-abc')).rejects.toThrow(AccessCheckUnavailableError);
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(true, { type: 'bool' })));
      await expect(hasAccess(SELLER, 'ds-abc')).resolves.toBe(true);
    });

    it('clearAccessReadCache drops every entry immediately', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(true, { type: 'bool' })));
      await hasAccess(BUYER, 'ds-abc');
      clearAccessReadCache();
      await hasAccess(BUYER, 'ds-abc');
      expect(mockSimulate).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPass / getPlan / decoders', () => {
    it('decodes a PassRecord against genuine XDR', async () => {
      mockSimulate.mockResolvedValue(simOk(makePassRecordScVal()));
      const pass = await getPass(BUYER, 'ds-abc');
      expect(pass).toMatchObject({
        planId: 3,
        buyer: BUYER,
        datasetId: 'ds-abc',
        start: 1_800_000_000,
        expiry: 1_800_864_000,
        termPeriodSeconds: 604_800,
        amountPaidStroops: '500000',
        amountPaid: 0.05,
        feeBps: 500,
        revoked: false,
      });
    });

    it('maps the Option::None case (no pass held) to null', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.xdr.ScVal.scvVoid()));
      await expect(getPass(BUYER, 'ds-abc')).resolves.toBeNull();
    });

    it('decodes a PlanRecord including exact stroop pricing', async () => {
      mockSimulate.mockResolvedValue(simOk(makePlanRecordScVal()));
      const plan = await getPlan(3);
      expect(plan).toMatchObject({
        planId: 3,
        seller: SELLER,
        datasetId: 'ds-abc',
        pricePerPeriodStroops: '500000',
        pricePerPeriod: 0.05,
        periodSeconds: 604_800,
        maxSeats: 25,
        active: true,
      });
    });

    it('reads the live seat count as an unsigned integer', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal(24, { type: 'u32' })));
      await expect(getSeatsUsed(3)).resolves.toBe(24);
    });

    it('fails closed when the seat count decodes to garbage', async () => {
      mockSimulate.mockResolvedValue(simOk(StellarSdk.nativeToScVal('NaN', { type: 'string' })));
      const err: Error = await getSeatsUsed(3).catch(e => e);
      expect(err).toBeInstanceOf(AccessCheckUnavailableError);
    });

    it('exposes decoders that agree with their async wrappers', () => {
      const scval = makePassRecordScVal({ revoked: true });
      expect(decodePassRecord(scval).revoked).toBe(true);
      const planScval = makePlanRecordScVal({ active: false });
      expect(decodePlanRecord(planScval).active).toBe(false);
    });
  });

  describe('transaction builders', () => {
    function captureTxAndAssemble() {
      let captured: StellarSdk.Transaction | undefined;
      const spy = vi.spyOn(StellarSdk.rpc, 'assembleTransaction').mockImplementation(tx => {
        captured = tx as StellarSdk.Transaction;
        return {
          build: () => ({ toXDR: () => 'unsigned-xdr' }) as unknown as StellarSdk.Transaction,
        } as unknown as ReturnType<typeof StellarSdk.rpc.assembleTransaction>;
      });
      mockSimulate.mockResolvedValue({
        transactionData: {},
        result: { retval: StellarSdk.xdr.ScVal.scvVoid() },
      });
      return {
        spy,
        invokeArgs: () =>
          // tx.operations[0] is the high-level wrapper; go through the raw
          // envelope for the xdr accessors, then into the INVOKE_CONTRACT arm.
          // Length is asserted by every caller before this runs, so the
          // indexed accesses below are safe; `as` casts satisfy
          // noUncheckedIndexedAccess without the banned `!` assertion.
          (
            (captured as StellarSdk.Transaction)
              .toEnvelope()
              .v1()
              .tx()
              .operations()[0] as StellarSdk.xdr.Operation
          )
            .body()
            .invokeHostFunctionOp()
            .hostFunction()
            .invokeContract(),
      };
    }

    it('buildDefinePlanTx encodes define_plan(seller, dataset_id, price_i128, period_u64, seats_u32) in order', async () => {
      mockGetAccount.mockResolvedValue(new StellarSdk.Account(SELLER, '0'));
      const { spy, invokeArgs } = captureTxAndAssemble();

      const built = await buildDefinePlanTx({
        seller: SELLER,
        datasetId: 'ds-abc',
        pricePerPeriod: 0.5,
        periodSeconds: 2_592_000,
        maxSeats: 50,
      });

      expect(built.xdr).toBe('unsigned-xdr');
      expect(built.contractId).toBe(CONTRACT_ID);
      const args = invokeArgs();
      expect(args.functionName().toString()).toBe('define_plan');
      const opArgs = args.args();
      expect(opArgs.length).toBe(5);
      // Length asserted above; non-null assertions are safe.
      expect(StellarSdk.scValToNative(opArgs[0] as StellarSdk.xdr.ScVal)).toBe(SELLER);
      expect(StellarSdk.scValToNative(opArgs[1] as StellarSdk.xdr.ScVal)).toBe('ds-abc');
      expect(StellarSdk.scValToNative(opArgs[2] as StellarSdk.xdr.ScVal)).toBe(5_000_000n); // 0.5 in stroops
      expect(StellarSdk.scValToNative(opArgs[3] as StellarSdk.xdr.ScVal)).toBe(2_592_000n);
      expect(StellarSdk.scValToNative(opArgs[4] as StellarSdk.xdr.ScVal)).toBe(50);
      spy.mockRestore();
    });

    it('buildSubscribeTx encodes subscribe(buyer, dataset_id, plan_id) in order', async () => {
      const { spy, invokeArgs } = captureTxAndAssemble();

      const built = await buildSubscribeTx({ buyer: BUYER, datasetId: 'ds-abc', planId: 7 });

      expect(built.contractId).toBe(CONTRACT_ID);
      const args = invokeArgs();
      expect(args.functionName().toString()).toBe('subscribe');
      const opArgs = args.args();
      expect(opArgs.length).toBe(3);
      expect(StellarSdk.scValToNative(opArgs[0] as StellarSdk.xdr.ScVal)).toBe(BUYER);
      expect(StellarSdk.scValToNative(opArgs[1] as StellarSdk.xdr.ScVal)).toBe('ds-abc');
      expect(StellarSdk.scValToNative(opArgs[2] as StellarSdk.xdr.ScVal)).toBe(7n);
      spy.mockRestore();
    });

    it('buildRenewTx encodes renew(buyer, dataset_id) in order', async () => {
      const { spy, invokeArgs } = captureTxAndAssemble();

      await buildRenewTx({ buyer: BUYER, datasetId: 'ds-abc' });

      const args = invokeArgs();
      expect(args.functionName().toString()).toBe('renew');
      const opArgs = args.args();
      expect(opArgs.length).toBe(2);
      expect(StellarSdk.scValToNative(opArgs[0] as StellarSdk.xdr.ScVal)).toBe(BUYER);
      expect(StellarSdk.scValToNative(opArgs[1] as StellarSdk.xdr.ScVal)).toBe('ds-abc');
      spy.mockRestore();
    });

    it('maps a recognised panic code from a failed build sim to a safe AccessPassError', async () => {
      mockSimulate.mockResolvedValue({ error: 'Error(Contract, #11)' });
      const err: Error = await buildSubscribeTx({
        buyer: BUYER,
        datasetId: 'ds-abc',
        planId: 1,
      }).catch(e => e);
      expect(err).toBeInstanceOf(AccessPassError);
      expect(err.message).toBe('All seats for this plan are taken');
    });

    it('falls back to a sanitized generic message for unrecognised build failures', async () => {
      mockSimulate.mockResolvedValue({ error: '{"accountId":"GLEAKED"}' });
      const err: Error = await buildSubscribeTx({
        buyer: BUYER,
        datasetId: 'ds-abc',
        planId: 1,
      }).catch(e => e);
      expect(err).toBeInstanceOf(AccessPassError);
      expect(err.message).toBe('subscribe() simulation failed — please try again');
      expect(err.message).not.toContain('GLEAKED');
    });
  });

  describe('submitSignedAccessTx (relay + poll)', () => {
    /** A genuine signed renew() transaction, built entirely offline. */
    function makeSignedTx(): string {
      const kp = StellarSdk.Keypair.random();
      const source = new StellarSdk.Account(kp.publicKey(), '0');
      const contract = new StellarSdk.Contract(CONTRACT_ID);
      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
      })
        .addOperation(
          contract.call('renew', addressToScVal(kp.publicKey()), stringToScVal('ds-abc')),
        )
        .setTimeout(30)
        .build();
      tx.sign(kp);
      return tx.toXDR();
    }

    it('confirms a submitted transaction on SUCCESS and returns its hash', async () => {
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'a'.repeat(64),
      });
      mockGetTransaction.mockResolvedValue({
        status: StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS,
      });

      await expect(submitSignedAccessTx(makeSignedTx())).resolves.toEqual({
        txHash: 'a'.repeat(64),
      });
      expect(mockGetTransaction).toHaveBeenCalledWith('a'.repeat(64));
    });

    it('surfaces an immediate send rejection (ERROR) as a sanitized AccessPassError', async () => {
      mockSendTransaction.mockResolvedValue({
        status: 'ERROR',
        hash: 'b'.repeat(64),
        errorResult: { code: 'tx_failed', detail: 'GLEAKEDSEQUENCE=42' },
      });

      const err: Error = await submitSignedAccessTx(makeSignedTx()).catch(e => e);
      expect(err).toBeInstanceOf(AccessPassError);
      expect(err.message).toBe('subscription transaction submit error — please try again');
      expect(err.message).not.toContain('GLEAKEDSEQUENCE');
      expect(mockGetTransaction).not.toHaveBeenCalled();
    });

    it('throws when the transaction fails on-chain after being accepted', async () => {
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'c'.repeat(64),
      });
      mockGetTransaction.mockResolvedValue({
        status: StellarSdk.rpc.Api.GetTransactionStatus.FAILED,
      });

      await expect(submitSignedAccessTx(makeSignedTx())).rejects.toThrow(AccessPassError);
    });

    it('keeps polling while the transaction stays NOT_FOUND until it succeeds', async () => {
      vi.useFakeTimers();
      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'd'.repeat(64) });
      mockGetTransaction
        .mockResolvedValueOnce({ status: StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND })
        .mockResolvedValueOnce({ status: StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND })
        .mockResolvedValue({ status: StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS });

      const pending = submitSignedAccessTx(makeSignedTx());
      // Two 1s poll backoffs must elapse before the third poll succeeds.
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ txHash: 'd'.repeat(64) });
      expect(mockGetTransaction).toHaveBeenCalledTimes(3);
    });
  });
});
