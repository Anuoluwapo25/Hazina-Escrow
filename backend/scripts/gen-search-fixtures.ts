/**
 * gen-search-fixtures.ts — regenerates the committed search relevance fixture.
 *
 * Run this whenever `src/search/fixtures/corpus.ts` changes (new/edited
 * dataset or query). It calls the *real* production pipeline
 * (composeSearchDocument + embedBatch) so the committed fixture always
 * reflects genuine model output — search.relevance.test.ts then asserts
 * against the fixture offline, with no model calls in CI.
 *
 * Usage: npm run gen:search-fixtures --prefix backend
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { FIXTURE_DATASETS, FIXTURE_QUERIES } from '../src/search/fixtures/corpus';
import { composeSearchDocument } from '../src/search/document';
import { embedBatch, EMBEDDING_MODEL_ID, EMBEDDING_DIMS } from '../src/search/embeddings';

const FIXTURE_PATH = path.resolve(__dirname, '../src/search/fixtures/search-fixtures.json');

function round(vector: Float32Array): number[] {
  // 6 decimal places is well beyond float32 precision (~7 significant
  // digits) — keeps the committed JSON smaller without losing information.
  return Array.from(vector).map(v => Math.round(v * 1e6) / 1e6);
}

async function main(): Promise<void> {
  const datasetDocs = FIXTURE_DATASETS.map(composeSearchDocument);
  const queryTexts = FIXTURE_QUERIES.map(q => q.query);

  console.log(
    `Embedding ${datasetDocs.length} dataset documents + ${queryTexts.length} queries via ${EMBEDDING_MODEL_ID}...`,
  );
  const datasetVectors = await embedBatch(datasetDocs);
  const queryVectors = await embedBatch(queryTexts);

  const fixture = {
    generatedAt: new Date().toISOString(),
    model: EMBEDDING_MODEL_ID,
    dims: EMBEDDING_DIMS,
    datasets: FIXTURE_DATASETS.map((d, i) => ({
      id: d.id,
      vector: round(datasetVectors[i] as Float32Array),
    })),
    queries: FIXTURE_QUERIES.map((q, i) => ({
      query: q.query,
      expectedDatasetId: q.expectedDatasetId,
      vector: round(queryVectors[i] as Float32Array),
    })),
  };

  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Wrote ${FIXTURE_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
