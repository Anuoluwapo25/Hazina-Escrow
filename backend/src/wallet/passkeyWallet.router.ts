/**
 * passkeyWallet.router.ts — Issue #587
 *
 * Thin, hard-rate-limited relay between a buyer's passkey smart wallet and
 * Launchtube. The browser never talks to Launchtube directly — its JWT would
 * end up in the client bundle — so it posts an already buyer-signed XDR here
 * and this router forwards it, keeping LAUNCHTUBE_JWT server-side only.
 *
 *   POST /wallet/passkey/deploy — relay the signed wallet-deploy carrier
 *                                  produced by PasskeyKit.createWallet()
 *   POST /wallet/passkey/submit — relay any other buyer-signed, passkey-
 *                                  authorized transaction
 *
 * Both endpoints only relay XDR that was already built and signed client-side
 * — no user funds or signing keys pass through the backend.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import { logger } from '../lib/logger';
import { isPasskeyWalletConfigured } from '../lib/passkeyWallet.config';
import { submitViaLaunchtube, LaunchtubeError } from '../lib/launchtube.client';

export const passkeyWalletRouter = Router();

const relaySchema = z.object({
  xdr: z.string().min(1).max(200_000),
});

/** Guard: passkey checkout needs a configured Launchtube token. Returns 503 otherwise. */
function ensureConfigured(res: Response): boolean {
  if (!isPasskeyWalletConfigured()) {
    res.status(503).json({
      error:
        'Passkey wallet checkout is not configured (LAUNCHTUBE_JWT unset). ' +
        'Use Freighter, Albedo, or demo mode instead.',
    });
    return false;
  }
  return true;
}

function relay(context: string) {
  return async (req: Request, res: Response) => {
    if (!ensureConfigured(res)) return;
    const { xdr } = req.body as z.infer<typeof relaySchema>;
    try {
      const result = await submitViaLaunchtube(xdr);
      return res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[PasskeyWallet] ${context}: ${message}`);
      if (err instanceof LaunchtubeError) {
        return res.status(502).json({ error: `Passkey wallet ${context} failed`, detail: message });
      }
      return res.status(502).json({ error: `Passkey wallet ${context} failed` });
    }
  };
}

passkeyWalletRouter.post('/wallet/passkey/deploy', validateBody(relaySchema), relay('deploy'));
passkeyWalletRouter.post('/wallet/passkey/submit', validateBody(relaySchema), relay('submit'));
