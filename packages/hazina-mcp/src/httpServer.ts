/**
 * httpServer.ts — streamable-HTTP transport, behind HAZINA_MCP_TRANSPORT=http
 * (#593: "stdio first, streamable HTTP behind a flag"). Stateful: each MCP
 * session gets its own transport/session id, so each client also gets its
 * own SpendTracker rather than sharing spend limits across callers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HazinaMcpConfig } from './config.js';
import { createHazinaMcpServer } from './server.js';

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export function startHttpServer(config: HazinaMcpConfig): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

      if (!transport) {
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports.set(id, newTransport);
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) transports.delete(newTransport.sessionId);
        };
        const { server } = createHazinaMcpServer(config);
        await server.connect(newTransport);
        transport = newTransport;
      }

      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    })().catch(err => {
      console.error('[hazina-mcp] request handling failed:', err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  httpServer.listen(config.httpPort, () => {
    console.error(`[hazina-mcp] streamable HTTP transport listening on :${config.httpPort}/mcp`);
  });
}
