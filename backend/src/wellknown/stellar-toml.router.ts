/**
 * stellar.toml — SEP-1 (Stellar Info File).
 *
 * Served at /.well-known/stellar.toml so a SEP-10 client (Freighter, Albedo,
 * the SDK's `WebAuth.readChallengeTx`, or any wallet) can discover this
 * server's web-auth signing key, network passphrase, and sign-in endpoint
 * from the home domain alone. This is what lets a seller's wallet know it is
 * talking to the real Hazina server and not a look-alike: the challenge the
 * server issues is signed by SIGNING_KEY and validated by the client against
 * this file.
 *
 * SEP-1 says `Content-Type: text/plain` for the TOML payload.
 */

import { Router, Request, Response } from 'express';
import { getWebAuthServerPublicKey } from '../auth/sep10.service';
import { isSep10Enabled } from '../auth/sep10.config';
import { getNetworkPassphrase } from '../lib/stellar.config';

export const wellKnownStellarTomlRouter = Router();

export function tomlBasicString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * @openapi
 * /.well-known/stellar.toml:
 *   get:
 *     summary: SEP-1 stellar.toml for SEP-10 web authentication
 *     description: Machine-readable info file advertising the network passphrase, the web-auth signing key, and the SEP-10 sign-in endpoint. Enables Stellar wallets to discover and validate the "Sign in with Stellar" flow.
 *     responses:
 *       200:
 *         description: TOML info file.
 *         content:
 *           text/plain:
 *             schema: { type: string }
 */
wellKnownStellarTomlRouter.get('/.well-known/stellar.toml', (_req: Request, res: Response) => {
  const origin = `${_req.protocol}://${_req.get('host')}`;

  const lines: string[] = [
    `NETWORK_PASSPHRASE = ${tomlBasicString(getNetworkPassphrase())}`,
    `WEB_AUTH_ENDPOINT = ${tomlBasicString(`${origin}/api/v1/auth`)}`,
  ];

  if (isSep10Enabled() && (process.env.WEB_AUTH_SIGNING_KEY ?? '').trim()) {
    lines.push(`SIGNING_KEY = ${tomlBasicString(getWebAuthServerPublicKey())}`);
  }

  res
    .set('Content-Type', 'text/plain; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(lines.join('\n') + '\n');
});
