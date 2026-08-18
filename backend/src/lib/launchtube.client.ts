/**
 * launchtube.client.ts — minimal HTTP client for Launchtube
 * (https://github.com/stellar/launchtube), the paymaster Hazina uses to
 * submit passkey smart-wallet transactions without the buyer holding XLM.
 *
 * Launchtube's HTTP contract (POST /, `Authorization: Bearer <jwt>`,
 * `xdr=<signed envelope>` as x-www-form-urlencoded) is small enough to
 * reimplement directly rather than add a client dependency — that keeps the
 * JWT on one short, auditable code path that nothing client-reachable imports.
 */
import { getLaunchtubeUrl, getLaunchtubeJwt } from './passkeyWallet.config';
import { logger } from './logger';

export class LaunchtubeError extends Error {}

export interface LaunchtubeSubmission {
  hash?: string;
  [key: string]: unknown;
}

/** Relay an already-signed transaction envelope XDR to Launchtube for submission. */
export async function submitViaLaunchtube(xdr: string): Promise<LaunchtubeSubmission> {
  const url = `${getLaunchtubeUrl()}/`;
  const body = new URLSearchParams({ xdr });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getLaunchtubeJwt()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[Launchtube] request failed: ${message}`);
    throw new LaunchtubeError('Could not reach Launchtube');
  }

  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    logger.error(`[Launchtube] submission failed (${response.status}): ${text}`);
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as Record<string, unknown>).error)
        : `Launchtube returned ${response.status}`;
    throw new LaunchtubeError(detail);
  }

  return parsed as LaunchtubeSubmission;
}
