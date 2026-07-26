import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../../lib/escrow.client', () => ({
  buildLockTx: vi.fn(),
  submitSignedLock: vi.fn(),
  getEscrow: vi.fn(),
  releaseEscrow: vi.fn(),
  refundEscrow: vi.fn(),
  resolveDispute: vi.fn(),
  buildConfirmDeliveryTx: vi.fn(),
  buildRaiseDisputeTx: vi.fn(),
}));

vi.mock('../../common/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('../../common/storage')>();
  return {
    ...actual,
    getDataset: vi.fn(),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { escrowRouter } from '../escrow.router';
import {
  buildLockTx,
  submitSignedLock,
  getEscrow,
  releaseEscrow,
  refundEscrow,
  resolveDispute,
  buildConfirmDeliveryTx,
  buildRaiseDisputeTx,
} from '../../lib/escrow.client';
import { getDataset } from '../../common/storage';
import type { Dataset } from '../../common/storage';

const SELLER = `G${'A'.repeat(55)}`;
const BUYER = `G${'B'.repeat(55)}`;
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const DATASET: Dataset = {
  id: 'ds-1',
  name: 'Test Dataset',
  description: 'desc',
  type: 'yield-data',
  pricePerQuery: 1,
  sellerWallet: SELLER,
  data: { rows: [1] },
  queriesServed: 0,
  totalEarned: 0,
  createdAt: new Date().toISOString(),
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', escrowRouter);
  return app;
}

const ADMIN_KEY = 'test-admin-key';

describe('escrow.router', () => {
  let app: Express;

  beforeEach(() => {
    app = makeApp();
    process.env.ESCROW_CONTRACT_ID = CONTRACT;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    vi.mocked(getDataset).mockResolvedValue(DATASET);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('when the escrow contract is not configured', () => {
    beforeEach(() => {
      delete process.env.ESCROW_CONTRACT_ID;
    });

    it('returns 503 from a buyer endpoint', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: BUYER, datasetId: 'ds-1' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    });

    it('returns 503 from an admin endpoint', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/release')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(503);
    });
  });

  describe('POST /escrow/lock/build', () => {
    it('builds an unsigned lock tx for the dataset price', async () => {
      vi.mocked(buildLockTx).mockResolvedValue({ xdr: 'unsigned-xdr', contractId: CONTRACT });
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: BUYER, datasetId: 'ds-1' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, xdr: 'unsigned-xdr', amount: 1 });
      expect(buildLockTx).toHaveBeenCalledWith(
        expect.objectContaining({ buyer: BUYER, seller: SELLER, amount: 1, datasetId: 'ds-1' }),
      );
    });

    it('returns 404 when the dataset is missing', async () => {
      vi.mocked(getDataset).mockResolvedValue(undefined as unknown as Dataset);
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: BUYER, datasetId: 'nope' });
      expect(res.status).toBe(404);
    });

    it('rejects an amount that does not match the dataset price', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: BUYER, datasetId: 'ds-1', amount: 999 });
      expect(res.status).toBe(400);
      expect(buildLockTx).not.toHaveBeenCalled();
    });

    it('rejects an invalid buyer address at validation', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: 'not-an-address', datasetId: 'ds-1' });
      expect(res.status).toBe(400);
    });

    it('returns 502 when the client throws', async () => {
      vi.mocked(buildLockTx).mockRejectedValue(new Error('rpc down'));
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/build')
        .send({ buyer: BUYER, datasetId: 'ds-1' });
      expect(res.status).toBe(502);
    });
  });

  describe('POST /escrow/lock/submit', () => {
    it('relays a signed lock and returns the escrow id', async () => {
      vi.mocked(submitSignedLock).mockResolvedValue({ txHash: 'hash', escrowId: 9 });
      const res = await request(app)
        .post('/api/v1/payments/escrow/lock/submit')
        .send({ signedXdr: 'signed' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, txHash: 'hash', escrowId: 9 });
    });

    it('validates a missing signedXdr', async () => {
      const res = await request(app).post('/api/v1/payments/escrow/lock/submit').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /escrow/confirm/build & /escrow/dispute/build', () => {
    it('builds a confirm_delivery tx', async () => {
      vi.mocked(buildConfirmDeliveryTx).mockResolvedValue({ xdr: 'confirm-xdr' });
      const res = await request(app)
        .post('/api/v1/payments/escrow/confirm/build')
        .send({ buyer: BUYER, escrowId: 3 });
      expect(res.status).toBe(200);
      expect(res.body.xdr).toBe('confirm-xdr');
    });

    it('builds a raise_dispute tx with an evidence hash', async () => {
      vi.mocked(buildRaiseDisputeTx).mockResolvedValue({ xdr: 'dispute-xdr' });
      const res = await request(app)
        .post('/api/v1/payments/escrow/dispute/build')
        .send({ buyer: BUYER, escrowId: 3, evidenceHash: 'ab'.repeat(32) });
      expect(res.status).toBe(200);
      expect(buildRaiseDisputeTx).toHaveBeenCalledWith(
        expect.objectContaining({ buyer: BUYER, escrowId: 3, evidenceHash: expect.any(Buffer) }),
      );
    });

    it('rejects a malformed evidence hash', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/dispute/build')
        .send({ buyer: BUYER, escrowId: 3, evidenceHash: 'xyz' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /escrow/:id', () => {
    it('returns live escrow state', async () => {
      vi.mocked(getEscrow).mockResolvedValue({
        escrowId: 7,
        datasetId: 'ds-1',
        buyer: BUYER,
        seller: SELLER,
        amountStroops: '10000000',
        amount: 1,
        token: CONTRACT,
        deadline: 123,
        buyerConfirmed: false,
        platformFeeBps: 500,
        released: false,
        refunded: false,
        disputed: false,
      });
      const res = await request(app).get('/api/v1/payments/escrow/7');
      expect(res.status).toBe(200);
      expect(res.body.escrow).toMatchObject({ escrowId: 7, amount: 1 });
    });

    it('rejects an invalid id', async () => {
      const res = await request(app).get('/api/v1/payments/escrow/abc');
      expect(res.status).toBe(400);
    });

    it('returns 502 when the read fails', async () => {
      vi.mocked(getEscrow).mockRejectedValue(new Error('not found'));
      const res = await request(app).get('/api/v1/payments/escrow/7');
      expect(res.status).toBe(502);
    });
  });

  describe('admin endpoints', () => {
    it('rejects release without the admin key', async () => {
      const res = await request(app).post('/api/v1/payments/escrow/5/release');
      expect(res.status).toBe(401);
      expect(releaseEscrow).not.toHaveBeenCalled();
    });

    it('releases with the admin key', async () => {
      vi.mocked(releaseEscrow).mockResolvedValue('release-hash');
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/release')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, txHash: 'release-hash' });
    });

    it('refunds with the admin key', async () => {
      vi.mocked(refundEscrow).mockResolvedValue('refund-hash');
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/refund')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(200);
      expect(res.body.txHash).toBe('refund-hash');
    });

    it('resolves a dispute with the admin key', async () => {
      vi.mocked(resolveDispute).mockResolvedValue('resolve-hash');
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/resolve')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ favourBuyer: true });
      expect(res.status).toBe(200);
      expect(resolveDispute).toHaveBeenCalledWith(5, true);
    });

    it('validates the resolve body', async () => {
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/resolve')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 502 when release throws', async () => {
      vi.mocked(releaseEscrow).mockRejectedValue(new Error('chain error'));
      const res = await request(app)
        .post('/api/v1/payments/escrow/5/release')
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(res.status).toBe(502);
    });
  });
});
