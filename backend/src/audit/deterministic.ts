import type { CheckEvidence, DeterministicChecksResult } from './types';
import { DUPLICATE_THRESHOLD } from './types';
import { computeMinhash, jaccardSimilarity } from './originality';
import type { Dataset } from '../common/storage';

const NULL_DENSITY_THRESHOLD = 0.5;

function makeCheck(check: string, passed: boolean, score: number, reason: string, details?: Record<string, unknown>): CheckEvidence {
  return { check, passed, score, reason, details };
}

function extractRecords(data: Record<string, unknown>): Record<string, unknown>[] {
  const values = Object.values(data);
  const firstArray = values.find(Array.isArray) as unknown[] | undefined;
  if (firstArray) {
    return firstArray.filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
    );
  }
  if (values.length > 0 && values.every(v => typeof v === 'object' && v !== null && !Array.isArray(v))) {
    return [data];
  }
  return [];
}

export function checkSchema(data: Record<string, unknown>): CheckEvidence {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    return makeCheck('schema', false, 0, 'Dataset is empty or not a valid object');
  }

  const records = extractRecords(data);
  if (records.length === 0) {
    return makeCheck('schema', false, 0.1, 'No parseable records found in dataset payload');
  }

  if (records.length === 1 && records[0]) {
    const keys = Object.keys(records[0]);
    return makeCheck('schema', keys.length > 0, keys.length > 0 ? 1 : 0,
      keys.length > 0 ? `Single record with ${keys.length} fields` : 'Single record with no fields',
      { fields: keys },
    );
  }

  const keyFreq = new Map<string, number>();
  for (const record of records) {
    const sorted = Object.keys(record).sort().join(',');
    keyFreq.set(sorted, (keyFreq.get(sorted) ?? 0) + 1);
  }

  let maxFreq = 0;
  let modeKeys = '';
  for (const [keys, freq] of keyFreq) {
    if (freq > maxFreq) {
      maxFreq = freq;
      modeKeys = keys;
    }
  }

  const consistencyRatio = maxFreq / records.length;
  const modeKeySet = new Set(modeKeys.split(','));
  const score = consistencyRatio;

  if (consistencyRatio <= 0.5) {
    return makeCheck('schema', false, score, `Only ${Math.round(consistencyRatio * 100)}% of records share a consistent shape`, {
      totalRecords: records.length,
      dominantShapeCount: maxFreq,
      totalFields: modeKeySet.size,
      uniqueShapes: keyFreq.size,
    });
  }

  const hasNullFields = records.some(r =>
    Object.values(r).some(v => v === null || v === undefined),
  );
  if (hasNullFields && consistencyRatio < 0.8) {
    return makeCheck('schema', true, score * 0.9, `Schema is ${Math.round(consistencyRatio * 100)}% consistent with some null fields`, {
      totalRecords: records.length,
      dominantShapeCount: maxFreq,
    });
  }

  return makeCheck('schema', true, score, `Schema is consistent across ${Math.round(consistencyRatio * 100)}% of ${records.length} records`, {
    totalRecords: records.length,
    dominantShapeCount: maxFreq,
    fields: Array.from(modeKeySet).slice(0, 20),
  });
}

export function checkFreshness(data: Record<string, unknown>, createdAt: string): CheckEvidence {
  const records = extractRecords(data);
  if (records.length === 0) {
    return makeCheck('freshness', false, 0, 'No records to check freshness');
  }

  const dateFields = ['timestamp', 'date', 'updated_at', 'updatedAt', 'lastUpdated', 'last_updated', 'created_at', 'createdAt', 'fetched_at', 'fetchedAt', 'time', 'block_time', 'blockTime'];

  let recordsWithDates = 0;
  let staleRecords = 0;
  const now = Date.now();
  const createdTime = new Date(createdAt).getTime();
  const maxAge = 90 * 24 * 60 * 60 * 1000;

  for (const record of records) {
    let foundDate = false;
    for (const field of dateFields) {
      const val = record[field];
      if (typeof val === 'string' || typeof val === 'number') {
        const ts = new Date(val).getTime();
        if (Number.isFinite(ts)) {
          foundDate = true;
          recordsWithDates++;
          if (now - ts > maxAge) {
            staleRecords++;
          }
          break;
        }
      }
    }
  }

  if (recordsWithDates === 0) {
    const age = now - createdTime;
    if (age > maxAge) {
      return makeCheck('freshness', false, 0.3, `Dataset created ${Math.round(age / (24 * 60 * 60 * 1000))} days ago with no timestamp fields in records`);
    }
    return makeCheck('freshness', true, 0.7, 'No timestamp fields found in records; dataset is recently created', {
      createdAt,
    });
  }

  const staleRatio = staleRecords / recordsWithDates;
  const score = 1 - staleRatio;

  if (staleRatio > 0.5) {
    return makeCheck('freshness', false, score, `${Math.round(staleRatio * 100)}% of timestamped records are older than 90 days`, {
      recordsWithDates,
      staleRecords,
    });
  }

  return makeCheck('freshness', true, score, `${Math.round((1 - staleRatio) * 100)}% of timestamped records are within 90 days`, {
    recordsWithDates,
    staleRecords,
  });
}

export function checkConsistency(data: Record<string, unknown>): CheckEvidence {
  const records = extractRecords(data);
  if (records.length === 0) {
    return makeCheck('consistency', false, 0, 'No records to check consistency');
  }

  const issues: string[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  const numericRanges: Record<string, { min: number; max: number; isLikelyBounded: boolean }> = {};

  for (const record of records) {
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        if (!numericRanges[key]) {
          numericRanges[key] = { min: val, max: val, isLikelyBounded: false };
        }
        numericRanges[key].min = Math.min(numericRanges[key].min, val);
        numericRanges[key].max = Math.max(numericRanges[key].max, val);
      }
    }
  }

  const negativePatterns = ['apy', 'apy_percent', 'yield', 'rate', 'percentage', 'return', 'roi'];
  for (const record of records) {
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'number') {
        const lowerKey = key.toLowerCase();
        const isRateField = negativePatterns.some(p => lowerKey.includes(p));
        if (isRateField && val < 0) {
          issues.push(`Negative ${key} value: ${val}`);
        }
        totalChecks++;
        if (!isRateField || val >= 0) {
          passedChecks++;
        }
      }
    }
  }

  const futureThreshold = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T|\s)/;
  for (const record of records) {
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'string' && isoDatePattern.test(val)) {
        const ts = new Date(val).getTime();
        if (Number.isFinite(ts)) {
          totalChecks++;
          if (ts > futureThreshold && !key.toLowerCase().includes('deadline')) {
            issues.push(`Future date in ${key}: ${val}`);
          } else {
            passedChecks++;
          }
        }
      }
    }
  }

  const score = totalChecks > 0 ? passedChecks / totalChecks : 1;

  if (issues.length > 3) {
    return makeCheck('consistency', false, score, `${issues.length} consistency issues found`, {
      sampleIssues: issues.slice(0, 5),
    });
  }

  return makeCheck('consistency', issues.length === 0, score, issues.length === 0 ? 'No consistency issues detected' : `${issues.length} minor consistency issues`, {
    issues: issues.slice(0, 5),
  });
}

export function checkNullDensity(data: Record<string, unknown>): CheckEvidence {
  const records = extractRecords(data);
  if (records.length === 0) {
    return makeCheck('nullDensity', false, 0, 'No records to check null density');
  }

  let totalFields = 0;
  let nullFields = 0;

  for (const record of records) {
    for (const val of Object.values(record)) {
      totalFields++;
      if (val === null || val === undefined || val === '') {
        nullFields++;
      }
    }
  }

  if (totalFields === 0) {
    return makeCheck('nullDensity', false, 0, 'Records have no fields');
  }

  const density = 1 - nullFields / totalFields;
  const passed = density >= (1 - NULL_DENSITY_THRESHOLD);

  return makeCheck(
    'nullDensity',
    passed,
    density,
    passed
      ? `${Math.round(density * 100)}% of fields are populated`
      : `${Math.round((1 - density) * 100)}% of fields are null/empty (threshold: ${NULL_DENSITY_THRESHOLD * 100}%)`,
    { totalFields, nullFields, density },
  );
}

export async function checkOriginality(
  data: Record<string, unknown>,
  existingDatasets: Dataset[],
): Promise<CheckEvidence> {
  const records = extractRecords(data);
  if (records.length === 0) {
    return makeCheck('originality', false, 0, 'No records to check originality');
  }

  const targetSig = computeMinhash(records);

  let maxSimilarity = 0;
  let mostSimilarDataset = '';

  for (const existing of existingDatasets) {
    const existingRecords = extractRecords(existing.data as Record<string, unknown>);
    if (existingRecords.length === 0) continue;

    const existingSig = computeMinhash(existingRecords);
    const sim = jaccardSimilarity(targetSig, existingSig);

    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarDataset = existing.name;
    }
  }

  const score = 1 - maxSimilarity;
  const passed = maxSimilarity < DUPLICATE_THRESHOLD;

  return makeCheck(
    'originality',
    passed,
    score,
    passed
      ? `Max similarity to existing listing: ${Math.round(maxSimilarity * 100)}% (below ${DUPLICATE_THRESHOLD * 100}% threshold)`
      : `Near-duplicate detected: ${Math.round(maxSimilarity * 100)}% similar to "${mostSimilarDataset}"`,
    { maxSimilarity, mostSimilarDataset, comparedAgainst: existingDatasets.length },
  );
}

export async function runDeterministicChecks(
  dataset: Dataset,
  existingDatasets: Dataset[],
): Promise<DeterministicChecksResult> {
  const data = dataset.data as Record<string, unknown>;

  const schema = checkSchema(data);
  const freshness = checkFreshness(data, dataset.createdAt);
  const consistency = checkConsistency(data);
  const originality = await checkOriginality(data, existingDatasets);
  const nullDensity = checkNullDensity(data);

  const checks = [schema, freshness, consistency, originality, nullDensity];
  const overallPassed = checks.every(c => c.passed);

  return { schema, freshness, consistency, originality, nullDensity, overallPassed };
}
