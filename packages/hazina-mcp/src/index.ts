#!/usr/bin/env node
/**
 * index.ts — CLI entrypoint. Stdio transport by default (what Claude
 * Desktop/Code expect); set HAZINA_MCP_TRANSPORT=http to run the
 * streamable-HTTP transport instead (#593).
 *
 * Diagnostic logging goes to stderr via console.error, never stdout — the
 * stdio transport uses stdout exclusively for JSON-RPC framing.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createHazinaMcpServer } from './server.js';
import { startHttpServer } from './httpServer.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.transport === 'http') {
    startHttpServer(config);
    return;
  }

  const { server } = createHazinaMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[hazina-mcp] stdio transport connected');
}

main().catch(err => {
  console.error('[hazina-mcp] fatal startup error:', err);
  process.exit(1);
});
