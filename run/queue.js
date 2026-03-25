// ============================================================
// MODULE: queue.js
// PURPOSE: Job queue system (in-memory, BullMQ-compatible interface)
// PHASE: 2
// STATUS: ACTIVE
// NOTE: Phase 2 uses in-memory queue. Production: swap to BullMQ + Redis
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('Queue');

// ─── JOB STATES ─────────────────────────────────────────────

const JobState = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
  DELAYED: 'delayed',
};

// ─── QUEUE IMPLEMENTATION ───────────────────────────────────

class ContentQueue {
  constructor(name, options = {}) {
    this.name = name;
    this.jobs = new Map();
    this.waiting = [];
    this.active = new Map();
    this.completed = [];
    this.failed = [];
    this.listeners = new Map();
    this.concurrency = options.concurrency || 3;
    this.maxRetries = options.maxRetries || 3;
    this.jobTimeout = options.jobTimeout || 300000; // 5 min
    this.isPaused = false;
    this.processingFn = null;
    this.activeCount = 0;

    log.info('Queue created', { name, concurrency: this.concurrency, maxRetries: this.maxRetries });
  }

  // ─── ADD JOB ────────────────────────────────────────────

  async add(jobName, data, options = {}) {
    const jobId = options.jobId || crypto.randomUUID();
    const job = {
      id: jobId,
      name: jobName,
      data,
      state: JobState.WAITING,
      attempts: 0,
      maxAttempts: options.maxAttempts || this.maxRetries,
      priority: options.priority || 0,
      delay: options.delay || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      processedAt: null,
      completedAt: null,
      failedAt: null,
      result: null,
      error: null,
      progress: 0,
    };

    this.jobs.set(jobId, job);

    if (job.delay > 0) {
      job.state = JobState.DELAYED;
      setTimeout(() => {
        job.state = JobState.WAITING;
        job.updatedAt = new Date();
        this.waiting.push(jobId);
        this._processNext();
      }, job.delay);
    } else {
      this.waiting.push(jobId);
    }

    // Sort waiting by priority (higher first)
    this.waiting.sort((a, b) => {
      const jobA = this.jobs.get(a);
      const jobB = this.jobs.get(b);
      return (jobB?.priority || 0) - (jobA?.priority || 0);
    });

    log.info('Job added', { jobId, name: jobName, priority: job.priority, delay: job.delay });
    this._emit('added', job);

    // Auto-process if worker is registered
    if (this.processingFn && !this.isPaused) {
      this._processNext();
    }

    return job;
  }

  // ─── ADD BULK ───────────────────────────────────────────

  async addBulk(jobs) {
    const results = [];
    for (const { name, data, options } of jobs) {
      const job = await this.add(name, data, options || {});
      results.push(job);
    }
    return results;
  }

  // ─── PROCESS (register worker) ──────────────────────────

  process(fn) {
    this.processingFn = fn;
    log.info('Worker registered', { queue: this.name, concurrency: this.concurrency });
    this._processNext();
  }

  // ─── INTERNAL: PROCESS NEXT ─────────────────────────────

  async _processNext() {
    if (this.isPaused) return;
    if (this.activeCount >= this.concurrency) return;
    if (this.waiting.length === 0) return;

    const jobId = this.waiting.shift();
    if (!jobId) return;

    const job = this.jobs.get(jobId);
    if (!job) return;

    job.state = JobState.ACTIVE;
    job.processedAt = new Date();
    job.updatedAt = new Date();
    job.attempts++;
    this.activeCount++;
    this.active.set(jobId, job);

    log.info('Job processing', { jobId, name: job.name, attempt: job.attempts });
    this._emit('active', job);

    // Set timeout
    const timeoutId = setTimeout(() => {
      this._handleFailure(job, new Error(`Job timeout after ${this.jobTimeout}ms`));
    }, this.jobTimeout);

    try {
      // Create a job-like object with progress reporting
      const jobContext = {
        ...job,
        updateProgress: (progress) => {
          job.progress = progress;
          job.updatedAt = new Date();
          this._emit('progress', job, progress);
        },
        log: (message) => {
          log.info(`[Job ${jobId}] ${message}`);
        },
      };

      const result = await this.processingFn(jobContext);

      clearTimeout(timeoutId);

      job.state = JobState.COMPLETED;
      job.completedAt = new Date();
      job.updatedAt = new Date();
      job.result = result;
      job.progress = 100;

      this.active.delete(jobId);
      this.activeCount--;
      this.completed.push(jobId);

      log.info('Job completed', { jobId, name: job.name, attempt: job.attempts, timeMs: Date.now() - job.processedAt.getTime() });
      this._emit('completed', job, result);

    } catch (err) {
      clearTimeout(timeoutId);
      this._handleFailure(job, err);
    }

    // Process next in queue
    this._processNext();
  }

  // ─── HANDLE FAILURE ─────────────────────────────────────

  _handleFailure(job, error) {
    this.active.delete(job.id);
    this.activeCount--;

    job.error = {
      message: error.message || String(error),
      code: error.code || 'UNKNOWN',
      stage: error.stage || 'unknown',
      retryable: error.retryable !== false,
      stack: error.stack,
    };
    job.updatedAt = new Date();

    if (job.attempts < job.maxAttempts && job.error.retryable) {
      // Retry with exponential backoff
      const backoffMs = Math.min(1000 * Math.pow(2, job.attempts - 1), 30000);
      job.state = JobState.DELAYED;

      log.warn('Job failed, scheduling retry', {
        jobId: job.id, attempt: job.attempts, maxAttempts: job.maxAttempts,
        backoffMs, error: job.error.message,
      });

      setTimeout(() => {
        job.state = JobState.WAITING;
        this.waiting.unshift(job.id); // priority re-queue
        this._processNext();
      }, backoffMs);

      this._emit('failed', job, job.error);
    } else {
      // Max retries exceeded → dead letter
      job.state = JobState.DEAD_LETTER;
      job.failedAt = new Date();
      this.failed.push(job.id);

      log.error('Job moved to dead letter', {
        jobId: job.id, attempts: job.attempts, error: job.error.message,
      });

      this._emit('dead_letter', job, job.error);
    }

    this._processNext();
  }

  // ─── QUEUE CONTROL ──────────────────────────────────────

  pause() {
    this.isPaused = true;
    log.info('Queue paused', { queue: this.name });
  }

  resume() {
    this.isPaused = false;
    log.info('Queue resumed', { queue: this.name });
    this._processNext();
  }

  // ─── EVENT SYSTEM ───────────────────────────────────────

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  _emit(event, ...args) {
    const fns = this.listeners.get(event) || [];
    for (const fn of fns) {
      try { fn(...args); } catch (e) { log.error('Event handler error', { event, error: e.message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats() {
    return {
      name: this.name,
      waiting: this.waiting.length,
      active: this.activeCount,
      completed: this.completed.length,
      failed: this.failed.length,
      total: this.jobs.size,
      isPaused: this.isPaused,
    };
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  getJobs(state) {
    return Array.from(this.jobs.values()).filter(j => j.state === state);
  }

  // ─── DRAIN (wait for all jobs to complete) ──────────────

  drain() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.waiting.length === 0 && this.activeCount === 0) {
          resolve(this.getStats());
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean() {
    this.jobs.clear();
    this.waiting = [];
    this.active.clear();
    this.completed = [];
    this.failed = [];
    this.activeCount = 0;
    log.info('Queue cleaned', { queue: this.name });
  }
}

// ─── FACTORY ────────────────────────────────────────────────

function createQueue(name, options) {
  return new ContentQueue(name, options);
}

module.exports = { createQueue, ContentQueue, JobState };
