/**
 * apiClient.ts — thin client for the existing Hazina backend REST API. No
 * marketplace/payment business logic lives here; it only calls the same
 * endpoints the web frontend does (#593: "the MCP server is a client, not a
 * second backend").
 *
 * Route note: dataset endpoints are public; the payments endpoints
 * (`/payments/query/:id`, `/payments/verify/:id[/demo]`) require the
 * `HAZINA_API_KEY` bearer token in production.
 */
import { mapApiError } from './errors.js';
import {
  SearchResponseSchema,
  GetDatasetResponseSchema,
  QuotePayloadSchema,
  QueryResultSchema,
  type DatasetDetail,
  type SearchResponse,
  type QuotePayload,
  type QueryResult,
} from './types.js';

export interface ApiClientConfig {
  apiUrl: string;
  apiKey?: string;
}

/** The subset of HazinaApiClient the tools depend on — lets tests inject a fake. */
export interface HazinaApiClientLike {
  searchDatasets(params: {
    query?: string;
    category?: string;
    maxPrice?: number;
    limit?: number;
  }): Promise<SearchResponse>;
  getDataset(id: string): Promise<DatasetDetail>;
  initiateQuery(id: string): Promise<QuotePayload>;
  verifyPayment(id: string, txHash: string, buyerQuestion?: string): Promise<QueryResult>;
  verifyDemo(id: string, buyerQuestion?: string): Promise<QueryResult>;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class HazinaApiClient implements HazinaApiClientLike {
  constructor(private readonly config: ApiClientConfig) {}

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  /**
   * Hybrid (keyword + embedding) search — GET /api/search. Always asks for
   * match explanations: for an agent that can't browse, "matched because…"
   * is what makes a result set usable and trustworthy (#611).
   */
  async searchDatasets(params: {
    query?: string;
    category?: string;
    maxPrice?: number;
    limit?: number;
  }): Promise<SearchResponse> {
    const qs = new URLSearchParams();
    if (params.query) qs.set('q', params.query);
    if (params.category) qs.set('category', params.category);
    if (params.maxPrice !== undefined) qs.set('maxPrice', String(params.maxPrice));
    qs.set('limit', String(params.limit ?? 20));
    qs.set('explain', 'true');

    const res = await fetch(`${this.config.apiUrl}/api/v1/search?${qs.toString()}`);
    const body = await readJson(res);
    if (!res.ok) throw mapApiError(res.status, body, 'search_datasets');
    return SearchResponseSchema.parse(body);
  }

  async getDataset(id: string): Promise<DatasetDetail> {
    const res = await fetch(`${this.config.apiUrl}/api/v1/datasets/${encodeURIComponent(id)}`);
    const body = await readJson(res);
    if (!res.ok) throw mapApiError(res.status, body, 'get_dataset');
    return GetDatasetResponseSchema.parse(body).dataset;
  }

  /** POST /payments/query/:id — the 402 quote payload. A 402 status here is success, not an error. */
  async initiateQuery(id: string): Promise<QuotePayload> {
    const res = await fetch(
      `${this.config.apiUrl}/api/v1/payments/query/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: this.authHeaders(),
      },
    );
    const body = await readJson(res);
    if (res.status !== 402) throw mapApiError(res.status, body, 'quote_purchase');
    return QuotePayloadSchema.parse(body);
  }

  async verifyPayment(id: string, txHash: string, buyerQuestion?: string): Promise<QueryResult> {
    const res = await fetch(
      `${this.config.apiUrl}/api/v1/payments/verify/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({ txHash, buyerQuestion }),
      },
    );
    const body = await readJson(res);
    if (!res.ok) throw mapApiError(res.status, body, 'purchase_dataset');
    return QueryResultSchema.parse(body);
  }

  async verifyDemo(id: string, buyerQuestion?: string): Promise<QueryResult> {
    const res = await fetch(
      `${this.config.apiUrl}/api/v1/payments/verify/${encodeURIComponent(id)}/demo`,
      {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({ buyerQuestion }),
      },
    );
    const body = await readJson(res);
    if (!res.ok) throw mapApiError(res.status, body, 'purchase_dataset (demo)');
    return QueryResultSchema.parse(body);
  }
}
