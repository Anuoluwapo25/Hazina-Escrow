import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../common/validate';
import {
  getOraclePrice,
  OracleUnavailableError,
  OracleAssetCode,
  PriceQuoteCurrency,
  convertDatasetPrice,
  convertFixedPoint,
} from './reflector.provider';

export const oracleRouter = Router();

const priceQuerySchema = z.object({
  base: z.enum(['XLM', 'USDC', 'EURC', 'USD']),
  quote: z.enum(['USD', 'USDC']).default('USD'),
});

oracleRouter.get('/price', async (req: Request, res: Response) => {
  const parsed = priceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid query params',
      issues: parsed.error.issues,
    });
  }
  const { base, quote } = parsed.data;
  try {
    const price = await getOraclePrice(base as OracleAssetCode, quote as PriceQuoteCurrency);
    const displayUnits = Number(price.price) / 10 ** price.decimals;
    return res.json({
      success: true,
      base,
      quote,
      price: displayUnits,
      priceRaw: price.price.toString(),
      decimals: price.decimals,
      timestamp: price.timestamp,
      ageSeconds: price.ageSeconds,
      sourceContract: price.sourceContract,
      resolvedVia: price.resolvedVia,
      explorerUrl: `https://stellar.expert/explorer/testnet/contract/${price.sourceContract}`,
    });
  } catch (err) {
    if (err instanceof OracleUnavailableError) {
      return res.status(503).json({
        success: false,
        error: err.message,
        reason: err.reason,
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch oracle price',
    });
  }
});

const convertSchema = z.object({
  priceUsd: z.coerce.number().finite().positive(),
  usdDecimals: z.coerce.number().int().min(0).max(18).default(7),
  paymentAsset: z.enum(['XLM', 'USDC', 'EURC', 'USD']),
  paymentDecimals: z.coerce.number().int().min(0).max(18).default(7),
});

oracleRouter.post('/convert', validateBody(convertSchema), async (req: Request, res: Response) => {
  const { priceUsd, usdDecimals, paymentAsset, paymentDecimals } = req.body as z.infer<
    typeof convertSchema
  >;
  try {
    const priceUsdFixed = BigInt(Math.round(priceUsd * 10 ** usdDecimals));
    const result = await convertDatasetPrice({
      priceUsd: priceUsdFixed,
      usdDecimals,
      paymentAsset: paymentAsset as OracleAssetCode,
      paymentDecimals,
    });
    const amountDisplay = Number(result.amountOut) / 10 ** paymentDecimals;
    const priceDisplay = Number(result.price.price) / 10 ** result.price.decimals;
    return res.json({
      success: true,
      amountIn: priceUsd,
      amountInFixed: result.amountIn.toString(),
      amountOut: amountDisplay,
      amountOutFixed: result.amountOut.toString(),
      price: {
        base: result.price.base,
        quote: result.price.quote,
        value: priceDisplay,
        valueRaw: result.price.price.toString(),
        decimals: result.price.decimals,
        timestamp: result.price.timestamp,
        ageSeconds: result.price.ageSeconds,
        sourceContract: result.price.sourceContract,
        resolvedVia: result.price.resolvedVia,
      },
      expiresAt: result.expiresAt,
      expiresInSeconds: result.expiresAt - Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (err instanceof OracleUnavailableError) {
      return res.status(503).json({
        success: false,
        error: err.message,
        reason: err.reason,
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Conversion failed',
    });
  }
});

export { convertFixedPoint };
