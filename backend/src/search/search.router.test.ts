import express, { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

vi.mock('./search.service', () => ({ search: mockSearch }));

import { searchRouter } from './search.router';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', searchRouter);
  return app;
}

describe('GET /api/search', () => {
  let app: Express;

  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockResolvedValue({
      query: 'validator',
      results: [],
      total: 0,
      page: 1,
      limit: 20,
      mode: 'hybrid',
      reranked: false,
    });
    app = buildApp();
  });

  it('passes q through to the search service', async () => {
    await request(app).get('/api/search').query({ q: 'validator uptime' }).expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'validator uptime' }));
  });

  it('defaults q to an empty string (browse mode) when omitted', async () => {
    await request(app).get('/api/search').expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  it('coerces page/limit to numbers', async () => {
    await request(app).get('/api/search').query({ q: 'x', page: '2', limit: '10' }).expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 10 }));
  });

  it('parses explain=true as a boolean', async () => {
    await request(app).get('/api/search').query({ q: 'x', explain: 'true' }).expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ explain: true }));
  });

  it('treats explain as false when omitted', async () => {
    await request(app).get('/api/search').query({ q: 'x' }).expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ explain: false }));
  });

  it('parses rerank=true as a boolean', async () => {
    await request(app).get('/api/search').query({ q: 'x', rerank: 'true' }).expect(200);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ rerank: true }));
  });

  it('passes category/minPrice/maxPrice through', async () => {
    await request(app)
      .get('/api/search')
      .query({ q: 'x', category: 'defi', minPrice: '1', maxPrice: '5' })
      .expect(200);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'defi', minPrice: 1, maxPrice: 5 }),
    );
  });

  it('rejects minPrice > maxPrice with 400 before calling the service', async () => {
    const res = await request(app)
      .get('/api/search')
      .query({ q: 'x', minPrice: '10', maxPrice: '1' })
      .expect(400);
    expect(res.body.error).toMatch(/minimum price/i);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric minPrice with 400', async () => {
    await request(app).get('/api/search').query({ q: 'x', minPrice: 'abc' }).expect(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range page (0 or negative) with 400', async () => {
    await request(app).get('/api/search').query({ q: 'x', page: '0' }).expect(400);
  });

  it('returns the search service response shape with success:true', async () => {
    mockSearch.mockResolvedValue({
      query: 'validator',
      results: [{ id: 'ds-1', name: 'X', matchedBecause: 'Exact match' }],
      total: 1,
      page: 1,
      limit: 20,
      mode: 'hybrid',
      reranked: false,
    });
    const res = await request(app).get('/api/search').query({ q: 'validator' }).expect(200);
    expect(res.body).toMatchObject({
      success: true,
      total: 1,
      results: [{ id: 'ds-1', name: 'X', matchedBecause: 'Exact match' }],
    });
  });

  it('returns 500 with a safe generic message when the search service throws', async () => {
    mockSearch.mockRejectedValue(new Error('db exploded with sensitive detail'));
    const res = await request(app).get('/api/search').query({ q: 'x' }).expect(500);
    expect(res.body.error).not.toContain('sensitive detail');
  });
});
