/**
 * x402.router.ts — Issue #593
 *
 * GET /.well-known/x402 — a machine-readable manifest so any AI agent (or
 * the Hazina MCP server in packages/hazina-mcp) can discover what Hazina
 * sells and how to pay for it without reading the docs. Mounted at the
 * domain root (not under /api/v1) — RFC 8615 well-known URIs are always
 * root-relative.
 *
 * Hazina is a multi-seller marketplace, so per-item price is dynamic; the
 * manifest describes the discovery/payment *mechanism* and points at the
 * live catalog/quote endpoints for authoritative per-dataset pricing,
 * rather than embedding a price list here that would drift.
 */
import { Router, Request, Response } from 'express';
import { STELLAR_NETWORK, getNetworkPassphrase, USDC_ISSUER } from '../lib/stellar.config';
import { X402_SCHEMA_URL_PATH, x402ManifestJsonSchema } from './x402.schema';

export const wellKnownRouter = Router();

/**
 * @openapi
 * /.well-known/x402:
 *   get:
 *     summary: x402 service manifest
 *     description: Machine-readable description of Hazina's dataset marketplace for AI agent discovery — accepted asset, network, payment scheme, and the catalog/quote/verify endpoints.
 *     responses:
 *       200:
 *         description: The x402 manifest.
 */
wellKnownRouter.get('/.well-known/x402', (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;

  res.json({
    $schema: `${origin}${X402_SCHEMA_URL_PATH}`,
    x402Version: 1,
    service: {
      name: 'Hazina Data Marketplace',
      description:
        'Web3 data marketplace on Stellar — pay per query, in USDC, for on-chain intelligence datasets.',
      network: STELLAR_NETWORK === 'mainnet' ? 'stellar-mainnet' : 'stellar-testnet',
      networkPassphrase: getNetworkPassphrase(),
    },
    asset: {
      code: 'USDC',
      issuer: USDC_ISSUER,
      network: 'stellar',
    },
    payment: {
      scheme: 'stellar-memo-payment',
      memoFormat: 'haz-<datasetId>-<nonce>',
      expiresInSeconds: 300,
    },
    endpoints: {
      catalog: `${origin}/api/v1/datasets`,
      datasetDetail: `${origin}/api/v1/datasets/{id}`,
      quote: `${origin}/api/v1/payments/query/{id}`,
      verify: `${origin}/api/v1/payments/verify/{id}`,
    },
    pricing: {
      model: 'per-dataset',
      currency: 'USDC',
      note:
        'Price varies per dataset. GET the catalog for current prices, or POST the quote ' +
        'endpoint for one dataset — its response is the authoritative price and payment instructions.',
    },
  });
});

/**
 * @openapi
 * /.well-known/x402.schema.json:
 *   get:
 *     summary: JSON Schema for the x402 manifest
 *     responses:
 *       200:
 *         description: Draft-07 JSON Schema the manifest above validates against.
 */
wellKnownRouter.get(X402_SCHEMA_URL_PATH, (_req: Request, res: Response) => {
  res.json(x402ManifestJsonSchema);
});
