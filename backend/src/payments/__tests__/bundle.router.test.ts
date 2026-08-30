import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../bundle.service', () => ({
  createBundleRecord: vi.fn(),
  listBundlesWithAvailability: vi.fn(),
  getBundleWithAvailability: vi.fn(),
  buildBundlePurchaseLockTx: vi.fn(),
  submitBundlePurchase: vi.fn(),
  buildBundleConfirmTxs: vi.fn(),
  submitBundleConfirmation: vi.fn(),
  getBundlePurchaseDetail: vi.fn(),
  getCuratorEarnings: vi.fn(),
  getSellerBundleEarnings: vi.fn(),
  getBundlesForSeller: vi.fn(),
  BundleNotFoundError: class BundleNotFoundError extends Error {
    constructor(id: string) {
      super(`Bundle ${id} not found`);
      this.name = 'BundleNotFoundError';
    }
  },
  BundleUnavailableError: class BundleUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BundleUnavailableError';
    }
  },
  BundlePurchaseNotFoundError: class BundlePurchaseNotFoundError extends Error {
    constructor(id: string) {
      super(`Bundle purchase ${id} not found`);
      this.name = 'BundlePurchaseNotFoundError';
    }
  },
  BundlePurchaseStateError: class BundlePurchaseStateError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BundlePurchaseStateError';
    }
  },
  MAX_BUNDLE_COMPONENTS: 99,
}));

import { bundleRouter } from '../bundle.router';
import { InvalidBundleSplitError } from '../bundle.splits';
import { BundleShareMismatchError } from '../../common/storage';
import {
  createBundleRecord,
  listBundlesWithAvailability,
  getBundleWithAvailability,
  buildBundlePurchaseLockTx,
  submitBundlePurchase,
  buildBundleConfirmTxs,
  submitBundleConfirmation,
  getBundlePurchaseDetail,
  getCuratorEarnings,
  getSellerBundleEarnings,
  getBundlesForSeller,
  BundleNotFoundError,
  BundleUnavailableError,
  BundlePurchaseNotFoundError,
  BundlePurchaseStateError,
} from '../bundle.service';

const CURATOR = `G${'C'.repeat(55)}`;
const BUYER = `G${'D'.repeat(55)}`;
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const API_KEY = 'test-api-key';

const validCreateBody = {
  name: 'DeFi Risk Pack',
  description: 'Whale + risk + sentiment',
  curatorWallet: CURATOR,
  totalPrice: 0.12,
  curatorFeeBps: 1000,
  components: [
    { datasetId: 'ds-whale', shareBps: 4500 },
    { datasetId: 'ds-risk', shareBps: 3000 },
    { datasetId: 'ds-sentiment', shareBps: 1500 },
  ],
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', bundleRouter);
  return app;
}

describe('bundle.router', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    process.env.ESCROW_CONTRACT_ID = CONTRACT;
    process.env.API_KEY = API_KEY;
    delete process.env.SELLER_JWT_SECRET;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
    delete process.env.API_KEY;
  });

  describe('POST /bundles (create)', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await request(app).post('/api/v1/bundles').send(validCreateBody);
      expect(res.status).toBe(401);
      expect(createBundleRecord).not.toHaveBeenCalled();
    });

    it('rejects an invalid API key', async () => {
      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', 'Bearer wrong-key')
        .send(validCreateBody);
      expect(res.status).toBe(403);
      expect(createBundleRecord).not.toHaveBeenCalled();
    });

    it('creates a bundle for an authenticated curator', async () => {
      vi.mocked(createBundleRecord).mockResolvedValue({
        ...validCreateBody,
        id: 'bundle-1',
        paymentToken: 'USDC',
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        components: validCreateBody.components.map((c, i) => ({
          ...c,
          id: `c${i}`,
          bundleId: 'bundle-1',
          position: i,
          createdAt: '2026-01-01T00:00:00.000Z',
        })),
      });

      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send(validCreateBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.bundle.id).toBe('bundle-1');
      expect(createBundleRecord).toHaveBeenCalledWith(
        expect.objectContaining({ curatorWallet: CURATOR }),
      );
    });

    it('rejects splits that do not sum to 10000 at the API boundary with a typed 400', async () => {
      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send({ ...validCreateBody, curatorFeeBps: 500 }); // 4500+3000+1500+500 = 9500

      expect(res.status).toBe(400);
      expect(createBundleRecord).not.toHaveBeenCalled();
    });

    it('rejects a zero-share component at the API boundary', async () => {
      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send({
          ...validCreateBody,
          components: [...validCreateBody.components, { datasetId: 'ds-free', shareBps: 0 }],
        });

      expect(res.status).toBe(400);
      expect(createBundleRecord).not.toHaveBeenCalled();
    });

    it('rejects a negative-share component at the API boundary', async () => {
      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send({
          ...validCreateBody,
          components: [
            { datasetId: 'ds-whale', shareBps: -100 },
            { datasetId: 'ds-risk', shareBps: 9100 },
            { datasetId: 'ds-sentiment', shareBps: 1000 },
          ],
        });

      expect(res.status).toBe(400);
      expect(createBundleRecord).not.toHaveBeenCalled();
    });

    it('maps InvalidBundleSplitError from the service layer to a 400', async () => {
      vi.mocked(createBundleRecord).mockRejectedValue(
        new InvalidBundleSplitError('Dataset ds-risk is delisted and cannot be added to a bundle'),
      );

      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send(validCreateBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/delisted/);
    });

    it('maps BundleShareMismatchError from the DB-layer re-check to a 400', async () => {
      vi.mocked(createBundleRecord).mockRejectedValue(
        new BundleShareMismatchError('bundle-1', 9500),
      );

      const res = await request(app)
        .post('/api/v1/bundles')
        .set('Authorization', `Bearer ${API_KEY}`)
        .send(validCreateBody);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /bundles', () => {
    it('lists bundles with availability', async () => {
      vi.mocked(listBundlesWithAvailability).mockResolvedValue([
        { id: 'bundle-1', degraded: false } as never,
      ]);
      const res = await request(app).get('/api/v1/bundles');
      expect(res.status).toBe(200);
      expect(res.body.bundles).toHaveLength(1);
    });
  });

  describe('GET /bundles/:id', () => {
    it('returns 404 for a missing bundle', async () => {
      vi.mocked(getBundleWithAvailability).mockResolvedValue(undefined);
      const res = await request(app).get('/api/v1/bundles/missing');
      expect(res.status).toBe(404);
    });

    it('returns the bundle with its degraded state', async () => {
      vi.mocked(getBundleWithAvailability).mockResolvedValue({
        id: 'bundle-1',
        degraded: true,
        degradedReason: 'Component dataset "X" has been delisted',
      } as never);
      const res = await request(app).get('/api/v1/bundles/bundle-1');
      expect(res.status).toBe(200);
      expect(res.body.bundle.degraded).toBe(true);
      expect(res.body.bundle.degradedReason).toMatch(/delisted/);
    });
  });

  describe('purchase build/submit', () => {
    it('returns 503 when the escrow contract is not configured', async () => {
      delete process.env.ESCROW_CONTRACT_ID;
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(503);
      expect(buildBundlePurchaseLockTx).not.toHaveBeenCalled();
    });

    it('builds a purchase lock tx', async () => {
      vi.mocked(buildBundlePurchaseLockTx).mockResolvedValue({
        xdr: 'unsigned-xdr',
        contractId: CONTRACT,
        bundleId: 'bundle-1',
        componentCount: 4,
        totalPrice: 0.12,
      });
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(200);
      expect(res.body.xdr).toBe('unsigned-xdr');
      expect(buildBundlePurchaseLockTx).toHaveBeenCalledWith('bundle-1', BUYER);
    });

    it('maps BundleUnavailableError to a 409', async () => {
      vi.mocked(buildBundlePurchaseLockTx).mockRejectedValue(
        new BundleUnavailableError('This bundle has been deactivated by its curator'),
      );
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(409);
    });

    it('maps BundleNotFoundError to a 404', async () => {
      vi.mocked(buildBundlePurchaseLockTx).mockRejectedValue(new BundleNotFoundError('bundle-1'));
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(404);
    });

    it('submits a signed purchase', async () => {
      vi.mocked(submitBundlePurchase).mockResolvedValue({
        id: 'purchase-1',
        bundleId: 'bundle-1',
        buyerWallet: BUYER,
        firstEscrowId: 100,
        escrowIds: [100, 101, 102, 103],
        totalAmount: 0.12,
        status: 'delivered',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/submit')
        .send({ buyer: BUYER, signedXdr: 'signed-xdr' });
      expect(res.status).toBe(200);
      expect(res.body.purchase.status).toBe('delivered');
    });

    it('rejects a purchase submit with a missing signedXdr', async () => {
      const res = await request(app)
        .post('/api/v1/bundles/bundle-1/purchase/submit')
        .send({ buyer: BUYER });
      expect(res.status).toBe(400);
      expect(submitBundlePurchase).not.toHaveBeenCalled();
    });
  });

  describe('confirm build/submit', () => {
    it('builds confirm XDRs for the buyer', async () => {
      vi.mocked(buildBundleConfirmTxs).mockResolvedValue([{ escrowId: 100, xdr: 'confirm-xdr' }]);
      const res = await request(app)
        .post('/api/v1/bundles/purchases/purchase-1/confirm/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(200);
      expect(res.body.confirmations).toHaveLength(1);
    });

    it('maps BundlePurchaseStateError to a 400', async () => {
      vi.mocked(buildBundleConfirmTxs).mockRejectedValue(
        new BundlePurchaseStateError(
          "Cannot confirm delivery — purchase is 'locked', expected 'delivered'",
        ),
      );
      const res = await request(app)
        .post('/api/v1/bundles/purchases/purchase-1/confirm/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(400);
    });

    it('maps BundlePurchaseNotFoundError to a 404', async () => {
      vi.mocked(buildBundleConfirmTxs).mockRejectedValue(
        new BundlePurchaseNotFoundError('purchase-1'),
      );
      const res = await request(app)
        .post('/api/v1/bundles/purchases/purchase-1/confirm/build')
        .send({ buyer: BUYER });
      expect(res.status).toBe(404);
    });

    it('submits a signed confirmation', async () => {
      vi.mocked(submitBundleConfirmation).mockResolvedValue({
        id: 'purchase-1',
        bundleId: 'bundle-1',
        buyerWallet: BUYER,
        firstEscrowId: 100,
        escrowIds: [100, 101, 102, 103],
        totalAmount: 0.12,
        status: 'released',
        releaseTxHash: 'release-tx',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const res = await request(app)
        .post('/api/v1/bundles/purchases/purchase-1/confirm/submit')
        .send({ escrowId: 103, signedXdr: 'signed-confirm-xdr' });
      expect(res.status).toBe(200);
      expect(res.body.purchase.status).toBe('released');
      expect(submitBundleConfirmation).toHaveBeenCalledWith(
        'purchase-1',
        103,
        'signed-confirm-xdr',
      );
    });
  });

  describe('GET /bundles/purchases/:purchaseId', () => {
    it('returns 404 for a missing purchase', async () => {
      vi.mocked(getBundlePurchaseDetail).mockResolvedValue(undefined);
      const res = await request(app).get('/api/v1/bundles/purchases/missing');
      expect(res.status).toBe(404);
    });

    it('returns purchase + components', async () => {
      vi.mocked(getBundlePurchaseDetail).mockResolvedValue({
        purchase: { id: 'purchase-1' } as never,
        components: [{ id: 'c1' } as never],
      });
      const res = await request(app).get('/api/v1/bundles/purchases/purchase-1');
      expect(res.status).toBe(200);
      expect(res.body.purchase.id).toBe('purchase-1');
      expect(res.body.components).toHaveLength(1);
    });
  });

  describe('dashboards', () => {
    it('returns curator earnings', async () => {
      vi.mocked(getCuratorEarnings).mockResolvedValue([
        {
          bundleId: 'bundle-1',
          bundleName: 'DeFi Risk Pack',
          active: true,
          totalPurchases: 3,
          releasedPurchases: 2,
          totalEarned: 0.024,
        },
      ]);
      const res = await request(app).get(`/api/v1/bundles/dashboard/curator/${CURATOR}`);
      expect(res.status).toBe(200);
      expect(res.body.bundles[0].totalEarned).toBe(0.024);
    });

    it('returns seller bundle earnings and inclusion list', async () => {
      vi.mocked(getBundlesForSeller).mockResolvedValue([{ id: 'bundle-1' } as never]);
      vi.mocked(getSellerBundleEarnings).mockResolvedValue([
        {
          bundleId: 'bundle-1',
          bundleName: 'DeFi Risk Pack',
          datasetId: 'ds-whale',
          totalEarned: 0.05,
          purchaseCount: 1,
        },
      ]);
      const res = await request(app).get(`/api/v1/bundles/dashboard/seller/${BUYER}`);
      expect(res.status).toBe(200);
      expect(res.body.bundles).toHaveLength(1);
      expect(res.body.earnings[0].totalEarned).toBe(0.05);
    });
  });

  describe('route precedence', () => {
    it('routes /bundles/dashboard/curator/:wallet to the dashboard handler, not GET /bundles/:id', async () => {
      vi.mocked(getCuratorEarnings).mockResolvedValue([]);
      const res = await request(app).get('/api/v1/bundles/dashboard/curator/somewallet');
      expect(res.status).toBe(200);
      expect(getBundleWithAvailability).not.toHaveBeenCalled();
    });

    it('routes /bundles/purchases/:id to the purchase handler, not GET /bundles/:id', async () => {
      vi.mocked(getBundlePurchaseDetail).mockResolvedValue({
        purchase: { id: 'purchase-1' } as never,
        components: [],
      });
      const res = await request(app).get('/api/v1/bundles/purchases/purchase-1');
      expect(res.status).toBe(200);
      expect(getBundleWithAvailability).not.toHaveBeenCalled();
    });
  });
});
