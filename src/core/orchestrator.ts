// ============================================================
// MODULE: core/orchestrator.ts
// PURPOSE: Phase 2 orchestrator — queue-driven parallel generation
// PHASE: 2
// STATUS: ACTIVE
// FLOW:
//   1. Accept batch of topics
//   2. Check budget
//   3. Push jobs to queue
//   4. Workers process with checkpoint recovery
//   5. Multi-variant generation per topic
//   6. Track costs, handle failures via DLQ
//   7. Return batch results
// ============================================================

import { Logger, ContentConfig } from '../types';
import { createLogger } from '../infra/logger';
import { ContentQueue, createQueue, QueueJob, JobState } from '../queue/queue';
import { processJob, WorkerJobData, WorkerResult } from '../workers/contentWorker';
import { generateVariants, VariantBatchResult } from '../modules/variantGenerator';
import { DeadLetterQueue, dlq } from '../queue/deadLetterQueue';
import { costController, BudgetStatus, CostStats } from '../modules/costController';
import { checkpointManager, CheckpointStats } from '../queue/checkpointManager';
import { getRegistryStats, resetRegistry } from '../registry/contentRegistry';

const log: Logger = createLogger('Orchestrator');

// ─── INTERFACES ─────────────────────────────────────────────

export interface OrchestratorOptions {
  concurrency?: number;
  mode?: 'single' | 'variant';
}

export interface BatchResultEntry {
  topic: string;
  success: boolean;
  result?: WorkerResult;
  best?: VariantBatchResult['best'];
  variants?: VariantBatchResult['variants'];
  stats?: VariantBatchResult['stats'];
  error?: { code: string; message?: string };
}

export interface BatchResult {
  batchId: string;
  success: boolean;
  results: BatchResultEntry[];
  stats: {
    attempted: number;
    succeeded: number;
    failed: number;
    totalTimeMs: number;
    avgTimeMs: number;
    cost: CostStats;
    registry: ReturnType<typeof getRegistryStats>;
    dlq: ReturnType<typeof dlq.getStats>;
    checkpoints: CheckpointStats;
  };
  error?: string;
}

export interface OrchestratorStatus {
  activeBatch: string | null;
  queue: ReturnType<ContentQueue['getStats']>;
  cost: CostStats;
  registry: ReturnType<typeof getRegistryStats>;
  dlq: ReturnType<typeof dlq.getStats>;
  checkpoints: CheckpointStats;
}

// ─── ORCHESTRATOR ───────────────────────────────────────────

export class Orchestrator {
  private concurrency: number;
  private mode: 'single' | 'variant';
  private queue: ContentQueue<WorkerJobData, WorkerResult>;
  private activeBatch: string | null;

  constructor(options: OrchestratorOptions = {}) {
    this.concurrency = options.concurrency || 3;
    this.mode = options.mode || 'variant';
    this.activeBatch = null;

    // Create queue
    this.queue = createQueue<WorkerJobData, WorkerResult>('content', {
      concurrency: this.concurrency,
      maxRetries: 3,
      jobTimeout: 300000,
    });

    // Wire DLQ to queue
    this.queue.on('dead_letter', (job: unknown, error: unknown) => {
      const queueJob = job as QueueJob<WorkerJobData, WorkerResult>;
      const jobError = error as { message?: string; code?: string; stage?: string; stack?: string };
      dlq.add(
        {
          id: queueJob.id,
          name: queueJob.name,
          data: queueJob.data,
          attempts: queueJob.attempts,
          processedAt: queueJob.processedAt,
        },
        jobError
      );
    });

    log.info('Orchestrator initialized', {
      concurrency: this.concurrency,
      mode: this.mode,
    });
  }

  // ─── RUN BATCH ──────────────────────────────────────────

  async runBatch(topics: string[], config: Partial<ContentConfig>): Promise<BatchResult> {
    const batchId = `batch_${Date.now()}`;
    const startTime = Date.now();
    this.activeBatch = batchId;

    log.info('Batch started', {
      batchId,
      topics: topics.length,
      mode: this.mode,
      concurrency: this.concurrency,
    });

    // Pre-flight: budget check
    const budget: BudgetStatus = costController.checkBudget();
    if (!budget.canProceed) {
      log.error('Batch aborted: budget exceeded', { budget: budget as unknown as Record<string, unknown> });
      this.activeBatch = null;
      return {
        batchId,
        success: false,
        error: 'BUDGET_EXCEEDED',
        results: [],
        stats: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          totalTimeMs: 0,
          avgTimeMs: 0,
          cost: costController.getStats(),
          registry: getRegistryStats(),
          dlq: dlq.getStats(),
          checkpoints: checkpointManager.getStats(),
        },
      };
    }

    // Estimate total cost
    const estimate = costController.estimateVideoCost(config);
    const totalEstimate = estimate.allVariants.total * topics.length;
    log.info('Batch cost estimate', {
      perVideo: estimate.allVariants.total,
      totalEstimate,
      budgetRemaining: budget.daily.remaining,
    });

    let results: BatchResultEntry[] = [];

    if (this.mode === 'variant') {
      results = await this._runVariantBatch(topics, config, batchId);
    } else {
      results = await this._runQueueBatch(topics, config, batchId);
    }

    const totalTimeMs = Date.now() - startTime;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const batchResult: BatchResult = {
      batchId,
      success: succeeded > 0,
      results,
      stats: {
        attempted: topics.length,
        succeeded,
        failed,
        totalTimeMs,
        avgTimeMs: Math.round(totalTimeMs / topics.length),
        cost: costController.getStats(),
        registry: getRegistryStats(),
        dlq: dlq.getStats(),
        checkpoints: checkpointManager.getStats(),
      },
    };

    log.info('Batch completed', {
      batchId,
      succeeded,
      failed,
      totalTimeMs,
      totalCost: batchResult.stats.cost.totalCostUSD,
    });

    this.activeBatch = null;
    return batchResult;
  }

  // ─── VARIANT BATCH (parallel multi-variant) ─────────────

  private async _runVariantBatch(
    topics: string[],
    config: Partial<ContentConfig>,
    batchId: string
  ): Promise<BatchResultEntry[]> {
    const results: BatchResultEntry[] = [];

    for (let i = 0; i < topics.length; i += this.concurrency) {
      const chunk = topics.slice(i, i + this.concurrency);

      // Budget check before each chunk
      const budget = costController.checkBudget();
      if (!budget.canProceed) {
        log.warn('Budget exhausted mid-batch, stopping', { processed: i, remaining: topics.length - i });
        for (let j = i; j < topics.length; j++) {
          results.push({ topic: topics[j], success: false, error: { code: 'BUDGET_EXCEEDED' } });
        }
        break;
      }

      const promises = chunk.map(topic => generateVariants(topic, config));
      const chunkResults = await Promise.all(promises);

      for (const cr of chunkResults) {
        results.push({
          topic: cr.topic,
          success: cr.success,
          best: cr.best,
          variants: cr.variants,
          stats: cr.stats,
          error: cr.error,
        });
      }

      log.info('Chunk processed', {
        batchId,
        chunkIndex: Math.floor(i / this.concurrency),
        chunkSize: chunk.length,
        succeeded: chunkResults.filter(r => r.success).length,
      });
    }

    return results;
  }

  // ─── QUEUE BATCH (queue-driven single video) ────────────

  private async _runQueueBatch(
    topics: string[],
    config: Partial<ContentConfig>,
    _batchId: string
  ): Promise<BatchResultEntry[]> {
    // Register worker
    this.queue.process(processJob);

    // Add all jobs to queue
    const jobs = topics.map((topic, i) => ({
      name: `generate_${i}`,
      data: { topic, config } as WorkerJobData,
      options: { priority: topics.length - i },
    }));

    await this.queue.addBulk(jobs);
    log.info('Jobs queued', { count: jobs.length });

    // Wait for all jobs to complete
    const stats = await this.queue.drain();
    log.info('Queue drained', stats as unknown as Record<string, unknown>);

    // Collect results
    const results: BatchResultEntry[] = [];

    for (const job of this.queue.getJobs(JobState.COMPLETED)) {
      results.push({
        topic: (job.data as WorkerJobData).topic,
        success: true,
        result: job.result as WorkerResult,
      });
    }

    for (const job of this.queue.getJobs(JobState.DEAD_LETTER)) {
      results.push({
        topic: (job.data as WorkerJobData).topic,
        success: false,
        error: job.error ? { code: job.error.code, message: job.error.message } : { code: 'UNKNOWN' },
      });
    }

    return results;
  }

  // ─── STATUS ─────────────────────────────────────────────

  getStatus(): OrchestratorStatus {
    return {
      activeBatch: this.activeBatch,
      queue: this.queue.getStats(),
      cost: costController.getStats(),
      registry: getRegistryStats(),
      dlq: dlq.getStats(),
      checkpoints: checkpointManager.getStats(),
    };
  }

  // ─── RETRY DLQ JOBS ────────────────────────────────────

  async retryDeadLetters(config: Partial<ContentConfig>): Promise<VariantBatchResult[]> {
    const retryable = dlq.getRetryableJobs();
    if (retryable.length === 0) {
      log.info('No retryable jobs in DLQ');
      return [];
    }

    log.info('Retrying DLQ jobs', { count: retryable.length });

    const results: VariantBatchResult[] = [];
    for (const entry of retryable) {
      const jobData = entry.jobData as WorkerJobData;
      const result = await generateVariants(jobData.topic, config);
      results.push(result);
      if (result.success) {
        dlq.markResolved(entry.id, 'retried_successfully');
      }
    }
    return results;
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean(): void {
    this.queue.clean();
    dlq.clean();
    costController.clean();
    checkpointManager.cleanAll();
    resetRegistry();
    log.info('Orchestrator fully cleaned');
  }
}
