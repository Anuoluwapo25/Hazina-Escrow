import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('applies safe defaults with an empty env', () => {
    const config = loadConfig({});
    expect(config.apiUrl).toBe('http://localhost:3001');
    expect(config.demo).toBe(false);
    expect(config.maxSpendPerCall).toBe(1);
    expect(config.maxSpendPerSession).toBe(5);
    expect(config.transport).toBe('stdio');
    expect(config.walletSecret).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
  });

  it('reads every var from env', () => {
    const config = loadConfig({
      HAZINA_API_URL: 'https://api.example.com/',
      HAZINA_API_KEY: 'key-123',
      HAZINA_WALLET_SECRET: 'S'.repeat(56),
      HAZINA_MCP_DEMO: '1',
      HAZINA_MCP_MAX_SPEND_PER_CALL: '2.5',
      HAZINA_MCP_MAX_SPEND_PER_SESSION: '20',
      HAZINA_MCP_TRANSPORT: 'http',
      HAZINA_MCP_HTTP_PORT: '9000',
    });

    expect(config.apiUrl).toBe('https://api.example.com');
    expect(config.apiKey).toBe('key-123');
    expect(config.walletSecret).toBe('S'.repeat(56));
    expect(config.demo).toBe(true);
    expect(config.maxSpendPerCall).toBe(2.5);
    expect(config.maxSpendPerSession).toBe(20);
    expect(config.transport).toBe('http');
    expect(config.httpPort).toBe(9000);
  });

  it('accepts HAZINA_MCP_DEMO=true as well as 1', () => {
    expect(loadConfig({ HAZINA_MCP_DEMO: 'true' }).demo).toBe(true);
    expect(loadConfig({ HAZINA_MCP_DEMO: 'false' }).demo).toBe(false);
    expect(loadConfig({ HAZINA_MCP_DEMO: '0' }).demo).toBe(false);
  });

  it('falls back to defaults for invalid numeric env values', () => {
    const config = loadConfig({
      HAZINA_MCP_MAX_SPEND_PER_CALL: 'not-a-number',
      HAZINA_MCP_MAX_SPEND_PER_SESSION: '-5',
    });
    expect(config.maxSpendPerCall).toBe(1);
    expect(config.maxSpendPerSession).toBe(5);
  });

  it('defaults transport to stdio for any value other than "http"', () => {
    expect(loadConfig({ HAZINA_MCP_TRANSPORT: 'sse' }).transport).toBe('stdio');
  });
});
