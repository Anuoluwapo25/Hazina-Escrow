import express, { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { tomlBasicString, wellKnownStellarTomlRouter } from '../stellar-toml.router';

const SIGNING_SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x77)).secret();
const SIGNING_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x77)).publicKey();

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(wellKnownStellarTomlRouter);
  return app;
}

describe('GET /.well-known/stellar.toml', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['AUTH_MODE', 'WEB_AUTH_SIGNING_KEY', 'WEB_AUTH_JWT_SECRET']) {
      saved[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value ?? '';
    }
  });

  it('serves text/plain TOML with the network passphrase and sign-in endpoint', async () => {
    process.env.AUTH_MODE = 'legacy';
    const res = await request(buildApp()).get('/.well-known/stellar.toml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toMatch(/^NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"$/m);
    expect(res.text).toMatch(/^WEB_AUTH_ENDPOINT = "https?:\/\/[^"]+\/api\/v1\/auth"$/m);
  });

  it('advertises the web-auth signing key when SEP-10 is enabled', async () => {
    process.env.AUTH_MODE = 'sep10';
    process.env.WEB_AUTH_SIGNING_KEY = SIGNING_SECRET;
    const res = await request(buildApp()).get('/.well-known/stellar.toml');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`SIGNING_KEY = "${SIGNING_KEY}"`);
  });

  it('omits SIGNING_KEY when SEP-10 is not configured', async () => {
    process.env.AUTH_MODE = 'legacy';
    const res = await request(buildApp()).get('/.well-known/stellar.toml');
    expect(res.text).not.toContain('SIGNING_KEY');
  });

  it('escapes TOML special characters in advertised values', async () => {
    expect(tomlBasicString('plain')).toBe('"plain"');
    expect(tomlBasicString('a "quote" and \\ backslash')).toBe(
      '"a \\"quote\\" and \\\\ backslash"',
    );
    expect(tomlBasicString('line\nbreak')).toBe('"line\\nbreak"');
  });
});
