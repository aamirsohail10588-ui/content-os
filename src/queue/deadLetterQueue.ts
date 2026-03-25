// ============================================================
// MODULE: queue/deadLetterQueue.ts
// PURPOSE: Handle permanently failed jobs — diagnosis, alerting, retry
// PHASE: 2
// STATUS: ACTIVE
// NOTE: In-memory store. Production: PostgreSQL + alerting webhook
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('DeadLetterQueue');

// ─── FAILURE TAXONOMY ───────────────────────────────────────

export enum FailureCategory {
  API_ERROR = 'api_error',
  TIMEOUT = 'timeout',
  VALIDATION = 'validation',
  DUPLICATE = 'duplicate',
  RESOURCE = 'resource',
  ASSEMBLY = 'assembly',
  UNKNOWN = 'unknown',
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface DLQError {
  message: string;
  code: string;
  stage: string;
  stack?: string;
}

export interface DLQDiagnosis {
  cause: string;
  action: string;
  autoRetryable: boolean;
  retryDelay: number;
}

export interface DLQEntry {
  id: string;
  jobName: string;
  jobData: unknown;
  error: DLQError;
  category: FailureCategory;
  attempts: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
  diagnosed: boolean;
  diagnosis: DLQDiagnosis | null;
}

export interface DLQRetryableJob {
  id: string;
  jobName: string;
  jobData: unknown;
  category: FailureCategory;
  retryDelay: number;
}

export interface DLQAlert {
  timestamp: Date;
  totalDead: number;
  categoryBreakdown: Record<string, number>;
  unresolvedCount: number;
}

export interface DLQStats {
  total: number;
  unresolved: number;
  resolved: number;
  autoRetryable: number;
  categoryBreakdown: Record<string, number>;
}

export interface FailedJobInput {
  id: string;
  name: string;
  data: unknown;
  attempts: number;
  processedAt: Date | null;
}

export interface FailedErrorInput {
  message?: string;
  code?: string;
  stage?: string;
  stack?: string;
}

type AlertCallback = (alert: DLQAlert) => void;

// ─── CATEGORIZE FAILURE ─────────────────────────────────────

export function categorizeFailure(error: FailedErrorInput): FailureCategory {
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

// ─── DIAGNOSIS RECOMMENDATIONS ──────────────────────────────

const DIAGNOSIS_MAP: Record<FailureCategory, DLQDiagnosis> = {
  [FailureCategory.API_ERROR]: {
    cause: 'External API is down or rate-limited',
    action: 'Wait and retry. Check API status page. Consider fallback provider.',
    autoRetryable: true,
    retryDelay: 60000,
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
    retryDelay: 120000,
  },
  [FailureCategory.UNKNOWN]: {
    cause: 'Unclassified error',
    action: 'Manual review required. Check logs for stack trace.',
    autoRetryable: false,
    retryDelay: 0,
  },
};

// ─── DEAD LETTER QUEUE ──────────────────────────────────────

export class DeadLetterQueue {
  private entries: Map<string, DLQEntry>;
  private categoryStats: Record<string, number>;
  private alertThreshold: number;
  private alertCallbacks: AlertCallback[];

  constructor() {
    this.entries = new Map();
    this.categoryStats = {};
    this.alertThreshold = 5;
    this.alertCallbacks = [];

    Object.values(FailureCategory).forEach((cat: string) => {
      this.categoryStats[cat] = 0;
    });
  }

  // ─── ADD FAILED JOB ──────────────────────────────────────

  add(job: FailedJobInput, error: FailedErrorInput): DLQEntry {
    const category = categorizeFailure(error);

    const entry: DLQEntry = {
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

  private _diagnose(entry: DLQEntry): DLQDiagnosis {
    return DIAGNOSIS_MAP[entry.category] || DIAGNOSIS_MAP[FailureCategory.UNKNOWN];
  }

  // ─── RETRY FROM DLQ ──────────────────────────────────────

  getRetryableJobs(): DLQRetryableJob[] {
    return Array.from(this.entries.values())
      .filter((e: DLQEntry) => e.diagnosis?.autoRetryable && !e.resolvedAt)
      .map((e: DLQEntry) => ({
        id: e.id,
        jobName: e.jobName,
        jobData: e.jobData,
        category: e.category,
        retryDelay: e.diagnosis!.retryDelay,
      }));
  }

  markResolved(jobId: string, resolution: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.resolvedAt = new Date();
      entry.resolution = resolution;
      log.info('DLQ entry resolved', { jobId, resolution });
    }
  }

  // ─── ALERTING ─────────────────────────────────────────────

  onAlert(callback: AlertCallback): void {
    this.alertCallbacks.push(callback);
  }

  private _triggerAlert(): void {
    const alert: DLQAlert = {
      timestamp: new Date(),
      totalDead: this.entries.size,
      categoryBreakdown: { ...this.categoryStats },
      unresolvedCount: Array.from(this.entries.values()).filter((e: DLQEntry) => !e.resolvedAt).length,
    };

    log.warn('DLQ ALERT: threshold exceeded', alert as unknown as Record<string, unknown>);

    for (const cb of this.alertCallbacks) {
      try { cb(alert); } catch (e) { log.error('Alert callback error', { error: (e as Error).message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats(): DLQStats {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      unresolved: entries.filter((e: DLQEntry) => !e.resolvedAt).length,
      resolved: entries.filter((e: DLQEntry) => e.resolvedAt !== null).length,
      autoRetryable: entries.filter((e: DLQEntry) => e.diagnosis?.autoRetryable && !e.resolvedAt).length,
      categoryBreakdown: { ...this.categoryStats },
    };
  }

  getEntry(jobId: string): DLQEntry | null {
    return this.entries.get(jobId) || null;
  }

  getAll(): DLQEntry[] {
    return Array.from(this.entries.values());
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean(): void {
    this.entries.clear();
    Object.values(FailureCategory).forEach((cat: string) => { this.categoryStats[cat] = 0; });
    log.info('DLQ cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const dlq = new DeadLetterQueue();
