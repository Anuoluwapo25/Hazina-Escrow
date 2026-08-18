import { beforeEach, describe, expect, it, vi } from 'vitest';

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const destinationAddress = `G${'A'.repeat(55)}`;

const { mockLoadAccount } = vi.hoisted(() => ({ mockLoadAccount: vi.fn() }));

vi.mock('@stellar/stellar-sdk', () => {
  class MockServer {
    loadAccount = mockLoadAccount;
  }
  return {
    Horizon: { Server: MockServer },
  };
});

import { checkDestinationReady, classifyDestinationFailure, __clearPreflightCache } from './trustline.service';
import { getCircuitBreaker } from '../common/circuit-breaker';

describe('checkDestinationReady', () => {
  beforeEach(() => {
    mockLoadAccount.mockReset();
    __clearPreflightCache();
    getCircuitBreaker('stellar-horizon-preflight').reset();
    delete process.env.STELLAR_TIMEOUT_MS;
  });

  it('returns ready for XLM without inspecting trustlines', async () => {
    mockLoadAccount.mockResolvedValue({ balances: [] });
    const result = await checkDestinationReady(destinationAddress, 'XLM');
    expect(result).toEqual({ ready: true });
  });

  it('returns account_not_found for a 404 from Horizon', async () => {
    mockLoadAccount.mockRejectedValue({ response: { status: 404 } });
    const result = await checkDestinationReady(destinationAddress, 'USDC');
    expect(result).toEqual({ ready: false, reason: 'account_not_found' });
  });

  it('returns no_trustline when the account has no matching balance line', async () => {
    mockLoadAccount.mockResolvedValue({ balances: [{ asset_type: 'native' }] });
    const result = await checkDestinationReady(destinationAddress, 'USDC');
    expect(result).toEqual({ ready: false, reason: 'no_trustline' });
  });

  it('returns not_authorized when the trustline exists but is unauthorized', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          is_authorized: false,
        },
      ],
    });
    const result = await checkDestinationReady(destinationAddress, 'USDC');
    expect(result).toEqual({ ready: false, reason: 'not_authorized' });
  });

  it('returns ready when the trustline exists and is authorized', async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          is_authorized: true,
        },
      ],
    });
    const result = await checkDestinationReady(destinationAddress, 'USDC');
    expect(result).toEqual({ ready: true });
  });

  it('caches the result for repeated calls', async () => {
    mockLoadAccount.mockResolvedValue({ balances: [] });
    await checkDestinationReady(destinationAddress, 'XLM');
    await checkDestinationReady(destinationAddress, 'XLM');
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});

describe('classifyDestinationFailure', () => {
  it('classifies op_no_trust from Horizon result_codes', () => {
    const err = {
      response: { data: { extras: { result_codes: { operations: ['op_no_trust'] } } } },
    };
    expect(classifyDestinationFailure(err)).toBe('no_trustline');
  });

  it('classifies op_no_destination from Horizon result_codes', () => {
    const err = {
      response: { data: { extras: { result_codes: { operations: ['op_no_destination'] } } } },
    };
    expect(classifyDestinationFailure(err)).toBe('account_not_found');
  });

  it('classifies op_not_authorized from Horizon result_codes', () => {
    const err = {
      response: { data: { extras: { result_codes: { operations: ['op_not_authorized'] } } } },
    };
    expect(classifyDestinationFailure(err)).toBe('not_authorized');
  });

  it('falls back to scanning the message text', () => {
    expect(classifyDestinationFailure(new Error('submit failed: op_no_trust'))).toBe(
      'no_trustline',
    );
  });

  it('returns null for unrelated errors', () => {
    expect(classifyDestinationFailure(new Error('op_underfunded'))).toBeNull();
    expect(classifyDestinationFailure(null)).toBeNull();
  });
});
