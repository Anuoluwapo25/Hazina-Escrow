import crypto from 'crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachSellerAuthIfPresent,
  requireSellerJwt,
  requireSellerMutationAuth,
  requireSellerReadAuth,
} from '../auth.middleware';
import { mintSep10Jwt } from '../../auth/sep10.jwt';

const NOW_SEC = () => Math.floor(Date.now() / 1000);
const CLIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const OTHER = 'GCRLWL5ZFBB6K3CVSNUIJDOWWENY3QCHM7DRZQYGNZ3GKJTVRVCVJ6XO';
const SEP10_SECRET = 'web-auth-jwt-secret';
const LEGACY_SECRET = 'legacy-secret';

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signLegacyJwt(payload: Record<string, unknown>): string {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson(payload);
  const sig = crypto
    .createHmac('sha256', LEGACY_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function makeSep10Token(): string {
  return mintSep10Jwt(
    {
      sub: CLIENT,
      iss: 'hazina.example.com',
      sellerWallet: CLIENT,
      jti: 'jti-1',
      ttlSeconds: 900,
      nowSec: NOW_SEC(),
    },
    SEP10_SECRET,
  );
}

function wrap(middleware: (req: Request, res: Response, next: NextFunction) => void): Express {
  const app = express();
  app.use(express.json());
  // Mount under :sellerWallet so requireSellerReadAuth's param-scope check runs.
  app.use('/x/:sellerWallet', (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, next);
  });
  app.get('/x/:sellerWallet', (req: Request, res: Response) => {
    res.json({ ok: true, wallet: req.sellerAuth?.sellerWallet });
  });
  app.use(
    (
      err: { status?: number; message?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

describe('SEP-10-aware seller auth middleware', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'AUTH_MODE',
      'API_KEY',
      'SELLER_JWT_SECRET',
      'WEB_AUTH_JWT_SECRET',
      'NODE_ENV',
    ]) {
      saved[key] = process.env[key];
    }
    process.env.AUTH_MODE = 'sep10';
    process.env.WEB_AUTH_JWT_SECRET = SEP10_SECRET;
    delete process.env.API_KEY;
    delete process.env.SELLER_JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value ?? '';
    }
  });

  it('requireSellerMutationAuth accepts a SEP-10 JWT when the body wallet matches', async () => {
    const app = wrap(requireSellerMutationAuth);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${makeSep10Token()}`)
      .query({ body: 'ignored' })
      .send({ sellerWallet: CLIENT });
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(CLIENT);
  });

  it('requireSellerMutationAuth rejects a SEP-10 JWT whose body wallet differs', async () => {
    const app = wrap(requireSellerMutationAuth);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${makeSep10Token()}`)
      .send({ sellerWallet: OTHER });
    expect(res.status).toBe(403);
  });

  it('requireSellerMutationAuth rejects the shared API key in AUTH_MODE=sep10', async () => {
    process.env.API_KEY = 'shared-key';
    const app = wrap(requireSellerMutationAuth);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', 'Bearer shared-key');
    expect(res.status).toBe(401);
  });

  it('requireSellerMutationAuth accepts the shared API key in AUTH_MODE=both', async () => {
    process.env.API_KEY = 'shared-key';
    process.env.AUTH_MODE = 'both';
    const app = wrap(requireSellerMutationAuth);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', 'Bearer shared-key');
    expect(res.status).toBe(200);
  });

  it('requireSellerMutationAuth still accepts legacy JWT tokens in AUTH_MODE=sep10', async () => {
    process.env.SELLER_JWT_SECRET = LEGACY_SECRET;
    const token = signLegacyJwt({ sellerWallet: CLIENT, exp: NOW_SEC() + 900 });
    const app = wrap(requireSellerMutationAuth);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${token}`)
      .send({ sellerWallet: CLIENT });
    expect(res.status).toBe(200);
  });

  it('requireSellerReadAuth accepts a SEP-10 JWT scoped to the route wallet', async () => {
    const app = wrap(requireSellerReadAuth);
    const res = await request(app)
      .get(`/x/${CLIENT}`)
      .set('Authorization', `Bearer ${makeSep10Token()}`);
    expect(res.status).toBe(200);
  });

  it('requireSellerReadAuth rejects a SEP-10 JWT for another seller wallet', async () => {
    const app = wrap(requireSellerReadAuth);
    const res = await request(app)
      .get(`/x/${OTHER}`)
      .set('Authorization', `Bearer ${makeSep10Token()}`);
    expect(res.status).toBe(403);
  });

  it('requireSellerReadAuth accepts the shared API key in AUTH_MODE=sep10 only when a key is not enabled', async () => {
    // In pure SEP-10 mode the shared key is not a valid credential.
    process.env.API_KEY = 'shared-key';
    const app = wrap(requireSellerReadAuth);
    const res = await request(app).get(`/x/${CLIENT}`).set('Authorization', 'Bearer shared-key');
    expect(res.status).toBe(401);
  });

  it('requireSellerJwt accepts a SEP-10 JWT', async () => {
    const app = wrap(requireSellerJwt);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${makeSep10Token()}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(CLIENT);
  });

  it('requireSellerJwt rejects a token signed by an unknown secret', async () => {
    const app = wrap(requireSellerJwt);
    const bad = mintSep10Jwt(
      {
        sub: CLIENT,
        iss: 'hazina.example.com',
        sellerWallet: CLIENT,
        jti: 'jti-2',
        ttlSeconds: 900,
        nowSec: NOW_SEC(),
      },
      'wrong-secret',
    );
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('attachSellerAuthIfPresent attaches SEP-10 claims without requiring auth', async () => {
    const app = wrap(attachSellerAuthIfPresent);
    const res = await request(app)
      .get('/x/' + CLIENT)
      .set('Authorization', `Bearer ${makeSep10Token()}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(CLIENT);
  });
});
