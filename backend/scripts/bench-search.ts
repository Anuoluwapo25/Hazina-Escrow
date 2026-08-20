/**
 * bench-search.ts — measures GET /api/search latency (via search.service.ts
 * directly, no HTTP overhead) at the current catalogue size, without rerank.
 *
 * Usage: npm run bench:search --prefix backend
 */
import { performance } from 'perf_hooks';
import { getAllDatasets } from '../src/common/storage';
import { search } from '../src/search/search.service';
import { isEmbeddingAvailable } from '../src/search/embeddings';

const QUERIES = [
  '',
  'large holder activity',
  'validator uptime',
  'yield farming opportunities',
  'nft floor price',
  'gas fees',
  'cross chain bridge',
  'ds-whale-wallets',
];
const ITERATIONS = 25;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] as number;
}

async function main(): Promise<void> {
  const datasets = await getAllDatasets();
  const mode = (await isEmbeddingAvailable()) ? 'hybrid' : 'keyword-only (embedding model unavailable in this environment)';

  console.log(`Catalogue size: ${datasets.length} datasets`);
  console.log(`Mode: ${mode}`);
  console.log(
    `Running ${ITERATIONS} iterations x ${QUERIES.length} queries = ${ITERATIONS * QUERIES.length} calls, rerank=false...`,
  );

  // Warm up (first call may pay one-time model-load cost).
  await search({ query: QUERIES[0] as string, limit: 20 });

  const latenciesMs: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    for (const q of QUERIES) {
      const start = performance.now();
      await search({ query: q, limit: 20, explain: true });
      latenciesMs.push(performance.now() - start);
    }
  }

  latenciesMs.sort((a, b) => a - b);
  const p50 = percentile(latenciesMs, 50);
  const p95 = percentile(latenciesMs, 95);
  const p99 = percentile(latenciesMs, 99);
  const max = latenciesMs[latenciesMs.length - 1] as number;

  console.log(`\nn=${latenciesMs.length}`);
  console.log(`p50: ${p50.toFixed(1)}ms`);
  console.log(`p95: ${p95.toFixed(1)}ms`);
  console.log(`p99: ${p99.toFixed(1)}ms`);
  console.log(`max: ${max.toFixed(1)}ms`);
  console.log(`\n${p95 < 200 ? 'PASS' : 'FAIL'}: p95 ${p95 < 200 ? '<' : '>='} 200ms budget`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
