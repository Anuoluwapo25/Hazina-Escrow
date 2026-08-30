/**
 * rerank.ts — optional LLM re-ranking of the top-K hybrid search results.
 *
 * Off by default (ENABLE_SEARCH_RERANK env flag, plus a per-request
 * `rerank=true` opt-in) because it adds real latency and Anthropic API cost
 * on top of the ~200ms-budget hybrid pipeline. Uses the same direct
 * Anthropic SDK call pattern already established by ai/claude.service.ts in
 * this codebase (not a new external dependency decision).
 *
 * Never a hard dependency: any failure (timeout, malformed response, circuit
 * open) falls back to the original hybrid-ranked order rather than failing
 * the search request.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getCircuitBreaker } from '../common/circuit-breaker';
import { getAnthropicModel } from '../ai/anthropic.config';
import { stripMarkdownFence } from '../ai/claude.service';
import { sanitizeUserText } from '../common/sanitize';
import { logger } from '../lib/logger';

const RERANK_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? '60000', 10);

// Shares the breaker with claude.service.ts's Anthropic calls — same
// downstream dependency, same failure domain.
const claudeBreaker = getCircuitBreaker('anthropic-claude', {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
});

export function isRerankEnabled(): boolean {
  return process.env.ENABLE_SEARCH_RERANK === 'true';
}

export interface RerankCandidate {
  id: string;
  name: string;
  description: string;
}

/**
 * Re-orders `candidates` (already relevance-ranked by hybrid search) by
 * asking Claude to judge genuine fit to the buyer's query. Returns the
 * candidate ids in the new order; always contains every input id exactly
 * once, even on partial/malformed model output.
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
): Promise<string[]> {
  const originalOrder = candidates.map(c => c.id);
  if (candidates.length === 0) return originalOrder;

  try {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: RERANK_TIMEOUT_MS,
    });

    const listing = candidates
      .map((c, i) => `${i + 1}. [${c.id}] ${c.name} — ${c.description}`)
      .join('\n');
    const prompt =
      `A buyer searched a dataset marketplace for: "${sanitizeUserText(query)}"\n\n` +
      `Here are candidate datasets, already roughly ranked by relevance:\n${listing}\n\n` +
      `Re-order them by how well each genuinely answers the buyer's search, best first. ` +
      `Respond with ONLY a JSON array of dataset ids in the new order, e.g. ["ds-a","ds-b"]. ` +
      `Include every listed id exactly once — do not invent or drop any.`;

    const response = await claudeBreaker.execute(() =>
      client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    );

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');
    const parsed: unknown = JSON.parse(stripMarkdownFence(text));
    if (!Array.isArray(parsed)) throw new Error('Rerank response was not a JSON array');

    const validIds = new Set(originalOrder);
    const reranked = parsed.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id),
    );
    // Dedupe while preserving order, in case the model repeats an id.
    const seen = new Set<string>();
    const deduped = reranked.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
    // Any id the model dropped falls back to its original relative order, appended.
    const missing = originalOrder.filter(id => !seen.has(id));
    return [...deduped, ...missing];
  } catch (err) {
    logger.warn(
      `[Search] Rerank failed, falling back to hybrid order: ${err instanceof Error ? err.message : String(err)}`,
    );
    return originalOrder;
  }
}
