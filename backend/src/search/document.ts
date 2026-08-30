/**
 * document.ts — composes the text that gets embedded for a dataset, and
 * hashes it so unchanged content is never re-embedded. Pure, deterministic,
 * no model/LLM calls — this belongs in deterministic space.
 */

import { createHash } from 'crypto';

const EXCLUDED_KEYS = new Set(['_headline', '_live', '_fetchedAt']);
const MAX_TOP_LEVEL_KEYS = 15;
const MAX_VALUE_LEN = 60;
const MAX_HEADLINE_LEN = 200;

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatSampleValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return truncate(JSON.stringify(value), MAX_VALUE_LEN);
  return truncate(String(value), MAX_VALUE_LEN);
}

/**
 * Describes a dataset payload's shape — field names plus a small sample of
 * values — for embedding. Field names carry signal a title/description often
 * won't (e.g. `walletAddress`, `balanceUsd`); a raw title like "Whale Wallet
 * Movements" only pays off semantically once its actual columns are visible.
 *
 * `includeSamples: false` omits concrete values (keeping only field names and
 * the headline) — used to compute the *stable* hash that decides whether to
 * re-embed. A live-refreshed dataset's sample values (a balance, a
 * timestamp) change on nearly every refresh even when its meaning hasn't;
 * hashing on shape rather than values keeps re-indexing genuinely tied to
 * "did the semantic content change", not "did a number tick".
 */
export function describeDataShape(
  data: Record<string, unknown> | null | undefined,
  options: { includeSamples?: boolean } = {},
): string {
  if (!data || typeof data !== 'object') return '';
  const includeSamples = options.includeSamples ?? true;
  const lines: string[] = [];

  const headline = (data as Record<string, unknown>)._headline;
  if (typeof headline === 'string' && headline.trim()) {
    lines.push(truncate(headline, MAX_HEADLINE_LEN));
  }

  const keys = Object.keys(data)
    .filter(key => !EXCLUDED_KEYS.has(key))
    .slice(0, MAX_TOP_LEVEL_KEYS);

  for (const key of keys) {
    const value = data[key];

    if (Array.isArray(value)) {
      const firstRecord = value.find(
        item => item !== null && typeof item === 'object' && !Array.isArray(item),
      ) as Record<string, unknown> | undefined;

      if (firstRecord) {
        const fieldNames = Object.keys(firstRecord).slice(0, MAX_TOP_LEVEL_KEYS);
        if (includeSamples) {
          const sample = fieldNames
            .map(f => `${f}=${formatSampleValue(firstRecord[f])}`)
            .join(', ');
          lines.push(`${key} records include fields: ${fieldNames.join(', ')} (e.g. ${sample})`);
        } else {
          lines.push(`${key} records include fields: ${fieldNames.join(', ')}`);
        }
      } else if (value.length > 0 && includeSamples) {
        lines.push(`${key}: ${value.slice(0, 3).map(formatSampleValue).join(', ')}`);
      }
      continue;
    }

    if (value !== null && typeof value === 'object') {
      lines.push(`${key} fields: ${Object.keys(value).slice(0, MAX_TOP_LEVEL_KEYS).join(', ')}`);
      continue;
    }

    if (includeSamples) lines.push(`${key}: ${formatSampleValue(value)}`);
  }

  return lines.join('\n');
}

export interface SearchDocumentInput {
  name: string;
  description: string;
  category?: string;
  type: string;
  tags?: string[];
  data: Record<string, unknown>;
}

function buildDocument(dataset: SearchDocumentInput, includeSamples: boolean): string {
  const parts: string[] = [dataset.name, dataset.description];
  if (dataset.category) parts.push(`Category: ${dataset.category}`);
  parts.push(`Type: ${dataset.type}`);
  if (dataset.tags && dataset.tags.length > 0) parts.push(`Tags: ${dataset.tags.join(', ')}`);
  const shape = describeDataShape(dataset.data, { includeSamples });
  if (shape) parts.push(shape);
  return parts.filter(Boolean).join('\n');
}

/** Composes the full text that gets embedded for a dataset. */
export function composeSearchDocument(dataset: SearchDocumentInput): string {
  return buildDocument(dataset, true);
}

/**
 * Composes the *stable* variant used only to decide whether to re-embed —
 * same as {@link composeSearchDocument} but without concrete sample values,
 * so a live feed's changing numbers don't trigger a re-embed on every
 * refresh. See {@link describeDataShape}.
 */
export function stableSearchDocument(dataset: SearchDocumentInput): string {
  return buildDocument(dataset, false);
}

/** Stable content hash used to skip re-embedding unchanged documents. */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
