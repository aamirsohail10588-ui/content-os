// ============================================================
// MODULE: orchestrator.js
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

const { createLogger } = require('./logger');
const { createQueue } = require('./queue');
const { processJob } = require('./contentWorker');
const { generateVariants } = require('./variantGenerator');
const { dlq } = require('./deadLetterQueue');
const { costController } = require('./costController');
const { checkpointManager } = require('./checkpointManager');
const { getRegistryStats, resetRegistry } = require('./contentRegistry');

const log = createLogger('Orchestrator');

// ─── ORCHESTRATOR ───────────────────────────────────────────

class Orchestrator {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.mode = options.mode || 'variant'; // 'single' or 'variant'

    // Create queue
    this.queue = createQueue('content', {
      concurrency: this.concurrency,
      maxRetries: 3,
      jobTimeout: 300000,
    });

    // Wire DLQ to queue
    this.queue.on('dead_letter', (job, error) => {
      dlq.add(job, error);
    });

    // Track completion
    this.batchResults = new Map();
    this.activeBatch = null;

    log.info('Orchestrator initialized', {
      concurrency: this.concurrency,
      mode: this.mode,
    });
  }

  // ─── RUN BATCH ──────────────────────────────────────────

  async runBatch(topics, config) {
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
    const budget = costController.checkBudget();
    if (!budget.canProceed) {
      log.error('Batch aborted: budget exceeded', { budget });
      return {
        batchId,
        success: false,
        error: 'BUDGET_EXCEEDED',
        results: [],
        stats: { attempted: 0, succeeded: 0, failed: 0 },
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

    const results = [];

    if (this.mode === 'variant') {
      // ─── VARIANT MODE: parallel multi-variant generation ───
      results.push(...await this._runVariantBatch(topics, config, batchId));
    } else {
      // ─── SINGLE MODE: queue-based single video per topic ───
      results.push(...await this._runQueueBatch(topics, config, batchId));
    }

    const totalTimeMs = Date.now() - startTime;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const batchResult = {
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

  async _runVariantBatch(topics, config, batchId) {
    const results = [];

    // Process topics in parallel batches of concurrency size
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
      results.push(...chunkResults);

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

  async _runQueueBatch(topics, config, batchId) {
    // Register worker
    this.queue.process(processJob);

    // Add all jobs to queue
    const jobs = topics.map((topic, i) => ({
      name: `generate_${i}`,
      data: { topic, config },
      options: { priority: topics.length - i }, // first topic = highest priority
    }));

    await this.queue.addBulk(jobs);
    log.info('Jobs queued', { count: jobs.length });

    // Wait for all jobs to complete
    const stats = await this.queue.drain();
    log.info('Queue drained', stats);

    // Collect results
    const results = [];
    for (const job of this.queue.getJobs('completed')) {
      results.push({ topic: job.data.topic, success: true, result: job.result });
    }
    for (const job of this.queue.getJobs('dead_letter')) {
      results.push({ topic: job.data.topic, success: false, error: job.error });
    }

    return results;
  }

  // ─── STATUS ─────────────────────────────────────────────

  getStatus() {
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

  async retryDeadLetters(config) {
    const retryable = dlq.getRetryableJobs();
    if (retryable.length === 0) {
      log.info('No retryable jobs in DLQ');
      return [];
    }

    log.info('Retrying DLQ jobs', { count: retryable.length });

    const results = [];
    for (const entry of retryable) {
      const result = await generateVariants(entry.jobData.topic, config);
      results.push(result);
      if (result.success) {
        dlq.markResolved(entry.id, 'retried_successfully');
      }
    }
    return results;
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean() {
    this.queue.clean();
    dlq.clean();
    costController.clean();
    checkpointManager.cleanAll();
    resetRegistry();
    log.info('Orchestrator fully cleaned');
  }
}

module.exports = { Orchestrator };
