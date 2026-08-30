import express, { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateBody, validateQuery } from './validate';

describe('validateBody', () => {
  const schema = z.object({ name: z.string().min(1) });

  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.post('/echo', validateBody(schema), (req, res) => res.json({ body: req.body }));
    return app;
  }

  it('passes the parsed body through on success', async () => {
    const app = buildApp();
    const res = await request(app).post('/echo').send({ name: 'x' }).expect(200);
    expect(res.body).toEqual({ body: { name: 'x' } });
  });

  it('returns 400 with field errors on failure', async () => {
    const app = buildApp();
    const res = await request(app).post('/echo').send({ name: '' }).expect(400);
    expect(res.body.error).toBeTruthy();
    expect(res.body.fields).toHaveProperty('name');
  });
});

describe('validateQuery', () => {
  const schema = z.object({
    page: z.coerce.number().int().positive().optional(),
    q: z.string().optional().default(''),
  });

  function buildApp(): Express {
    const app = express();
    app.get('/echo', validateQuery(schema), (req, res) => res.json({ query: req.query }));
    return app;
  }

  it('coerces and defaults query params on success', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').query({ page: '3' }).expect(200);
    expect(res.body).toEqual({ query: { page: 3, q: '' } });
  });

  it('returns 400 with field errors on failure', async () => {
    const app = buildApp();
    const res = await request(app).get('/echo').query({ page: 'not-a-number' }).expect(400);
    expect(res.body.error).toBeTruthy();
    expect(res.body.fields).toHaveProperty('page');
  });
});
