import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only getDataset is used by access-pass.routes.
vi.mock('../common/storage', () => ({
  getDataset: vi.fn(),
}));

// Stub the network-facing client functions while keeping the REAL error
// classes — the router maps them via instanceof, so identity must be intact
// across the mock boundary.
const {
  mockHasAccess,
  mockGetPass,
  mockBuildDefinePlanTx,
  mockBuildSubscribeTx,
  mockBuildRenewTx,
  mockSubmitSignedAccessTx,
} = vi.hoisted(() => ({
  mockHasAccess: vi.fn(),
  mockGetPass: vi.fn(),
  mockBuildDefinePlanTx: vi.fn(),
  mockBuildSubscribeTx: vi.fn(),
  mockBuildRenewTx: vi.fn(),
  mockSubmitSignedAccessTx: vi.fn(),
}));

vi.mock('../lib/access-pass.client', async () => {
  const actual = await vi.importActual<typeof import('../lib/access-pass.client')>(
    '../lib/access-pass.client',
  );
  return {
    ...actual,
    hasAccess: mockHasAccess,
    getPass: mockGetPass,
    buildDefinePlanTx: mockBuildDefinePlanTx,
    buildSubscribeTx: mockBuildSubscribeTx,
    buildRenewTx: mockBuildRenewTx,
    submitSignedAccessTx: mockSubmitSignedAccessTx,
  };
});

import * as StellarSdk from '@stellar/stellar-sdk';
import { accessPassRouter } from './access-pass.routes';
import { getDataset } from '../common/storage';
import type { Dataset } from '../common/storage';
import { ingestPlanEvent, resetPlanIndex } from './access-pass.plans';

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
// Real StrKey addresses — the SDK rejects all-zero placeholder accounts.
const BUYER = StellarSdk.Keypair.random().publicKey();
const SELLER = StellarSdk.Keypair.random().publicKey();

const DATASET: Dataset = {
  id: 'ds-subs',
  name: 'Subscription Dataset',
  description: 'Sold as a weekly subscription',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER,
  data: { hidden: true },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/datasets', accessPassRouter);
  return app;
}

/** Build a genuine plan_new event payload exactly as the contract emits it. */
function planNewEvent(planId: number, datasetId: string) {
  return {
    ledger: 100,
    topic: [StellarSdk.xdr.ScVal.scvSymbol('plan_new')],
    value: StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(BigInt(planId), { type: 'u64' }),
      StellarSdk.nativeToScVal(SELLER, { type: 'address' }),
      StellarSdk.nativeToScVal(datasetId, { type: 'string' }),
      StellarSdk.nativeToScVal(500_000n, { type: 'i128' }),
      StellarSdk.nativeToScVal(BigInt(604_800), { type: 'u64' }),
      StellarSdk.nativeToScVal(25, { type: 'u32' }),
    ]),
  };
}

function planSetEvent(planId: number, active: boolean) {
  return {
    ledger: 101,
    topic: [StellarSdk.xdr.ScVal.scvSymbol('plan_set')],
    value: StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(BigInt(planId), { type: 'u64' }),
      StellarSdk.nativeToScVal(active, { type: 'bool' }),
    ]),
  };
}

describe('access-pass routes', () => {
  let app: Express;
  let originalContractId: string | undefined;

  beforeEach(() => {
    app = makeApp();
    originalContractId = process.env.ACCESS_PASS_CONTRACT_ID;
    process.env.ACCESS_PASS_CONTRACT_ID = CONTRACT_ID;
    resetPlanIndex();
    vi.mocked(getDataset).mockReset();
    mockHasAccess.mockReset();
    mockGetPass.mockReset();
    mockBuildDefinePlanTx.mockReset();
    mockBuildSubscribeTx.mockReset();
    mockBuildRenewTx.mockReset();
    mockSubmitSignedAccessTx.mockReset();
  });

  afterEach(() => {
    if (originalContractId === undefined) delete process.env.ACCESS_PASS_CONTRACT_ID;
    else process.env.ACCESS_PASS_CONTRACT_ID = originalContractId;
    resetPlanIndex();
  });

  describe('GET /:id/access-pass', () => {
    it('returns hasAccess + pass details for a valid buyer', async () => {
      mockHasAccess.mockResolvedValue(true);
      mockGetPass.mockResolvedValue({ planId: 3, expiry: 12345 });

      const res = await request(app)
        .get('/api/v1/datasets/ds-subs/access-pass')
        .query({ buyer: BUYER });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        hasAccess: true,
        pass: { planId: 3, expiry: 12345 },
      });
      expect(mockHasAccess).toHaveBeenCalledWith(BUYER, 'ds-subs');
    });

    it('rejects a missing buyer parameter with 400', async () => {
      const res = await request(app).get('/api/v1/datasets/ds-subs/access-pass');
      expect(res.status).toBe(400);
      expect(mockHasAccess).not.toHaveBeenCalled();
    });

    it('rejects a malformed buyer address with 400 before touching the chain', async () => {
      const res = await request(app)
        .get('/api/v1/datasets/ds-subs/access-pass')
        .query({ buyer: 'not-an-address' });
      expect(res.status).toBe(400);
      expect(mockHasAccess).not.toHaveBeenCalled();
    });

    it('maps verification unavailability to fail-closed 503', async () => {
      const { AccessCheckUnavailableError } = await import('../lib/access-pass.client');
      mockHasAccess.mockRejectedValue(new AccessCheckUnavailableError());

      const res = await request(app)
        .get('/api/v1/datasets/ds-subs/access-pass')
        .query({ buyer: BUYER });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ACCESS_CHECK_UNAVAILABLE');
    });

    it('answers 503 with guidance when the contract is not configured', async () => {
      delete process.env.ACCESS_PASS_CONTRACT_ID;
      const res = await request(app)
        .get('/api/v1/datasets/ds-subs/access-pass')
        .query({ buyer: BUYER });
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('ACCESS_PASS_CONTRACT_ID');
    });
  });

  describe('GET /:id/plans', () => {
    it('serves plans ingested from plan_new events through the real indexer', async () => {
      ingestPlanEvent(planNewEvent(0, 'ds-subs'));
      ingestPlanEvent(planNewEvent(1, 'ds-other'));

      const res = await request(app).get('/api/v1/datasets/ds-subs/plans');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.plans).toHaveLength(1); // ds-other filtered out
      expect(res.body.plans[0]).toMatchObject({
        planId: 0,
        datasetId: 'ds-subs',
        seller: SELLER,
        pricePerPeriodStroops: '500000',
        periodSeconds: 604_800,
        maxSeats: 25,
        active: true,
      });
    });

    it('returns an empty list (not an error) when nothing is indexed yet', async () => {
      const res = await request(app).get('/api/v1/datasets/ds-subs/plans');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, plans: [] });
    });

    it('reflects plan_set deactivation/reactivation on the indexed plan', async () => {
      ingestPlanEvent(planNewEvent(0, 'ds-subs'));

      ingestPlanEvent(planSetEvent(0, false));
      let res = await request(app).get('/api/v1/datasets/ds-subs/plans');
      expect(res.body.plans[0].active).toBe(false);

      ingestPlanEvent(planSetEvent(0, true));
      res = await request(app).get('/api/v1/datasets/ds-subs/plans');
      expect(res.body.plans[0].active).toBe(true);
    });
  });

  describe('POST /:id/plans/define-tx', () => {
    const body = {
      seller: SELLER,
      pricePerPeriod: 0.05,
      periodSeconds: 604_800,
      maxSeats: 25,
    };

    it('builds an unsigned XDR for an existing dataset', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);
      mockBuildDefinePlanTx.mockResolvedValue({ xdr: 'xdr-define', contractId: CONTRACT_ID });

      const res = await request(app).post('/api/v1/datasets/ds-subs/plans/define-tx').send(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, xdr: 'xdr-define', contractId: CONTRACT_ID });
      expect(mockBuildDefinePlanTx).toHaveBeenCalledWith(
        expect.objectContaining({ seller: SELLER, datasetId: 'ds-subs' }),
      );
    });

    it('404s when the dataset does not exist', async () => {
      vi.mocked(getDataset).mockResolvedValue(undefined);
      const res = await request(app).post('/api/v1/datasets/nope/plans/define-tx').send(body);
      expect(res.status).toBe(404);
      expect(mockBuildDefinePlanTx).not.toHaveBeenCalled();
    });

    it('rejects out-of-range periods and seats with 400 before building', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);

      const badPeriod = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/define-tx')
        .send({ ...body, periodSeconds: 31 * 24 * 60 * 60 }); // over the 30d cap
      expect(badPeriod.status).toBe(400);

      const zeroSeats = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/define-tx')
        .send({ ...body, maxSeats: 0 });
      expect(zeroSeats.status).toBe(400);

      expect(mockBuildDefinePlanTx).not.toHaveBeenCalled();
    });

    it('maps authored business errors to 400 and infrastructure errors to 502', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);
      const { AccessPassError } = await import('../lib/access-pass.client');

      mockBuildDefinePlanTx.mockRejectedValue(new AccessPassError('Invalid subscription period'));
      const businessErr = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/define-tx')
        .send(body);
      expect(businessErr.status).toBe(400);
      expect(businessErr.body.error).toBe('Invalid subscription period');

      mockBuildDefinePlanTx.mockRejectedValue(new Error('rpc socket hung up'));
      const infraErr = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/define-tx')
        .send(body);
      expect(infraErr.status).toBe(502);
    });
  });

  describe('POST /:id/plans/subscribe-tx', () => {
    it('builds an unsigned subscribe() XDR for the buyer', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);
      mockBuildSubscribeTx.mockResolvedValue({ xdr: 'xdr-sub', contractId: CONTRACT_ID });

      const res = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/subscribe-tx')
        .send({ buyer: BUYER, planId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.xdr).toBe('xdr-sub');
      expect(mockBuildSubscribeTx).toHaveBeenCalledWith({
        buyer: BUYER,
        datasetId: 'ds-subs',
        planId: 3,
      });
    });

    it('rejects a non-integer plan id with 400', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);
      const res = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/subscribe-tx')
        .send({ buyer: BUYER, planId: 'three' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:id/plans/renew-tx', () => {
    it('builds an unsigned renew() XDR for the buyer', async () => {
      vi.mocked(getDataset).mockResolvedValue(DATASET);
      mockBuildRenewTx.mockResolvedValue({ xdr: 'xdr-renew', contractId: CONTRACT_ID });

      const res = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/renew-tx')
        .send({ buyer: BUYER });

      expect(res.status).toBe(200);
      expect(res.body.xdr).toBe('xdr-renew');
      expect(mockBuildRenewTx).toHaveBeenCalledWith({ buyer: BUYER, datasetId: 'ds-subs' });
    });
  });

  describe('POST /:id/plans/submit', () => {
    it('relays a signed XDR and returns the confirmed hash', async () => {
      mockSubmitSignedAccessTx.mockResolvedValue({ txHash: 'f'.repeat(64) });

      const res = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/submit')
        .send({ signedXdr: 'AAAA...' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, txHash: 'f'.repeat(64) });
      expect(mockSubmitSignedAccessTx).toHaveBeenCalledWith('AAAA...');
    });

    it('requires a signedXdr body', async () => {
      const res = await request(app).post('/api/v1/datasets/ds-subs/plans/submit').send({});
      expect(res.status).toBe(400);
      expect(mockSubmitSignedAccessTx).not.toHaveBeenCalled();
    });

    it('propagates authored relay failures as 400', async () => {
      const { AccessPassError } = await import('../lib/access-pass.client');
      mockSubmitSignedAccessTx.mockRejectedValue(
        new AccessPassError('subscription transaction failed on-chain'),
      );

      const res = await request(app)
        .post('/api/v1/datasets/ds-subs/plans/submit')
        .send({ signedXdr: 'AAAA...' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('subscription transaction failed on-chain');
    });
  });
});
