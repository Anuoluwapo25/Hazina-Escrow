/**
 * standalone.ts — container entrypoint for Sentinel running as its own
 * process, independent of the API host. This is what a compromised or
 * crashed API server must not be able to silently drag down with it — see
 * docker-compose.yml's `sentinel` service and the "sentinel" target in
 * Dockerfile, which run `node dist/sentinel/standalone.js` instead of the
 * main API's `node dist/main.js`.
 *
 * Deliberately minimal: a health check, the solvency/alerts router, and the
 * watcher itself. No dataset/payment/webhook surface — this process's only
 * job is watching the contract.
 */
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { logger } from '../lib/logger';
import { validateAgentWallet } from '../agent/agent.wallet';
import { validateEscrowConfig } from '../lib/stellar.config';
import { sentinelRouter } from './router';
import { buildSentinelEngine, isSentinelEnabled } from './bootstrap';

validateEscrowConfig();

const app = express();
const PORT = process.env.SENTINEL_PORT || 3002;

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hazina-sentinel' }));
app.use('/api', sentinelRouter);

const engine = buildSentinelEngine();

app.listen(PORT, () => {
  logger.info(`[Sentinel] Standalone watcher listening on http://localhost:${PORT}`);

  try {
    validateAgentWallet();
  } catch (err) {
    logger.warn({ err }, '[Sentinel] Agent wallet not configured');
  }

  if (!isSentinelEnabled()) {
    logger.warn(
      '[Sentinel] SENTINEL_ENABLED is not "true" — the standalone container is up but the ' +
        'watcher loop is not running. Set SENTINEL_ENABLED=true to arm it.',
    );
    return;
  }

  void engine.start();
});

function shutdown(): void {
  logger.info('[Sentinel] Shutting down...');
  engine.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
