import express, { Express } from 'express';
import request from 'supertest';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { wellKnownRouter } from '../x402.router';
import { x402ManifestJsonSchema } from '../x402.schema';

function buildApp(): Express {
  const app = express();
  app.use(wellKnownRouter);
  return app;
}

describe('GET /.well-known/x402', () => {
  it('returns a manifest with x402Version 1 and no auth required', async () => {
    const res = await request(buildApp()).get('/.well-known/x402');
    expect(res.status).toBe(200);
    expect(res.body.x402Version).toBe(1);
  });

  it('describes the Stellar testnet asset and network by default', async () => {
    const res = await request(buildApp()).get('/.well-known/x402');
    expect(res.body.service.network).toBe('stellar-testnet');
    expect(res.body.service.networkPassphrase).toMatch(/Test SDF Network/);
    expect(res.body.asset).toEqual({
      code: 'USDC',
      issuer: expect.any(String),
      network: 'stellar',
    });
  });

  it('points at absolute, host-derived catalog/quote/verify endpoints', async () => {
    const res = await request(buildApp()).get('/.well-known/x402');
    expect(res.body.endpoints.catalog).toMatch(/^http:\/\/127\.0\.0\.1.*\/api\/v1\/datasets$/);
    expect(res.body.endpoints.quote).toMatch(/\/api\/v1\/payments\/query\/\{id\}$/);
    expect(res.body.endpoints.verify).toMatch(/\/api\/v1\/payments\/verify\/\{id\}$/);
  });

  it('links to its own published schema', async () => {
    const res = await request(buildApp()).get('/.well-known/x402');
    expect(res.body.$schema).toContain('/.well-known/x402.schema.json');
  });

  it('validates against its own published JSON Schema', async () => {
    const res = await request(buildApp()).get('/.well-known/x402');
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(x402ManifestJsonSchema);

    const valid = validate(res.body);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('GET /.well-known/x402.schema.json', () => {
  it('serves the JSON Schema used to validate the manifest', async () => {
    const res = await request(buildApp()).get('/.well-known/x402.schema.json');
    expect(res.status).toBe(200);
    expect(res.body.title).toMatch(/x402/i);
    expect(res.body.required).toContain('x402Version');
  });

  it('is itself a valid draft-07 JSON Schema', async () => {
    const res = await request(buildApp()).get('/.well-known/x402.schema.json');
    const ajv = new Ajv({ strict: false });
    expect(() => ajv.compile(res.body)).not.toThrow();
  });
});
