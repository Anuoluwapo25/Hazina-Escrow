import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../../lib/launchtube.client', () => ({
  submitViaLaunchtube: vi.fn(),
  LaunchtubeError: class LaunchtubeError extends Error {},
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { passkeyWalletRouter } from '../passkeyWallet.router';
import { submitViaLaunchtube, LaunchtubeError } from '../../lib/launchtube.client';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', passkeyWalletRouter);
  return app;
}

describe('passkeyWalletRouter', () => {
  const originalJwt = process.env.LAUNCHTUBE_JWT;
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LAUNCHTUBE_JWT = 'test-jwt';
    app = buildApp();
  });

  afterEach(() => {
    process.env.LAUNCHTUBE_JWT = originalJwt;
  });

  describe('POST /wallet/passkey/deploy', () => {
    it('returns 400 when xdr is missing', async () => {
      const res = await request(app).post('/api/wallet/passkey/deploy').send({});
      expect(res.status).toBe(400);
      expect(submitViaLaunchtube).not.toHaveBeenCalled();
    });

    it('returns 503 when Launchtube is not configured', async () => {
      delete process.env.LAUNCHTUBE_JWT;
      const res = await request(app).post('/api/wallet/passkey/deploy').send({ xdr: 'AAAA...' });
      expect(res.status).toBe(503);
      expect(submitViaLaunchtube).not.toHaveBeenCalled();
    });

    it('relays the signed deploy carrier to Launchtube and returns its result', async () => {
      vi.mocked(submitViaLaunchtube).mockResolvedValue({ hash: 'deploy-hash-123' });
      const res = await request(app)
        .post('/api/wallet/passkey/deploy')
        .send({ xdr: 'AAAAdeploy...' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, hash: 'deploy-hash-123' });
      expect(submitViaLaunchtube).toHaveBeenCalledWith('AAAAdeploy...');
    });

    it('never leaks the Launchtube JWT in a successful response', async () => {
      vi.mocked(submitViaLaunchtube).mockResolvedValue({ hash: 'deploy-hash-123' });
      const res = await request(app)
        .post('/api/wallet/passkey/deploy')
        .send({ xdr: 'AAAAdeploy...' });

      expect(JSON.stringify(res.body)).not.toContain('test-jwt');
    });

    it('returns 502 with a sanitized message when Launchtube rejects the submission', async () => {
      vi.mocked(submitViaLaunchtube).mockRejectedValue(new LaunchtubeError('insufficient credits'));
      const res = await request(app)
        .post('/api/wallet/passkey/deploy')
        .send({ xdr: 'AAAAdeploy...' });

      expect(res.status).toBe(502);
      expect(res.body.detail).toBe('insufficient credits');
    });
  });

  describe('POST /wallet/passkey/submit', () => {
    it('returns 400 when xdr is missing', async () => {
      const res = await request(app).post('/api/wallet/passkey/submit').send({});
      expect(res.status).toBe(400);
    });

    it('relays a signed transaction to Launchtube and returns its result', async () => {
      vi.mocked(submitViaLaunchtube).mockResolvedValue({ hash: 'submit-hash-456' });
      const res = await request(app)
        .post('/api/wallet/passkey/submit')
        .send({ xdr: 'AAAAsubmit...' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, hash: 'submit-hash-456' });
      expect(submitViaLaunchtube).toHaveBeenCalledWith('AAAAsubmit...');
    });

    it('returns 503 when Launchtube is not configured', async () => {
      delete process.env.LAUNCHTUBE_JWT;
      const res = await request(app)
        .post('/api/wallet/passkey/submit')
        .send({ xdr: 'AAAAsubmit...' });
      expect(res.status).toBe(503);
    });

    it('returns 502 on an unexpected relay failure without leaking internals', async () => {
      vi.mocked(submitViaLaunchtube).mockRejectedValue(new Error('ECONNRESET'));
      const res = await request(app)
        .post('/api/wallet/passkey/submit')
        .send({ xdr: 'AAAAsubmit...' });

      expect(res.status).toBe(502);
      expect(res.body.detail).toBeUndefined();
    });
  });
});
