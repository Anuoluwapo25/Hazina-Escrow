/**
 * config.ts — environment configuration for the Hazina MCP server.
 *
 * `walletSecret` is read here and nowhere else that a tool handler can see —
 * it must never become a tool argument or appear in a tool result (#593).
 */

export interface HazinaMcpConfig {
  /** Base URL of the Hazina backend REST API. */
  apiUrl: string;
  /** Bearer token for the backend's payments endpoints (`API_KEY`). */
  apiKey?: string;
  /** Stellar secret key (S…) this server signs purchases with. Unset ⇒ real purchases are unavailable. */
  walletSecret?: string;
  /** Dry-run mode: quotes and verifies purchases without ever signing or spending. */
  demo: boolean;
  /** Hard cap, in USDC, on a single purchase_dataset call. */
  maxSpendPerCall: number;
  /** Hard cap, in USDC, on total spend across this server process's lifetime. */
  maxSpendPerSession: number;
  /** Which MCP transport to start when running as a standalone process. */
  transport: 'stdio' | 'http';
  /** Port for the streamable-HTTP transport (ignored in stdio mode). */
  httpPort: number;
}

const DEFAULT_API_URL = 'http://localhost:3001';
const DEFAULT_MAX_SPEND_PER_CALL = 1;
const DEFAULT_MAX_SPEND_PER_SESSION = 5;
const DEFAULT_HTTP_PORT = 8420;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HazinaMcpConfig {
  const apiUrl = (env.HAZINA_API_URL ?? DEFAULT_API_URL).trim().replace(/\/+$/, '');
  const apiKey = env.HAZINA_API_KEY?.trim() || undefined;
  const walletSecret = env.HAZINA_WALLET_SECRET?.trim() || undefined;
  const demo = parseBoolFlag(env.HAZINA_MCP_DEMO);
  const maxSpendPerCall = parsePositiveNumber(
    env.HAZINA_MCP_MAX_SPEND_PER_CALL,
    DEFAULT_MAX_SPEND_PER_CALL,
  );
  const maxSpendPerSession = parsePositiveNumber(
    env.HAZINA_MCP_MAX_SPEND_PER_SESSION,
    DEFAULT_MAX_SPEND_PER_SESSION,
  );
  const transport = env.HAZINA_MCP_TRANSPORT === 'http' ? 'http' : 'stdio';
  const httpPort = parsePositiveNumber(env.HAZINA_MCP_HTTP_PORT, DEFAULT_HTTP_PORT);

  return {
    apiUrl,
    apiKey,
    walletSecret,
    demo,
    maxSpendPerCall,
    maxSpendPerSession,
    transport,
    httpPort,
  };
}
