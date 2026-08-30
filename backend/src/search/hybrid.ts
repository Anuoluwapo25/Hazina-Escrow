/**
 * hybrid.ts — keyword retrieval and reciprocal rank fusion (RRF).
 *
 * Pure vector search quietly fails on exact identifiers: a query for the
 * literal dataset id or its exact title should always win, but a paraphrase
 * of it can score similarly to several unrelated datasets in embedding
 * space. Keyword retrieval catches exact/near-exact matches; RRF combines it
 * with the vector ranking so neither arm can starve the other.
 */

export interface KeywordDocument {
  datasetId: string;
  name: string;
  description: string;
  category?: string;
  type: string;
  tags?: string[];
}

export interface RankedResult {
  datasetId: string;
  score: number;
}

/** Name matches carry the most weight — a query using the dataset's own words
 * to describe it should win over one merely sharing a description word. */
const FIELD_WEIGHTS: Record<'name' | 'tags' | 'category' | 'type' | 'description', number> = {
  name: 3,
  tags: 2,
  category: 1,
  type: 1,
  description: 1,
};

const EXACT_ID_BONUS = 1000;
const EXACT_NAME_BONUS = 500;
const SUBSTRING_NAME_BONUS = 50;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Finds the id of the document exactly matching the query by id or title (case-insensitive). */
export function findExactMatchId(query: string, documents: KeywordDocument[]): string | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return undefined;
  return documents.find(
    doc =>
      doc.datasetId.toLowerCase() === normalizedQuery ||
      doc.name.trim().toLowerCase() === normalizedQuery,
  )?.datasetId;
}

function fieldText(doc: KeywordDocument, field: keyof typeof FIELD_WEIGHTS): string {
  if (field === 'tags') return (doc.tags ?? []).join(' ');
  return doc[field] ?? '';
}

/**
 * Scores documents by weighted query/document token overlap, with bonuses
 * for an exact id/title match or a title substring match. Deterministic:
 * same query + documents always produce the same scores and ordering.
 */
export function keywordSearch(query: string, documents: KeywordDocument[]): RankedResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0 && normalizedQuery.length === 0) return [];

  const results: RankedResult[] = [];
  for (const doc of documents) {
    let score = 0;

    for (const field of Object.keys(FIELD_WEIGHTS) as (keyof typeof FIELD_WEIGHTS)[]) {
      const fieldTokens = new Set(tokenize(fieldText(doc, field)));
      let overlap = 0;
      for (const token of queryTokens) {
        if (fieldTokens.has(token)) overlap += 1;
      }
      score += overlap * FIELD_WEIGHTS[field];
    }

    const normalizedName = doc.name.trim().toLowerCase();
    if (normalizedQuery.length > 0 && doc.datasetId.toLowerCase() === normalizedQuery) {
      score += EXACT_ID_BONUS;
    } else if (normalizedQuery.length > 0 && normalizedName === normalizedQuery) {
      score += EXACT_NAME_BONUS;
    } else if (normalizedQuery.length > 0 && normalizedName.includes(normalizedQuery)) {
      score += SUBSTRING_NAME_BONUS;
    }

    if (score > 0) results.push({ datasetId: doc.datasetId, score });
  }

  return sortDeterministically(results);
}

/** Standard RRF constant (Cormack, Clarke & Buettcher 2009); large enough that
 * a single arm's rank-1 result doesn't dominate purely by list length. */
export const DEFAULT_RRF_K = 60;

/**
 * Fuses multiple ranked lists (e.g. keyword + vector) by reciprocal rank:
 * each list contributes `1 / (k + rank)` per item, summed across lists. A
 * document ranked highly in *either* list scores well; one ranked highly in
 * *both* scores best.
 */
export function reciprocalRankFusion(
  rankedLists: RankedResult[][],
  options: { k?: number } = {},
): RankedResult[] {
  const k = options.k ?? DEFAULT_RRF_K;
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      scores.set(item.datasetId, (scores.get(item.datasetId) ?? 0) + contribution);
    });
  }

  const fused = Array.from(scores.entries()).map(([datasetId, score]) => ({ datasetId, score }));
  return sortDeterministically(fused);
}

/**
 * Pins an exact dataset-id or exact-title match to rank 1. RRF alone can't
 * guarantee this: a document ranked #1 in only one arm can be outscored by a
 * document ranked highly in *both* arms, but an exact identifier match must
 * always win — this is the documented acceptance behaviour, not a fusion
 * heuristic, so it's applied as an explicit final step.
 */
export function promoteExactMatches(
  query: string,
  documents: KeywordDocument[],
  ranked: RankedResult[],
): RankedResult[] {
  const exactMatchId = findExactMatchId(query, documents);
  if (!exactMatchId) return ranked;

  const withoutExact = ranked.filter(r => r.datasetId !== exactMatchId);
  const exactEntry = ranked.find(r => r.datasetId === exactMatchId) ?? {
    datasetId: exactMatchId,
    score: 0,
  };
  return [exactEntry, ...withoutExact];
}

function sortDeterministically(results: RankedResult[]): RankedResult[] {
  return [...results].sort((a, b) => b.score - a.score || a.datasetId.localeCompare(b.datasetId));
}
