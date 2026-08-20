import tracer from 'dd-trace';
import { logger } from '../lib/logger';

type MetricTagValue = string | number | boolean | null | undefined;
type MetricTags = Record<string, MetricTagValue>;

interface DogStatsDClient {
  increment(metric: string, value?: number, tags?: Record<string, string | number>): void;
}

function datadogEnabled(): boolean {
  return Boolean(process.env.DATADOG_ENABLED) && process.env.DATADOG_ENABLED !== 'false';
}

function dogstatsd(): DogStatsDClient | undefined {
  return (tracer as unknown as { dogstatsd?: DogStatsDClient }).dogstatsd;
}

function formatTags(tags: MetricTags = {}): Record<string, string | number> {
  const formatted: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({
    service: process.env.DATADOG_SERVICE || 'hazina-escrow-api',
    env: process.env.NODE_ENV || 'development',
    ...tags,
  })) {
    if (value === null || value === undefined) {
      continue;
    }

    formatted[key] = typeof value === 'number' ? value : String(value).toLowerCase();
  }

  return formatted;
}

export function incrementMetric(metric: string, value = 1, tags?: MetricTags): void {
  if (!datadogEnabled()) {
    return;
  }

  try {
    dogstatsd()?.increment(metric, value, formatTags(tags));
  } catch (error) {
    logger.warn({ metric, err: error }, '[Datadog] Failed to submit custom metric');
  }
}

export const domainMetrics = {
  // ============= PAYMENT METRICS =============
  /**
   * Track Stellar payment verification attempts
   * @param tags.datasetType - Type of dataset being purchased
   * @param tags.mode - 'real' for on-chain, 'demo' for simulation
   * @param tags.status - 'verified' or 'failed'
   * @param tags.reason - Error reason if failed (e.g., 'invalid_amount', 'tx_not_found', 'timeout')
   */
  stellarPaymentVerified(tags: {
    datasetType: string;
    mode: 'real' | 'demo';
    status: 'verified' | 'failed';
    reason?: string;
  }) {
    incrementMetric('stellar.payment.verified', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
      status: tags.status,
      reason: tags.reason,
    });
  },

  /**
   * Track end-to-end payment processing (verification + delivery)
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   * @param tags.status - 'delivered' or 'pending'
   */
  paymentVerified(tags: {
    datasetType: string;
    mode: 'real' | 'demo';
    status?: 'delivered' | 'pending';
  }) {
    incrementMetric('payments.verified', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
      status: tags.status,
    });
  },

  /**
   * Track payment delivery failures (retried later)
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   * @param tags.reason - Failure reason (e.g., 'ai_error', 'webhook_error', 'unknown')
   */
  paymentDeliveryFailed(tags: { datasetType: string; mode: 'real' | 'demo'; reason?: string }) {
    incrementMetric('payments.delivery.failed', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
      reason: tags.reason,
    });
  },

  /**
   * Track payment verification errors
   * @param tags.mode - 'real' or 'demo'
   * @param tags.errorType - Category of error
   */
  paymentVerificationError(tags: { mode: 'real' | 'demo'; errorType: string }) {
    incrementMetric('payments.verification.error', 1, {
      mode: tags.mode,
      error_type: tags.errorType,
    });
  },

  /**
   * Track Stellar API timeouts
   * @param tags.method - API method called (e.g., 'transaction', 'operations')
   */
  stellarTimeout(tags: { method?: string }) {
    incrementMetric('stellar.timeout', 1, {
      method: tags.method,
    });
  },

  // ============= DATASET METRICS =============
  /**
   * Track dataset queries (purchases)
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   * @param tags.source - Who queried: 'buyer' or 'agent'
   */
  datasetQueried(tags: { datasetType: string; mode: 'real' | 'demo'; source: 'buyer' | 'agent' }) {
    incrementMetric('datasets.queried', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
      source: tags.source,
    });
  },

  /**
   * Track datasets when they are created
   * @param tags.datasetType - Type of dataset
   * @param tags.pricePerQuery - Price in USDC
   */
  datasetCreated(tags: { datasetType: string; pricePerQuery: number }) {
    incrementMetric('datasets.created', 1, {
      dataset_type: tags.datasetType,
      price_per_query: tags.pricePerQuery,
    });
  },

  /**
   * Track total dataset count by type
   * @param tags.datasetType - Type of dataset
   * @param tags.count - Number of datasets
   */
  datasetCount(tags: { datasetType: string; count: number }) {
    incrementMetric('datasets.count', tags.count, {
      dataset_type: tags.datasetType,
    });
  },

  /**
   * Track queries served by each dataset
   * @param tags.datasetId - Dataset ID
   * @param tags.datasetType - Type of dataset
   * @param tags.queriesServed - Total queries served
   * @param tags.totalEarned - Total USDC earned
   */
  datasetStats(tags: {
    datasetId: string;
    datasetType: string;
    queriesServed: number;
    totalEarned: number;
  }) {
    incrementMetric('datasets.stats.queries_served', tags.queriesServed, {
      dataset_id: tags.datasetId,
      dataset_type: tags.datasetType,
    });
    incrementMetric('datasets.stats.total_earned', tags.totalEarned, {
      dataset_id: tags.datasetId,
      dataset_type: tags.datasetType,
    });
  },

  // ============= AGENT METRICS =============
  /**
   * Track agent job completions
   * @param tags.mode - 'real' or 'demo'
   * @param tags.status - 'completed' or 'failed'
   * @param tags.datasetsQueried - Number of datasets queried during job
   * @param tags.totalSpent - Total USDC spent
   */
  agentJobCompleted(tags: {
    mode: 'real' | 'demo';
    status: 'completed' | 'failed';
    datasetsQueried: number;
    totalSpent?: number;
  }) {
    incrementMetric('agent.jobs.completed', 1, {
      mode: tags.mode,
      status: tags.status,
      datasets_queried: tags.datasetsQueried,
    });
    if (tags.totalSpent !== undefined) {
      incrementMetric('agent.jobs.total_spent', tags.totalSpent, {
        mode: tags.mode,
      });
    }
  },

  /**
   * Track agent job failures
   * @param tags.mode - 'real' or 'demo'
   * @param tags.reason - Failure reason
   */
  agentJobFailed(tags: { mode: 'real' | 'demo'; reason: string }) {
    incrementMetric('agent.jobs.failed', 1, {
      mode: tags.mode,
      reason: tags.reason,
    });
  },

  /**
   * Track datasets purchased by agent
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   * @param tags.amountPaid - Amount paid for this dataset
   */
  agentDatasetPurchase(tags: { datasetType: string; mode: 'real' | 'demo'; amountPaid: number }) {
    incrementMetric('agent.dataset.purchase', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
    });
    incrementMetric('agent.dataset.spend', tags.amountPaid, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
    });
  },

  /**
   * Track when agent fee is insufficient to cover all dataset costs
   * @param tags.mode - 'real' or 'demo'
   * @param tags.totalCost - Combined cost of all selected datasets
   * @param tags.agentFee - Fee collected from the human
   * @param tags.skipped - Number of datasets skipped to fit within budget
   */
  agentBudgetInsufficient(tags: {
    mode: 'real' | 'demo';
    totalCost: number;
    agentFee: number;
    skipped: number;
  }) {
    incrementMetric('agent.budget.insufficient', 1, {
      mode: tags.mode,
      total_cost: tags.totalCost,
      agent_fee: tags.agentFee,
      skipped: tags.skipped,
    });
  },

  /**
   * Track agent human payment verification
   * @param tags.mode - 'real' or 'demo'
   * @param tags.status - 'verified' or 'failed'
   */
  agentHumanPaymentVerified(tags: { mode: 'real' | 'demo'; status: 'verified' | 'failed' }) {
    incrementMetric('agent.human_payment.verified', 1, {
      mode: tags.mode,
      status: tags.status,
    });
  },

  // ============= TRANSACTION METRICS =============
  /**
   * Track delivery retry attempts
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   * @param tags.attempt - Attempt number
   */
  deliveryRetryAttempt(tags: { datasetType: string; mode: 'real' | 'demo'; attempt: number }) {
    incrementMetric('delivery.retry.attempt', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
      attempt: tags.attempt,
    });
  },

  /**
   * Track delivery retries succeeded
   * @param tags.datasetType - Type of dataset
   * @param tags.mode - 'real' or 'demo'
   */
  deliveryRetrySucceeded(tags: { datasetType: string; mode: 'real' | 'demo' }) {
    incrementMetric('delivery.retry.succeeded', 1, {
      dataset_type: tags.datasetType,
      mode: tags.mode,
    });
  },

  // ============= ERROR METRICS =============
  /**
   * Track validation errors
   * @param tags.endpoint - API endpoint
   * @param tags.errorType - Type of validation error
   */
  validationError(tags: { endpoint: string; errorType: string }) {
    incrementMetric('validation.error', 1, {
      endpoint: tags.endpoint,
      error_type: tags.errorType,
    });
  },

  /**
   * Track circuit breaker trips
   * @param tags.service - Service name (e.g., 'stellar-horizon')
   */
  circuitBreakerTrip(tags: { service: string }) {
    incrementMetric('circuit_breaker.trip', 1, {
      service: tags.service,
    });
  },

  // ============= SEARCH METRICS =============
  /**
   * Track GET /api/search queries.
   * @param tags.mode - 'hybrid' when the embedding model was available, 'keyword-only' when degraded
   * @param tags.reranked - whether the optional LLM rerank ran
   * @param tags.resultCount - number of results returned after filtering/pagination
   */
  searchQueried(tags: {
    mode: 'hybrid' | 'keyword-only';
    reranked: boolean;
    resultCount: number;
    durationMs: number;
  }) {
    incrementMetric('search.queried', 1, {
      mode: tags.mode,
      reranked: tags.reranked,
      result_count: tags.resultCount,
      duration_ms: tags.durationMs,
    });
  },
};

export function initializeDatadog(): void {
  if (!datadogEnabled()) {
    return;
  }

  tracer.init({
    service: process.env.DATADOG_SERVICE || 'hazina-escrow-api',
    env: process.env.NODE_ENV || 'development',
    version: process.env.DATADOG_VERSION || '1.0.0',
    logInjection: true,
  });

  tracer.use('express', {
    headers: ['x-datadog-trace-id', 'x-datadog-parent-id'],
  });

  tracer.use('http', {
    headers: ['x-datadog-trace-id', 'x-datadog-parent-id'],
  });
}

export { tracer };
