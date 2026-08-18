export const AUDIT_RUBRIC_VERSION = 1;

export interface CheckEvidence {
  check: string;
  passed: boolean;
  score: number;
  reason: string;
  details?: Record<string, unknown>;
}

export interface AuditReport {
  datasetId: string;
  version: number;
  overallScore: number;
  checks: CheckEvidence[];
  auditorVersion: string;
  createdAt: string;
  auditedBy: 'deterministic' | 'llm' | 'full';
  appealCount: number;
  lastAppealAt?: string;
  tokensSpent?: number;
  costUsd?: number;
}

export interface DeterministicChecksResult {
  schema: CheckEvidence;
  freshness: CheckEvidence;
  consistency: CheckEvidence;
  originality: CheckEvidence;
  nullDensity: CheckEvidence;
  overallPassed: boolean;
}

export interface JudgeCheckResult {
  substance: CheckEvidence;
  descriptionAccuracy: CheckEvidence;
  tokensUsed: number;
}

export interface AuditRequest {
  datasetId: string;
  triggeredBy: 'publish' | 'refresh' | 'appeal';
  sellerWallet?: string;
}

export interface AppealRecord {
  id: string;
  datasetId: string;
  sellerWallet: string;
  requestedAt: string;
  reason?: string;
  completed: boolean;
}

/** Maximum number of concurrent LLM audit calls. */
export const MAX_CONCURRENT_AUDITS = 3;

/** Per-day audit spend cap in USD. */
export const DEFAULT_DAILY_AUDIT_CAP_USD = 10.0;

/** Maximum records to sample for LLM judge (first N + random N). */
export const MAX_JUDGE_SAMPLE_SIZE = 20;

/** Maximum tokens for judge output. */
export const MAX_JUDGE_TOKENS = 1000;

/** Minhash signature size for originality checks. */
export const MINHASH_NUM_PERM = 128;

/** Similarity threshold for near-duplicate detection (Jaccard). */
export const DUPLICATE_THRESHOLD = 0.7;

/** Maximum number of appeal re-audits per dataset per day. */
export const MAX_APPEALS_PER_DAY = 3;
