/**
 * search.router.ts — GET /api/search, the semantic dataset discovery
 * endpoint. Also what the MCP `search_datasets` tool calls.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateQuery } from '../common/validate';
import { search } from './search.service';
import { logger } from '../lib/logger';

export const searchRouter = Router();

const searchQuerySchema = z.object({
  q: z.string().max(300).optional().default(''),
  category: z.string().max(100).optional(),
  minPrice: z.coerce.number().finite().nonnegative().optional(),
  maxPrice: z.coerce.number().finite().nonnegative().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
  explain: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform(v => v === 'true'),
  rerank: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform(v => v === 'true'),
});

/**
 * @openapi
 * /api/search:
 *   get:
 *     summary: Semantic dataset search
 *     description: >
 *       Hybrid (keyword + embedding) search over the dataset marketplace, with
 *       reciprocal rank fusion and an optional per-result match explanation.
 *       Falls back to keyword-only search when the embedding model is
 *       unavailable.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Free-text natural-language query. Omit to browse by popularity.
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: explain
 *         schema:
 *           type: boolean
 *         description: Include a one-line "matched because…" per result.
 *       - in: query
 *         name: rerank
 *         schema:
 *           type: boolean
 *         description: Opt into the optional LLM rerank (also requires ENABLE_SEARCH_RERANK server-side).
 *     responses:
 *       200:
 *         description: Ranked search results
 *       400:
 *         description: Invalid query parameters
 */
searchRouter.get(
  '/search',
  validateQuery(searchQuerySchema),
  async (req: Request, res: Response) => {
    const params = req.query as unknown as z.infer<typeof searchQuerySchema>;

    if (
      params.minPrice !== undefined &&
      params.maxPrice !== undefined &&
      params.minPrice > params.maxPrice
    ) {
      return res.status(400).json({ error: 'Minimum price cannot exceed maximum price' });
    }

    try {
      const result = await search({
        query: params.q,
        category: params.category,
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
        page: params.page,
        limit: params.limit,
        explain: params.explain,
        rerank: params.rerank,
      });
      return res.json({ success: true, ...result });
    } catch (err) {
      logger.error(`[Search] Query failed: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Search failed — please try again' });
    }
  },
);
