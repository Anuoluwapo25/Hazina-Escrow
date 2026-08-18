import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditDataset, getAuditQueueStats, canAudit } from '../auditor';
import { AUDIT_RUBRIC_VERSION } from '../types';

vi.mock('../deterministic', () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue({
    schema: { check: 'schema', passed: true, score: 0.95, reason: 'Schema consistent' },
    freshness: { check: 'freshness', passed: true, score: 0.9, reason: 'Data is fresh' },
    consistency: { check: 'consistency', passed: true, score: 0.9, reason: 'No issues' },
    originality: { check: 'originality', passed: true, score: 0.95, reason: 'Original content' },
    nullDensity: { check: 'nullDensity', passed: true, score: 0.98, reason: 'Low null density' },
    overallPassed: true,
  }),
}));

vi.mock('../judge', () => ({
  runJudgeChecks: vi.fn().mockResolvedValue({
    substance: { check: 'substance', passed: true, score: 0.85, reason: 'Good substance' },
    descriptionAccuracy: { check: 'descriptionAccuracy', passed: true, score: 0.9, reason: 'Accurate' },
    tokensUsed: 700,
  }),
}));

vi.mock('../../common/storage', () => ({
  getDataset: vi.fn().mockResolvedValue({
    id: 'ds-test-001',
    name: 'Test Dataset',
    description: 'A test dataset',
    type: 'yield-data',
    pricePerQuery: 0.01,
    sellerWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    data: { records: [{ a: 1 }] },
    queriesServed: 0,
    totalEarned: 0,
    createdAt: new Date().toISOString(),
    active: true,
  }),
  getAllDatasets: vi.fn().mockResolvedValue([]),
  updateDataset: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../common/datadog', () => ({
  domainMetrics: {
    auditCompleted: vi.fn(),
    auditJudgeCompleted: vi.fn(),
    auditAppeal: vi.fn(),
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('auditDataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces a valid AuditReport', async () => {
    const report = await auditDataset({
      datasetId: 'ds-test-001',
      triggeredBy: 'publish',
    });

    expect(report.datasetId).toBe('ds-test-001');
    expect(report.version).toBe(AUDIT_RUBRIC_VERSION);
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.overallScore).toBeLessThanOrEqual(1);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    expect(report.auditedBy).toBe('full');
    expect(report.tokensSpent).toBeGreaterThan(0);
    expect(report.createdAt).toBeDefined();
  });

  it('includes evidence for every check', async () => {
    const report = await auditDataset({
      datasetId: 'ds-test-001',
      triggeredBy: 'publish',
    });

    for (const check of report.checks) {
      expect(check.check).toBeDefined();
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.score).toBe('number');
      expect(typeof check.reason).toBe('string');
      expect(check.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('audit queue', () => {
  it('reports queue stats', () => {
    const stats = getAuditQueueStats();
    expect(typeof stats.active).toBe('number');
    expect(typeof stats.queued).toBe('number');
    expect(typeof stats.dailySpendUsd).toBe('number');
  });

  it('allows audits when under cap', () => {
    expect(canAudit()).toBe(true);
  });
});
