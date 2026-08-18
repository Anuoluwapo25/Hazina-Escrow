/**
 * channels.ts — concrete alert channels: Sentry, Datadog, a generic
 * Slack/Discord-compatible webhook, and email (criticals only).
 *
 * Every alert carries the escrow id, tx hash, ledger, and a Stellar Expert
 * link so the first click from a page lands on the evidence.
 */
import { Sentry } from '../common/sentry';
import { incrementMetric } from '../common/datadog';
import { logger } from '../lib/logger';
import { Resend } from 'resend';
import { STELLAR_NETWORK } from '../lib/stellar.config';
import type { SentinelAlert } from '../common/storage';
import type { AlertChannel } from './alerts';

function stellarExpertNetwork(): string {
  return STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
}

export function stellarExpertTxLink(txHash: string): string {
  return `https://stellar.expert/explorer/${stellarExpertNetwork()}/tx/${txHash}`;
}

function summarize(alert: SentinelAlert): string {
  const parts = [
    `[${alert.severity.toUpperCase()}] ${alert.invariant}: ${alert.message}`,
    alert.escrowId !== undefined ? `escrow #${alert.escrowId}` : null,
    alert.ledger !== undefined ? `ledger ${alert.ledger}` : null,
    alert.txHash ? stellarExpertTxLink(alert.txHash) : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join(' — ');
}

const sentrySeverity: Record<SentinelAlert['severity'], Sentry.SeverityLevel> = {
  critical: 'fatal',
  high: 'error',
  medium: 'warning',
};

export const sentryChannel: AlertChannel = {
  name: 'sentry',
  async dispatch(alert) {
    Sentry.captureMessage(summarize(alert), {
      level: sentrySeverity[alert.severity],
      tags: {
        component: 'sentinel',
        invariant: alert.invariant,
        severity: alert.severity,
      },
      extra: {
        escrowId: alert.escrowId,
        txHash: alert.txHash,
        ledger: alert.ledger,
        details: alert.details,
        stellarExpert: alert.txHash ? stellarExpertTxLink(alert.txHash) : undefined,
      },
    });
  },
};

export const datadogChannel: AlertChannel = {
  name: 'datadog',
  async dispatch(alert) {
    incrementMetric('sentinel.alert', 1, {
      invariant: alert.invariant,
      severity: alert.severity,
    });
  },
};

export const logChannel: AlertChannel = {
  name: 'log',
  async dispatch(alert) {
    const line = summarize(alert);
    if (alert.severity === 'critical') logger.error(`[Sentinel] ${line}`);
    else if (alert.severity === 'high') logger.warn(`[Sentinel] ${line}`);
    else logger.info(`[Sentinel] ${line}`);
  },
};

/** Generic webhook — the payload shape (`text`) is understood by both Slack and Discord. */
export const webhookChannel: AlertChannel = {
  name: 'webhook',
  async dispatch(alert) {
    const url = process.env.SENTINEL_ALERT_WEBHOOK_URL;
    if (!url) return;

    const body = JSON.stringify({ text: summarize(alert), content: summarize(alert) });
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (res.ok) return;
        throw new Error(`webhook responded ${res.status}`);
      } catch (err) {
        if (attempt === maxAttempts - 1) throw err;
        await new Promise(r => setTimeout(r, 1_000 * 2 ** attempt));
      }
    }
  },
};

/** Criticals only — a paged human should get an email, not just a Slack ping that scrolls away. */
export const emailChannel: AlertChannel = {
  name: 'email',
  async dispatch(alert) {
    if (alert.severity !== 'critical') return;
    const apiKey = process.env.RESEND_API_KEY;
    const to = process.env.SENTINEL_ALERT_EMAIL;
    if (!apiKey || !to) return;

    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'Hazina Sentinel <onboarding@resend.dev>',
      to,
      subject: `[CRITICAL] Hazina Sentinel: ${alert.invariant}`,
      text: summarize(alert),
    });
    if (error) {
      throw new Error(`Resend email failed: ${error.message}`);
    }
  },
};

export function defaultChannels(): AlertChannel[] {
  return [logChannel, sentryChannel, datadogChannel, webhookChannel, emailChannel];
}
