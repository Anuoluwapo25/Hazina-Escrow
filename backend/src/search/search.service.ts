/**
 * search.service.ts — orchestrates the hybrid search pipeline:
 *
 *   query → embedding ─┐
 *                       ├→ reciprocal rank fusion → top-K → optional LLM rerank → results
 *   query → keyword ───┘
 *
 * Filters (category/price) are applied AFTER retrieval, on the fused
 * candidate pool, then the result is paginated. Falls back to keyword-only
 * search whenever the embedding model is unavailable (graceful degradation)
 * — search never returns nothing just because the model failed to load.
 */

import { getAllDatasets, type Dataset } from '../common/storage';
import {
  findExactMatchId,
  keywordSearch,
  reciprocalRankFusion,
  tokenize,
  type KeywordDocument,
  type RankedResult,
} from './hybrid';
import { embedOne, isEmbeddingAvailable } from './embeddings';
import { getVectorStore } from './vector-store';
import { isRerankEnabled, rerankCandidates } from './rerank';
import { domainMetrics } from '../common/datadog';
import { logger } from '../lib/logger';

/** How many fused candidates are considered before filters/pagination apply. */
const CANDIDATE_POOL_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface SearchParams {
  query: string;
  page?: number;
  limit?: number;
  explain?: boolean;
  rerank?: boolean;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
}

export interface SearchResultItem {
  id: string;
  name: string;
  description: string;
  type: string;
  category?: string;
  pricePerQuery: number;
  paymentToken?: string;
  queriesServed: number;
  live?: boolean;
  lastRefreshedAt?: string;
  tags?: string[];
  score: number;
  matchedBecause?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  total: number;
  page: number;
  limit: number;
  /** 'hybrid' when the embedding model contributed; 'keyword-only' when degraded. */
  mode: 'hybrid' | 'keyword-only';
  reranked: boolean;
}

function toKeywordDocument(dataset: Dataset): KeywordDocument {
  return {
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    category: dataset.category,
    type: dataset.type,
    tags: dataset.tags,
  };
}

function toResultItem(dataset: Dataset, score: number): SearchResultItem {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    type: dataset.type,
    category: dataset.category,
    pricePerQuery: dataset.pricePerQuery,
    paymentToken: dataset.paymentToken,
    queriesServed: dataset.queriesServed,
    live: dataset.live,
    lastRefreshedAt: dataset.lastRefreshedAt,
    tags: dataset.tags,
    score,
  };
}

interface MatchMeta {
  exact: boolean;
  matchedKeywords: string[];
  vectorScore?: number;
}

/** Builds the deterministic, template-based "matched because…" explanation. */
export function explainMatch(query: string, meta: MatchMeta): string {
  if (meta.exact) return `Exact match for "${query}"`;

  const hasKeywords = meta.matchedKeywords.length > 0;
  const hasVector = meta.vectorScore !== undefined;

  if (hasKeywords && hasVector) {
    return `Matches keywords (${meta.matchedKeywords.join(', ')}) and is semantically related to "${query}"`;
  }
  if (hasKeywords) {
    return `Matches keywords: ${meta.matchedKeywords.join(', ')}`;
  }
  if (hasVector) {
    const pct = Math.round((meta.vectorScore as number) * 100);
    return `Semantically related to "${query}" (${pct}% similarity, no shared keywords)`;
  }
  return `Matches "${query}"`;
}

function matchedKeywordsFor(query: string, doc: KeywordDocument): string[] {
  const queryTokens = new Set(tokenize(query));
  const docTokens = new Set([
    ...tokenize(doc.name),
    ...tokenize(doc.description),
    ...tokenize((doc.tags ?? []).join(' ')),
    ...tokenize(doc.category ?? ''),
    ...tokenize(doc.type),
  ]);
  return Array.from(queryTokens).filter(t => docTokens.has(t));
}

function applyFilters(
  datasets: Dataset[],
  filters: Pick<SearchParams, 'category' | 'minPrice' | 'maxPrice'>,
): Dataset[] {
  let filtered = datasets;
  if (filters.category) {
    filtered = filtered.filter(d => d.category === filters.category);
  }
  if (filters.minPrice !== undefined) {
    filtered = filtered.filter(d => d.pricePerQuery >= (filters.minPrice as number));
  }
  if (filters.maxPrice !== undefined) {
    filtered = filtered.filter(d => d.pricePerQuery <= (filters.maxPrice as number));
  }
  return filtered;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  const start = Date.now();
  const query = params.query.trim();
  const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
  const limit = Math.min(
    params.limit && params.limit > 0 ? Math.floor(params.limit) : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  const allDatasets = (await getAllDatasets()).filter(d => d.active !== false);
  const byId = new Map(allDatasets.map(d => [d.id, d]));
  const documents = allDatasets.map(toKeywordDocument);
  const documentById = new Map(documents.map(d => [d.datasetId, d]));

  let mode: 'hybrid' | 'keyword-only' = 'keyword-only';
  let ranked: RankedResult[];
  const vectorScoreById = new Map<string, number>();

  if (query.length === 0) {
    // Browse mode (no query): order by popularity, deterministic tie-break.
    ranked = allDatasets
      .slice()
      .sort((a, b) => b.queriesServed - a.queriesServed || a.id.localeCompare(b.id))
      .map(d => ({ datasetId: d.id, score: 0 }));
  } else {
    const keywordResults = keywordSearch(query, documents);
    let vectorResults: RankedResult[] = [];

    const embeddingsAvailable = await isEmbeddingAvailable();
    if (embeddingsAvailable) {
      mode = 'hybrid';
      try {
        const queryVector = await embedOne(query);
        const topVector = await getVectorStore().queryTopK(queryVector, CANDIDATE_POOL_SIZE);
        vectorResults = topVector.map(v => ({ datasetId: v.datasetId, score: v.score }));
        for (const v of topVector) vectorScoreById.set(v.datasetId, v.score);
      } catch (err) {
        // Query embedding failed after all — degrade to keyword-only for
        // this request rather than failing the search entirely.
        mode = 'keyword-only';
        logger.warn(
          `[Search] Query embedding failed, degrading to keyword-only: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const fused = reciprocalRankFusion([keywordResults, vectorResults]);
    const exactMatchId = findExactMatchId(query, documents);
    if (exactMatchId) {
      const withoutExact = fused.filter(r => r.datasetId !== exactMatchId);
      const exactEntry = fused.find(r => r.datasetId === exactMatchId) ?? {
        datasetId: exactMatchId,
        score: 0,
      };
      ranked = [exactEntry, ...withoutExact];
    } else {
      ranked = fused;
    }
  }

  // Retrieval happens over the full catalogue; filters apply to the ranked
  // candidate pool (not before retrieval — see module doc).
  let pool = ranked
    .slice(0, CANDIDATE_POOL_SIZE)
    .map(r => byId.get(r.datasetId))
    .filter((d): d is Dataset => d !== undefined);
  pool = applyFilters(pool, params);
  let poolIds = pool.map(d => d.id);

  let reranked = false;
  if (query.length > 0 && params.rerank && isRerankEnabled() && poolIds.length > 1) {
    const rerankInput = pool.map(d => ({ id: d.id, name: d.name, description: d.description }));
    const newOrder = await rerankCandidates(query, rerankInput);
    poolIds = newOrder;
    reranked = true;
  }

  const total = poolIds.length;
  const startIdx = (page - 1) * limit;
  const pageIds = poolIds.slice(startIdx, startIdx + limit);
  const scoreById = new Map(ranked.map(r => [r.datasetId, r.score]));

  const results: SearchResultItem[] = pageIds.map(id => {
    const dataset = byId.get(id) as Dataset;
    const item = toResultItem(dataset, scoreById.get(id) ?? 0);
    if (params.explain) {
      const doc = documentById.get(id) as KeywordDocument;
      item.matchedBecause = explainMatch(query, {
        exact: findExactMatchId(query, documents) === id,
        matchedKeywords: query.length > 0 ? matchedKeywordsFor(query, doc) : [],
        vectorScore: vectorScoreById.get(id),
      });
    }
    return item;
  });

  domainMetrics.searchQueried({
    mode,
    reranked,
    resultCount: results.length,
    durationMs: Date.now() - start,
  });

  return { query, results, total, page, limit, mode, reranked };
}
