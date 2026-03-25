// ============================================================
// MODULE: deadLetterQueue.js
// PURPOSE: Handle permanently failed jobs — diagnosis, alerting, retry
// PHASE: 2
// STATUS: ACTIVE
// NOTE: In-memory store. Production: PostgreSQL + alerting webhook
// ============================================================

const { createLogger } = require('./logger');

const log = createLogger('DeadLetterQueue');

// ─── FAILURE TAXONOMY ───────────────────────────────────────

const FailureCategory = {
  API_ERROR: 'api_error',           // External API failure (Claude, ElevenLabs)
  TIMEOUT: 'timeout',               // Stage or job timeout
  VALIDATION: 'validation',         // Bad data, schema mismatch
  DUPLICATE: 'duplicate',           // Content registry rejection
  RESOURCE: 'resource',             // Disk, memory, quota
  ASSEMBLY: 'assembly',             // FFmpeg / video assembly failure
  UNKNOWN: 'unknown',
};

// ─── CATEGORIZE FAILURE ─────────────────────────────────────

function categorizeFailure(error) {
  const msg = (error.message || '').toLowerCase();
  const code = (error.code || '').toLowerCase();

  if (code === 'duplicate_content' || msg.includes('duplicate') || msg.includes('similar')) {
    return FailureCategory.DUPLICATE;
  }
  if (msg.includes('timeout') || code === 'timeout') {
    return FailureCategory.TIMEOUT;
  }
  if (msg.includes('api') || msg.includes('rate limit') || msg.includes('429') || msg.includes('503')) {
    return FailureCategory.API_ERROR;
  }
  if (msg.includes('ffmpeg') || msg.includes('assembly') || msg.includes('encode')) {
    return FailureCategory.ASSEMBLY;
  }
  if (msg.includes('validation') || msg.includes('schema') || msg.includes('invalid')) {
    return FailureCategory.VALIDATION;
  }
  if (msg.includes('disk') || msg.includes('memory') || msg.includes('quota') || msg.includes('enospc')) {
    return FailureCategory.RESOURCE;
  }
  return FailureCategory.UNKNOWN;
}

// ─── DEAD LETTER QUEUE ──────────────────────────────────────

class DeadLetterQueue {
  constructor() {
    this.entries = new Map();
    this.categoryStats = {};
    this.alertThreshold = 5; // alert after this many failures
    this.alertCallbacks = [];

    // Initialize category counters
    Object.values(FailureCategory).forEach(cat => {
      this.categoryStats[cat] = 0;
    });
  }

  // ─── ADD FAILED JOB ──────────────────────────────────────

  add(job, error) {
    const category = categorizeFailure(error);

    const entry = {
      id: job.id,
      jobName: job.name,
      jobData: job.data,
      error: {
        message: error.message || String(error),
        code: error.code || 'UNKNOWN',
        stage: error.stage || 'unknown',
        stack: error.stack,
      },
      category,
      attempts: job.attempts,
      firstFailedAt: job.processedAt || new Date(),
      lastFailedAt: new Date(),
      resolvedAt: null,
      resolution: null,
      diagnosed: false,
      diagnosis: null,
    };

    this.entries.set(job.id, entry);
    this.categoryStats[category] = (this.categoryStats[category] || 0) + 1;

    log.error('Job added to dead letter queue', {
      jobId: job.id,
      category,
      attempts: job.attempts,
      error: entry.error.message,
      totalDead: this.entries.size,
    });

    // Auto-diagnose
    entry.diagnosis = this._diagnose(entry);
    entry.diagnosed = true;

    // Check alert threshold
    if (this.entries.size >= this.alertThreshold) {
      this._triggerAlert();
    }

    return entry;
  }

  // ─── AUTO-DIAGNOSIS ───────────────────────────────────────

  _diagnose(entry) {
    const recommendations = {
      [FailureCategory.API_ERROR]: {
        cause: 'External API is down or rate-limited',
        action: 'Wait and retry. Check API status page. Consider fallback provider.',
        autoRetryable: true,
        retryDelay: 60000, // 1 minute
      },
      [FailureCategory.TIMEOUT]: {
        cause: 'Processing stage took too long',
        action: 'Increase timeout. Check for blocking calls. Split into smaller chunks.',
        autoRetryable: true,
        retryDelay: 30000,
      },
      [FailureCategory.VALIDATION]: {
        cause: 'Input data failed validation',
        action: 'Review job data. Fix schema. Do not auto-retry.',
        autoRetryable: false,
        retryDelay: 0,
      },
      [FailureCategory.DUPLICATE]: {
        cause: 'Content too similar to existing',
        action: 'Generate with different topic/angle. Increase mutation. Do not retry same input.',
        autoRetryable: false,
        retryDelay: 0,
      },
      [FailureCategory.ASSEMBLY]: {
        cause: 'Video assembly / FFmpeg failure',
        action: 'Check asset integrity. Verify FFmpeg installation. Review input formats.',
        autoRetryable: true,
        retryDelay: 10000,
      },
      [FailureCategory.RESOURCE]: {
        cause: 'System resource exhaustion',
        action: 'Free disk space. Check memory. Wait for resources. Scale infrastructure.',
        autoRetryable: true,
        retryDelay: 120000, // 2 minutes
      },
      [FailureCategory.UNKNOWN]: {
        cause: 'Unclassified error',
        action: 'Manual review required. Check logs for stack trace.',
        autoRetryable: false,
        retryDelay: 0,
      },
    };

    return recommendations[entry.category] || recommendations[FailureCategory.UNKNOWN];
  }

  // ─── RETRY FROM DLQ ──────────────────────────────────────

  getRetryableJobs() {
    return Array.from(this.entries.values())
      .filter(e => e.diagnosis?.autoRetryable && !e.resolvedAt)
      .map(e => ({
        id: e.id,
        jobName: e.jobName,
        jobData: e.jobData,
        category: e.category,
        retryDelay: e.diagnosis.retryDelay,
      }));
  }

  markResolved(jobId, resolution) {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.resolvedAt = new Date();
      entry.resolution = resolution;
      log.info('DLQ entry resolved', { jobId, resolution });
    }
  }

  // ─── ALERTING ─────────────────────────────────────────────

  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  _triggerAlert() {
    const alert = {
      timestamp: new Date(),
      totalDead: this.entries.size,
      categoryBreakdown: { ...this.categoryStats },
      unresolvedCount: Array.from(this.entries.values()).filter(e => !e.resolvedAt).length,
    };

    log.warn('DLQ ALERT: threshold exceeded', alert);

    for (const cb of this.alertCallbacks) {
      try { cb(alert); } catch (e) { log.error('Alert callback error', { error: e.message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats() {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      unresolved: entries.filter(e => !e.resolvedAt).length,
      resolved: entries.filter(e => e.resolvedAt).length,
      autoRetryable: entries.filter(e => e.diagnosis?.autoRetryable && !e.resolvedAt).length,
      categoryBreakdown: { ...this.categoryStats },
    };
  }

  getEntry(jobId) {
    return this.entries.get(jobId) || null;
  }

  getAll() {
    return Array.from(this.entries.values());
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean() {
    this.entries.clear();
    Object.values(FailureCategory).forEach(cat => { this.categoryStats[cat] = 0; });
    log.info('DLQ cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const dlq = new DeadLetterQueue();

module.exports = { DeadLetterQueue, dlq, FailureCategory, categorizeFailure };
