import { v4 as uuidv4 } from 'uuid';
import type { AuditReport, AuditRequest, AppealRecord } from './types';
import { AUDIT_RUBRIC_VERSION, MAX_CONCURRENT_AUDITS, DEFAULT_DAILY_AUDIT_CAP_USD, MAX_APPEALS_PER_DAY } from './types';
import { runDeterministicChecks } from './deterministic';
import { runJudgeChecks } from './judge';
import { getAllDatasets, getDataset, updateDataset, type Dataset } from '../common/storage';
import { domainMetrics } from '../common/datadog';
import { logger } from '../lib/logger';

let activeAudits = 0;
const auditQueue: Array<() => void> = [];

let dailySpendUsd = 0;
let dailySpendDate = new Date().toISOString().slice(0, 10);

const appealRecords: AppealRecord[] = [];

function resetDailySpendIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailySpendDate) {
    dailySpendUsd = 0;
    dailySpendDate = today;
  }
}

function acquireAuditSlot(): Promise<void> {
  if (activeAudits < MAX_CONCURRENT_AUDITS) {
    activeAudits++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    auditQueue.push(() => {
      activeAudits++;
      resolve();
    });
  });
}

function releaseAuditSlot(): void {
  activeAudits--;
  const next = auditQueue.shift();
  if (next) next();
}

export function getAuditQueueStats(): { active: number; queued: number; dailySpendUsd: number } {
  resetDailySpendIfNeeded();
  return {
    active: activeAudits,
    queued: auditQueue.length,
    dailySpendUsd,
  };
}

export function canAudit(): boolean {
  resetDailySpendIfNeeded();
  return dailySpendUsd < DEFAULT_DAILY_AUDIT_CAP_USD;
}

export async function auditDataset(request: AuditRequest): Promise<AuditReport> {
  await acquireAuditSlot();

  try {
    resetDailySpendIfNeeded();

    if (dailySpendUsd >= DEFAULT_DAILY_AUDIT_CAP_USD) {
      logger.warn(`[Audit] Daily spend cap of $${DEFAULT_DAILY_AUDIT_CAP_USD} reached; skipping LLM judge`);
    }

    const dataset = await getDataset(request.datasetId);
    if (!dataset) {
      throw new Error(`Dataset ${request.datasetId} not found`);
    }

    const existingDatasets = (await getAllDatasets()).filter(
      d => d.id !== request.datasetId && d.active !== false,
    );

    const deterministic = await runDeterministicChecks(dataset, existingDatasets);

    const checks = [deterministic.schema, deterministic.freshness, deterministic.consistency, deterministic.originality, deterministic.nullDensity];
    let tokensSpent = 0;
    let costUsd = 0;

    if (deterministic.overallPassed && dailySpendUsd < DEFAULT_DAILY_AUDIT_CAP_USD) {
      try {
        const judge = await runJudgeChecks(dataset);
        checks.push(judge.substance, judge.descriptionAccuracy);
        tokensSpent = judge.tokensUsed;
        costUsd = tokensSpent * 0.000001;
        dailySpendUsd += costUsd;

        domainMetrics.auditJudgeCompleted({
          datasetType: dataset.type,
          tokensUsed: tokensSpent,
        });
      } catch (err) {
        logger.error({ err, datasetId: request.datasetId }, '[Audit] Judge check failed');
        checks.push(
          { check: 'substance', passed: false, score: 0.5, reason: 'Judge check failed; defaulting to neutral score' },
          { check: 'descriptionAccuracy', passed: false, score: 0.5, reason: 'Judge check failed; defaulting to neutral score' },
        );
      }
    } else if (!deterministic.overallPassed) {
      checks.push(
        { check: 'substance', passed: false, score: 0, reason: 'Skipped: dataset failed one or more deterministic checks' },
        { check: 'descriptionAccuracy', passed: false, score: 0, reason: 'Skipped: dataset failed one or more deterministic checks' },
      );
    }

    const weights = [0.2, 0.1, 0.15, 0.15, 0.1, 0.2, 0.1];
    let overallScore = 0;
    for (let i = 0; i < checks.length; i++) {
      overallScore += (checks[i]?.score ?? 0) * (weights[i] ?? 0.1);
    }
    overallScore = Math.round(Math.max(0, Math.min(1, overallScore)) * 100) / 100;

    const report: AuditReport = {
      datasetId: request.datasetId,
      version: AUDIT_RUBRIC_VERSION,
      overallScore,
      checks,
      auditorVersion: `v1-deterministic+judge`,
      createdAt: new Date().toISOString(),
      auditedBy: deterministic.overallPassed ? 'full' : 'deterministic',
      appealCount: 0,
      tokensSpent,
      costUsd,
    };

    await updateDataset(request.datasetId, {
      ratings: dataset.ratings
        ? { ...dataset.ratings, auditReport: report }
        : { score: 0, count: 0, reviews: [], auditReport: report },
    } as Partial<Dataset>);

    domainMetrics.auditCompleted({
      datasetType: dataset.type,
      overallScore,
      triggeredBy: request.triggeredBy,
      usedLlm: deterministic.overallPassed,
    });

    logger.info(
      {
        datasetId: request.datasetId,
        overallScore,
        checksCount: checks.length,
        triggeredBy: request.triggeredBy,
        tokensSpent,
      },
      '[Audit] Audit completed',
    );

    return report;
  } finally {
    releaseAuditSlot();
  }
}

export function requestAppeal(datasetId: string, sellerWallet: string, reason?: string): AppealRecord | null {
  resetDailySpendIfNeeded();

  const today = new Date().toISOString().slice(0, 10);
  const todayAppeals = appealRecords.filter(
    a => a.datasetId === datasetId && a.requestedAt.startsWith(today),
  );

  if (todayAppeals.length >= MAX_APPEALS_PER_DAY) {
    return null;
  }

  const appeal: AppealRecord = {
    id: `ap-${uuidv4()}`,
    datasetId,
    sellerWallet,
    requestedAt: new Date().toISOString(),
    reason,
    completed: false,
  };

  appealRecords.push(appeal);
  return appeal;
}

export function getAppeals(datasetId?: string): AppealRecord[] {
  if (datasetId) {
    return appealRecords.filter(a => a.datasetId === datasetId);
  }
  return [...appealRecords];
}
