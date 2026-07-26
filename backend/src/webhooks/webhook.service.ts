import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { WebhookEvent, WebhookSubscription, getWebhooksForSeller } from '../common/storage';
import { decryptSecret } from '../common/secret-crypto';
import { getCircuitBreaker, CircuitBreakerOpenError } from '../common/circuit-breaker';
import { logger } from '../lib/logger';

/**
 * Each webhook subscriber gets its own circuit breaker keyed by subscription ID.
 * This isolates misbehaving endpoints from healthy ones.
 */
function getBreakerForSubscription(subscriptionId: string) {
  return getCircuitBreaker(`webhook:${subscriptionId}`, {
    failureThreshold: 3,
    resetTimeoutMs: 300_000, // 5 min — give slow consumer endpoints time to recover
  });
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  payload: Record<string, unknown>;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Generates HMAC-SHA256 signature for webhook payload.
 */
export function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Dispatches a single webhook with retries and exponential backoff.
 * Never throws — failures are logged silently.
 */
export async function dispatchWebhook(
  subscription: WebhookSubscription,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const body: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    payload,
  };
  const bodyString = JSON.stringify(body);
  const signature = signPayload(bodyString, decryptSecret(subscription.secret));

  const url = new URL(subscription.url);
  const options: http.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': signature,
      'X-Webhook-Event': event,
      'X-Webhook-Id': subscription.id,
      'Content-Length': Buffer.byteLength(bodyString),
    },
    timeout: 10000,
  };

  const client = url.protocol === 'https:' ? https : http;

  const breaker = getBreakerForSubscription(subscription.id);

  // Fail-fast when this subscriber's circuit is open
  if (breaker.getState() === 'OPEN') {
    logger.warn(
      `[Webhook] Circuit OPEN for ${subscription.url} (${subscription.id}) — skipping dispatch`,
    );
    return;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const statusCode = await breaker.execute(() => sendRequest(client, options, bodyString));
      if (statusCode >= 200 && statusCode < 300) {
        logger.info(`[Webhook] Dispatched ${event} to ${subscription.url} (${subscription.id})`);
        return;
      }
      // Treat non-2xx as a failure so the breaker counts it
      throw new Error(`HTTP ${statusCode}`);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        logger.warn(
          `[Webhook] Circuit opened for ${subscription.url} (${subscription.id}) — aborting retries`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Webhook] Attempt ${attempt + 1} error: ${message} for ${subscription.url}`);
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
    }
  }

  logger.error(
    `[Webhook] All retries exhausted for ${subscription.url} (${subscription.id}) event=${event}`,
  );
}

/**
 * Notifies all active subscribers for a given seller + event.
 * Dispatches in parallel, never blocks or throws.
 */
export async function notifySeller(
  sellerWallet: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const webhooks = await getWebhooksForSeller(sellerWallet);
  const matching = webhooks.filter(
    w => w.active && (w.events.length === 0 || w.events.includes(event)),
  );

  if (matching.length === 0) return;

  // Fire-and-forget in parallel
  await Promise.all(
    matching.map(sub =>
      dispatchWebhook(sub, event, payload).catch(() => {
        // Already logged inside dispatchWebhook
      }),
    ),
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sendRequest(
  client: typeof http | typeof https,
  options: http.RequestOptions,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = client.request(options, res => {
      // Drain response to free socket
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode ?? 0));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
