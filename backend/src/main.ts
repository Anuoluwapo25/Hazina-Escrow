import { initializeDatadog } from './common/datadog';
import { initializeSentry, Sentry } from './common/sentry';
import dotenv from 'dotenv';

dotenv.config();
initializeDatadog();
initializeSentry();

import 'express-async-errors';
import express, { Request, Response, NextFunction } from 'express';
import { logger } from './lib/logger';
import { randomUUID } from 'crypto';
import cors from 'cors';
import path from 'path';
import http from 'http';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { datasetsRouter } from './datasets/datasets.router';
import {
  paymentsRouter,
  startDeliveryRetryWorker,
  stopDeliveryRetryWorker,
  startSellerNotificationRetryWorker,
} from './payments/payments.router';
import { agentRouter } from './agent/agent.router';
import { validateAgentWallet } from './agent/agent.wallet';
import { webhooksRouter } from './webhooks/webhook.router';
import { analyticsRouter } from './analytics.router';
import { readStore } from './common/storage';
import { BackupScheduler } from './common/backup.scheduler';
import { backupRouter, setBackupScheduler } from './common/backup.router';
import { createCompressionMiddleware } from './common/compression';
import { requireApiKey } from './common/auth.middleware';
import { sanitizeBody } from './common/sanitize';
import {
  createAgentRateLimitMiddleware,
  createGlobalRateLimitMiddleware,
  createPaymentsRateLimitMiddleware,
} from './common/rateLimit';
import { initializeWebSocketServer } from './websocket/ws-server';
import { HORIZON_URL } from './lib/stellar.config';
import { createCorsOptions } from './common/cors';

const app = express();
const PORT = process.env.PORT || 3001;

const sanitizeHeaders = (headers: Record<string, unknown>) => ({
  ...headers,
  ...(headers.authorization ? { authorization: '[REDACTED]' } : {}),
  ...(headers.cookie ? { cookie: '[REDACTED]' } : {}),
});

app.use(createCompressionMiddleware());
// Ensure client IP is derived correctly when running behind a reverse proxy.
app.set('trust proxy', 1);

// Request correlation ID middleware — runs before all routes so every log line
// and error response can include the same unique ID for a given request.
// Honours a forwarded x-request-id from the client (e.g. the frontend or an
// upstream proxy); falls back to a fresh UUID when none is provided.
app.use((req: Request, res: Response, next: NextFunction) => {
  req.id = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const requestLogger = logger.child({ requestId: req.id });

  const onFinish = () => {
    const durationMs = Date.now() - startTime;

    const logPayload = {
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      headers: sanitizeHeaders(req.headers as Record<string, unknown>),
    };

    if (res.statusCode >= 500) {
      requestLogger.error(logPayload, 'HTTP request completed');
    } else if (res.statusCode >= 400) {
      requestLogger.warn(logPayload, 'HTTP request completed');
    } else {
      requestLogger.info(logPayload, 'HTTP request completed');
    }
  };

  res.on('finish', onFinish);
  res.on('close', () => {
    if (!res.writableEnded) {
      const durationMs = Date.now() - startTime;
      requestLogger.warn(
        {
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode: res.statusCode,
          durationMs,
          headers: sanitizeHeaders(req.headers as Record<string, unknown>),
        },
        'HTTP request aborted',
      );
    }
  });

  next();
});

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '2mb' }));
app.use(sanitizeBody);
const globalLimiter = createGlobalRateLimitMiddleware();
const paymentsLimiter = createPaymentsRateLimitMiddleware();
const agentLimiter = createAgentRateLimitMiddleware();
Sentry.setupExpressErrorHandler(app);

// Rate limiting — global + per-route limits for sensitive endpoints

// Global rate limiting applies to all routes before route handlers run.
app.use(globalLimiter);
app.use('/api/v1/payments', paymentsLimiter);
app.use('/api/v1/agent', agentLimiter);
Sentry.setupExpressErrorHandler(app);

// Initialize backup scheduler
const backupEnabled = process.env.BACKUP_ENABLED !== 'false';
if (backupEnabled) {
  const backupScheduler = new BackupScheduler({
    enabled: true,
    backupDir: process.env.BACKUP_DIR || path.join(__dirname, '../../backups'),
    maxBackups: parseInt(process.env.BACKUP_MAX_BACKUPS || '30', 10),
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || '0 0 * * *', // Daily at midnight by default
  });

  backupScheduler.start();
  setBackupScheduler(backupScheduler);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('[Backup] Stopping backup scheduler...');
    backupScheduler.stop();
  });

  process.on('SIGINT', () => {
    logger.info('[Backup] Stopping backup scheduler...');
    backupScheduler.stop();
    process.exit(0);
  });
}

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Hazina Escrow API',
      version: '1.0.0',
      description: 'API documentation for Hazina Data Escrow platform',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Local development server',
      },
    ],
  },
  apis: ['./src/**/*.ts'], // Path to the API docs
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
// Only expose API docs in non-production environments — avoids leaking internal
// schema details and keeps the route out of the global rate limiter's scope.
if (process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
}

// Health check with service monitoring
const HEALTH_TIMEOUT_MS = 3000;

type CheckResult = 'ok' | 'error' | 'unavailable';

async function withHealthTimeout(fn: () => Promise<CheckResult>): Promise<CheckResult> {
  return Promise.race<CheckResult>([
    fn().catch(() => 'error'),
    new Promise<CheckResult>(resolve => setTimeout(() => resolve('error'), HEALTH_TIMEOUT_MS)),
  ]);
}

async function checkStorage(): Promise<CheckResult> {
  try {
    await readStore();
    return 'ok';
  } catch {
    return 'error';
  }
}

async function checkAnthropic(): Promise<CheckResult> {
  // Anthropic is optional; missing key is unavailable but not an error
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'unavailable';
  }
  return 'ok';
}

async function checkStellar(): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(HORIZON_URL, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

app.get('/health', async (_req, res) => {
  const [storage, anthropic, stellar] = await Promise.all([
    withHealthTimeout(checkStorage),
    withHealthTimeout(checkAnthropic),
    withHealthTimeout(checkStellar),
  ]);

  const checks = { storage, anthropic, stellar };

  // Critical services — any error here means unhealthy
  const criticalOk = storage === 'ok' && stellar === 'ok';

  // Overall status — degraded if optional service (anthropic) unavailable
  const allOk = criticalOk && anthropic === 'ok';
  const status = allOk ? 'ok' : 'degraded';

  // HTTP status code — only return 503 if critical services fail
  const httpStatus = criticalOk ? 200 : 503;

  res.status(httpStatus).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown) => {
  logger.error(
    `[Unhandled Rejection]: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  Sentry.withScope(scope => {
    scope.setTag('source', 'unhandledRejection');
    scope.setLevel('error');
    Sentry.captureException(reason);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err: Error) => {
  logger.error(`[Uncaught Exception]: ${err.message}`);
  Sentry.withScope(scope => {
    scope.setTag('source', 'uncaughtException');
    scope.setLevel('fatal');
    Sentry.captureException(err);
  });
});

// Routes under versioned API namespace.
const v1Router = express.Router();

v1Router.use('/datasets', datasetsRouter);
v1Router.use('/agent', requireApiKey, agentRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/payments', requireApiKey, paymentsRouter);
v1Router.use('/backups', backupRouter);

app.use('/api/v1', v1Router);

// Legacy /api routes redirect to /api/v1 for a transition period.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.originalUrl.startsWith('/api/v1')) {
    return next();
  }

  const targetUrl = `/api/v1${req.originalUrl.slice('/api'.length)}`;
  res.setHeader('Warning', '299 - "Deprecated API version. Use /api/v1/."');
  res.setHeader('Deprecation', 'true');
  res.redirect(308, targetUrl);
});

// Routes
app.use('/api/datasets', datasetsRouter);
app.use('/api', paymentsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api', backupRouter);

// Global error handling middleware — Issue #283 (standard error shape)
app.use(
  (
    err: { status?: number; message?: string; code?: string },
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const status = err.status ?? 500;
    const message = err.message || 'Internal server error';
    // SECURITY: Use the structured logger (not logger.error) so pino's redact
    // rules fire before the record is shipped to Datadog. Passing the raw Error
    // object is intentional — pino serialises it safely. Never interpolate
    // err.message into a template string here as it may include key material.
    logger.error({ requestId: req.id, status, err }, 'Unhandled request error');
    Sentry.withScope(scope => {
      scope.setTag('requestId', req.id);
      scope.setTag('method', req.method);
      scope.setTag('url', req.originalUrl);
      scope.setContext('request', {
        id: req.id,
        method: req.method,
        url: req.originalUrl,
      });
      Sentry.captureException(err);
    });
    res
      .status(status)
      .json({ error: message, code: err.code || 'INTERNAL_ERROR', requestId: req.id });
  },
);

startDeliveryRetryWorker();
startSellerNotificationRetryWorker();

// Create HTTP server and attach Express app
const server = http.createServer(app);

// Initialize WebSocket server
const wsApiKey = process.env.WEBSOCKET_API_KEY || '';
const wsServer = initializeWebSocketServer(server, wsApiKey);

// Add endpoint for WebSocket server stats
app.get('/api/v1/ws/stats', (_req: Request, res: Response) => {
  res.json(wsServer.getStats());
});

server.listen(PORT, () => {
  logger.info(`\n  ██╗  ██╗ █████╗ ███████╗██╗███╗   ██╗ █████╗`);
  logger.info(`  ██║  ██║██╔══██╗╚══███╔╝██║████╗  ██║██╔══██╗`);
  logger.info(`  ███████║███████║  ███╔╝ ██║██╔██╗ ██║███████║`);
  logger.info(`  ██╔══██║██╔══██║ ███╔╝  ██║██║╚██╗██║██╔══██║`);
  logger.info(`  ██║  ██║██║  ██║███████╗██║██║ ╚████║██║  ██║`);
  logger.info(`  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝`);
  logger.info(`\n  Data Escrow API running on http://localhost:${PORT}`);
  logger.info(`  WebSocket server running on ws://localhost:${PORT}/ws\n`);

  // SECURITY: Validate agent wallet at startup — logs the PUBLIC key only.
  // If the secret is absent (e.g. demo mode) this logs a warning instead of
  // throwing so the rest of the server can still start.
  try {
    validateAgentWallet();
  } catch (err) {
    logger.warn({ err }, '[AgentWallet] Wallet not configured — agent payment features disabled');
  }
});

// Graceful shutdown for WebSocket server
process.on('SIGTERM', () => {
  logger.info('[Server] Shutting down gracefully...');
  stopDeliveryRetryWorker();
  wsServer.shutdown();
  server.close(() => {
    logger.info('[Server] HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('[Server] Shutting down gracefully...');
  stopDeliveryRetryWorker();
  wsServer.shutdown();
  server.close(() => {
    logger.info('[Server] HTTP server closed');
    process.exit(0);
  });
});

export default app;
