/**
 * cli.smoke.test.ts — spawns the real CLI entrypoint (src/index.ts, via tsx,
 * no build step required) as a child process and talks to it over a real
 * stdio transport, the same way Claude Desktop/Code would. Proves the
 * process actually starts, speaks MCP over stdio, and exposes all five
 * tools — independent of the in-memory-transport tests in server.test.ts,
 * which never touch the CLI entrypoint or process boundary.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

describe('CLI entrypoint (stdio, real subprocess)', () => {
  it('starts, speaks MCP over stdio, and lists all five tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, 'node_modules', '.bin', 'tsx'), 'src/index.ts'],
      cwd: packageRoot,
      env: { HAZINA_MCP_DEMO: '1', HAZINA_API_URL: 'http://127.0.0.1:1' },
    });
    const client = new Client({ name: 'smoke-test-client', version: '0.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual([
        'get_dataset',
        'get_purchase_history',
        'purchase_dataset',
        'quote_purchase',
        'search_datasets',
      ]);
    } finally {
      await client.close();
    }
  }, 20_000);
});
