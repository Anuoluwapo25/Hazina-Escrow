import { describe, expect, it, vi } from 'vitest';
import { createPurchaseDatasetHandler } from '../tools/purchaseDataset.js';
import { SpendTracker } from '../spendTracker.js';
import { loadConfig } from '../config.js';
import type { HazinaApiClientLike } from '../apiClient.js';
import type { QueryResult, QuotePayload } from '../types.js';

function makeApi(quote: QuotePayload, verifyResult: QueryResult): HazinaApiClientLike {
  return {
    searchDatasets: vi.fn(),
    getDataset: vi.fn(),
    initiateQuery: vi.fn().mockResolvedValue(quote),
    verifyPayment: vi.fn().mockResolvedValue(verifyResult),
    verifyDemo: vi.fn().mockResolvedValue(verifyResult),
  };
}

const custodialQuote: QuotePayload = {
  error: 'Payment Required',
  x402: true,
  mode: 'custodial-demo',
  dataset: { id: 'ds-1', name: 'Test', type: 'x' },
  payment: {
    mode: 'custodial-demo',
    amount: 0.05,
    currency: 'USDC',
    network: 'Stellar Testnet',
    memo: 'haz-ds-1',
    expiresIn: 300,
    paymentAddress: `G${'B'.repeat(55)}`,
    instructions: [],
  },
};

const escrowQuote: QuotePayload = {
  ...custodialQuote,
  mode: 'escrow',
  payment: {
    ...custodialQuote.payment,
    mode: 'escrow',
    paymentAddress: undefined,
    escrowContractId: `C${'D'.repeat(55)}`,
  },
};

const result: QueryResult = {
  success: true,
  transaction: {
    hash: 'real-tx-hash',
    status: 'completed',
    deliveryStatus: 'delivered',
    amount: 0.05,
    sellerReceived: 0.0475,
    platformFee: 0.0025,
  },
};

describe('purchase_dataset handler', () => {
  it('refuses to pay automatically when the backend is in escrow mode', async () => {
    const api = makeApi(escrowQuote, result);
    const handler = createPurchaseDatasetHandler({
      api,
      config: { ...loadConfig({}), demo: false, walletSecret: 'S'.repeat(56) },
      spendTracker: new SpendTracker(1, 5),
      sendPayment: vi.fn(),
    });

    const res = await handler({ id: 'ds-1' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/escrow-mode/i);
  });

  it('errors when no wallet secret is configured and demo mode is off', async () => {
    const api = makeApi(custodialQuote, result);
    const sendPayment = vi.fn();
    const handler = createPurchaseDatasetHandler({
      api,
      config: { ...loadConfig({}), demo: false, walletSecret: undefined },
      spendTracker: new SpendTracker(1, 5),
      sendPayment,
    });

    const res = await handler({ id: 'ds-1' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/no wallet is configured/i);
    expect(sendPayment).not.toHaveBeenCalled();
  });

  it('signs, submits, verifies, and logs a real purchase', async () => {
    const api = makeApi(custodialQuote, result);
    const sendPayment = vi
      .fn()
      .mockResolvedValue({ txHash: 'real-tx-hash', from: 'GFROM', to: 'GTO', amount: '0.05' });
    const spendTracker = new SpendTracker(1, 5);
    const handler = createPurchaseDatasetHandler({
      api,
      config: { ...loadConfig({}), demo: false, walletSecret: 'S'.repeat(56) },
      spendTracker,
      sendPayment,
    });

    const res = await handler({ id: 'ds-1', question: 'top holder?' });

    expect(res.isError).toBeFalsy();
    expect(sendPayment).toHaveBeenCalledWith(
      { secret: 'S'.repeat(56) },
      expect.objectContaining({
        destinationAddress: custodialQuote.payment.paymentAddress,
        amount: 0.05,
      }),
    );
    expect(api.verifyPayment).toHaveBeenCalledWith('ds-1', 'real-tx-hash', 'top holder?');
    expect(spendTracker.getLog()).toHaveLength(1);
    expect(spendTracker.getLog()[0]).toMatchObject({
      datasetId: 'ds-1',
      amount: 0.05,
      demo: false,
    });
  });

  it('never calls sendPayment in demo mode', async () => {
    const api = makeApi(custodialQuote, {
      ...result,
      transaction: { ...result.transaction, hash: 'demo-hash' },
    });
    const sendPayment = vi.fn();
    const handler = createPurchaseDatasetHandler({
      api,
      config: { ...loadConfig({}), demo: true, walletSecret: 'S'.repeat(56) },
      spendTracker: new SpendTracker(1, 5),
      sendPayment,
    });

    const res = await handler({ id: 'ds-1' });

    expect(res.isError).toBeFalsy();
    expect(sendPayment).not.toHaveBeenCalled();
    expect(api.verifyDemo).toHaveBeenCalledWith('ds-1', undefined);
  });

  it('does not spend when the quoted amount exceeds the per-call limit', async () => {
    const api = makeApi(custodialQuote, result);
    const sendPayment = vi.fn();
    const handler = createPurchaseDatasetHandler({
      api,
      config: { ...loadConfig({}), demo: false, walletSecret: 'S'.repeat(56) },
      spendTracker: new SpendTracker(0.01, 5),
      sendPayment,
    });

    const res = await handler({ id: 'ds-1' });
    expect(res.isError).toBe(true);
    expect(sendPayment).not.toHaveBeenCalled();
    expect(api.verifyPayment).not.toHaveBeenCalled();
  });
});
