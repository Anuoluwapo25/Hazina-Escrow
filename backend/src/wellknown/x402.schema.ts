/**
 * x402.schema.ts — JSON Schema (draft-07) for the manifest served at
 * GET /.well-known/x402 (#593). Published alongside the manifest itself at
 * GET /.well-known/x402.schema.json, referenced by the manifest's `$schema`
 * field, so an agent (or a test — see x402.router.test.ts) can validate the
 * document without hardcoding its shape.
 */
export const X402_SCHEMA_URL_PATH = '/.well-known/x402.schema.json';

export const x402ManifestJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://hazina.example/.well-known/x402.schema.json',
  title: 'Hazina x402 service manifest',
  type: 'object',
  required: ['x402Version', 'service', 'asset', 'payment', 'endpoints'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    x402Version: { type: 'integer', const: 1 },
    service: {
      type: 'object',
      required: ['name', 'description', 'network', 'networkPassphrase'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        network: { type: 'string', enum: ['stellar-testnet', 'stellar-mainnet'] },
        networkPassphrase: { type: 'string' },
      },
    },
    asset: {
      type: 'object',
      required: ['code', 'network'],
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        issuer: { type: 'string' },
        network: { const: 'stellar' },
      },
    },
    payment: {
      type: 'object',
      required: ['scheme', 'memoFormat', 'expiresInSeconds'],
      additionalProperties: false,
      properties: {
        scheme: { type: 'string' },
        memoFormat: { type: 'string' },
        expiresInSeconds: { type: 'integer', minimum: 1 },
      },
    },
    endpoints: {
      type: 'object',
      required: ['catalog', 'datasetDetail', 'quote', 'verify'],
      additionalProperties: false,
      properties: {
        catalog: { type: 'string' },
        datasetDetail: { type: 'string' },
        quote: { type: 'string' },
        verify: { type: 'string' },
      },
    },
    pricing: {
      type: 'object',
      required: ['model', 'currency', 'note'],
      additionalProperties: false,
      properties: {
        model: { type: 'string' },
        currency: { type: 'string' },
        note: { type: 'string' },
      },
    },
  },
} as const;
