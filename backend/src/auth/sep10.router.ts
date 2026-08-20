/**
 * sep10.router.ts — Stellar Web Authentication (SEP-10) endpoints.
 *
 * These are the wire endpoints of the "Sign in with Stellar" flow:
 *
 *   GET  /api/v1/auth?account=G…&home_domain=…  → challenge transaction
 *   POST /api/v1/auth { transaction, home_domain } → seller JWT
 *
 * A SEP-10 client (Freighter/Albedo wallet or the SDK) requests a challenge,
 * signs it with the seller's keypair, and submits it back. The server verifies
 * the signature against the account's authorized signers, redeems the
 * single-use nonce, and issues a short-lived HS256 JWT (the same format
 * SELLER_JWT_SECRET middleware already accepts) whose `sellerWallet` claim is
 * the owning G… address. The webhook / dataset / analytics routes accept that
 * JWT as a bearer token without any shared API key.
 *
 * When SEP-10 is not enabled (AUTH_MODE is legacy-only, or the signing secret
 * is unset) both endpoints answer 503 so a misconfigured deployment fails
 * loudly instead of issuing challenges it cannot verify.
 */

import { Router, Request, Response } from 'express';
import {
  createChallenge,
  getSep10NetworkPassphrase,
  issueSellerJwt,
  Sep10Error,
  verifySignedChallenge,
} from './sep10.service';
import { isSep10Enabled } from './sep10.config';
import { sep10NonceStore } from './nonce.store';

export const authRouter = Router();

function requireSep10Enabled(): void {
  if (!isSep10Enabled()) {
    throw new Sep10Error(
      'SEP-10 seller authentication is not enabled. Set AUTH_MODE=sep10 (or both) with WEB_AUTH_SIGNING_KEY and WEB_AUTH_JWT_SECRET.',
      503,
    );
  }
}

/**
 * @openapi
 * /api/v1/auth:
 *   get:
 *     summary: Request a SEP-10 sign-in challenge
 *     description: Returns a Stellar transaction the client must sign with the wallet for `account`, then submit via POST /api/v1/auth. The challenge is single-use, server-signed, bound to this domain, and valid for the configured TTL.
 *     parameters:
 *       - in: query
 *         name: account
 *         required: true
 *         schema: { type: string }
 *         description: Seller's Stellar public key (G… or muxed M…).
 *       - in: query
 *         name: home_domain
 *         required: false
 *         schema: { type: string }
 *         description: Must match this server's domain when supplied.
 *     responses:
 *       200:
 *         description: The challenge transaction and network passphrase.
 *       400:
 *         description: Invalid account or home domain.
 *       503:
 *         description: SEP-10 not enabled.
 */
authRouter.get('/', async (req: Request, res: Response) => {
  requireSep10Enabled();

  const clientAccountId = String(req.query.account ?? '').trim();
  if (!clientAccountId) {
    throw new Sep10Error('Missing required query parameter "account"', 400);
  }
  const homeDomain =
    req.query.home_domain === undefined ? undefined : String(req.query.home_domain);

  const challenge = await createChallenge({
    clientAccountId,
    homeDomain,
    requestHost: req.get('host'),
    store: sep10NonceStore,
  });

  res.json({
    transaction: challenge.transaction,
    network_passphrase: getSep10NetworkPassphrase(),
    expires_at: challenge.expiresAtSec,
    home_domain: challenge.homeDomain,
  });
});

/**
 * @openapi
 * /api/v1/auth:
 *   post:
 *     summary: Verify a signed SEP-10 challenge and receive a seller JWT
 *     description: Verifies the signature of `transaction` against the seller account's authorized signers (Horizon), redeems the single-use nonce, and returns a short-lived JWT for subsequent authenticated requests.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transaction, home_domain]
 *             properties:
 *               transaction: { type: string, description: Base64 XDR of the signed challenge transaction. }
 *               home_domain: { type: string, description: The home domain the client signed for. }
 *     responses:
 *       200:
 *         description: Verified. Returns the seller JWT.
 *       400:
 *         description: Invalid or tampered challenge.
 *       401:
 *         description: Nonce already used, expired, or bound to another account.
 *       503:
 *         description: SEP-10 not enabled.
 */
authRouter.post('/', async (req: Request, res: Response) => {
  requireSep10Enabled();

  const body = (req.body ?? {}) as { transaction?: unknown; home_domain?: unknown };
  const signedTransaction = typeof body.transaction === 'string' ? body.transaction.trim() : '';
  const homeDomain = typeof body.home_domain === 'string' ? body.home_domain.trim() : '';
  if (!signedTransaction) {
    throw new Sep10Error('Missing required field "transaction"', 400);
  }
  if (!homeDomain) {
    throw new Sep10Error('Missing required field "home_domain"', 400);
  }

  const verified = await verifySignedChallenge({
    signedTransaction,
    homeDomain,
    requestHost: req.get('host'),
    store: sep10NonceStore,
  });

  const token = issueSellerJwt({
    clientAccountId: verified.clientAccountId,
    homeDomain: verified.matchedHomeDomain,
  });

  res.json({
    token,
    seller_wallet: verified.clientAccountId,
    account: verified.clientAccountId,
    home_domain: verified.matchedHomeDomain,
  });
});
