// ============================================================
// MODULE: queue/queue.ts
// PURPOSE: Job queue system (in-memory, BullMQ-compatible interface)
// PHASE: 2
// STATUS: ACTIVE
// NOTE: Phase 2 uses in-memory queue. Production: swap to BullMQ + Redis
// ============================================================

import * as crypto from 'crypto';
import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('Queue');

// ─── JOB STATES ─────────────────────────────────────────────

export enum JobState {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DEAD_LETTER = 'dead_letter',
  DELAYED = 'delayed',
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface QueueOptions {
  concurrency?: number;
  maxRetries?: number;
  jobTimeout?: number;
}

export interface JobOptions {
  jobId?: string;
  maxAttempts?: number;
  priority?: number;
  delay?: number;
}

export interface JobError {
  message: string;
  code: string;
  stage: string;
  retryable: boolean;
  stack?: string;
}

export interface QueueJob<T = unknown, R = unknown> {
  id: string;
  name: string;
  data: T;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  priority: number;
  delay: number;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  result: R | null;
  error: JobError | null;
  progress: number;
}

export interface JobContext<T = unknown> extends QueueJob<T> {
  updateProgress: (progress: number) => void;
  log: (message: string) => void;
}

export type ProcessingFn<T = unknown, R = unknown> = (job: JobContext<T>) => Promise<R>;

export interface BulkJobEntry<T = unknown> {
  name: string;
  data: T;
  options?: JobOptions;
}

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  total: number;
  isPaused: boolean;
}

type EventCallback = (...args: unknown[]) => void;

// ─── QUEUE IMPLEMENTATION ───────────────────────────────────

export class ContentQueue<T = unknown, R = unknown> {
  private name: string;
  private jobs: Map<string, QueueJob<T, R>>;
  private waiting: string[];
  private active: Map<string, QueueJob<T, R>>;
  private completed: string[];
  private failed: string[];
  private listeners: Map<string, EventCallback[]>;
  private concurrency: number;
  private maxRetries: number;
  private jobTimeout: number;
  private isPaused: boolean;
  private processingFn: ProcessingFn<T, R> | null;
  private activeCount: number;

  constructor(name: string, options: QueueOptions = {}) {
    this.name = name;
    this.jobs = new Map();
    this.waiting = [];
    this.active = new Map();
    this.completed = [];
    this.failed = [];
    this.listeners = new Map();
    this.concurrency = options.concurrency || 3;
    this.maxRetries = options.maxRetries || 3;
    this.jobTimeout = options.jobTimeout || 300000;
    this.isPaused = false;
    this.processingFn = null;
    this.activeCount = 0;

    log.info('Queue created', { name, concurrency: this.concurrency, maxRetries: this.maxRetries });
  }

  // ─── ADD JOB ────────────────────────────────────────────

  async add(jobName: string, data: T, options: JobOptions = {}): Promise<QueueJob<T, R>> {
    const jobId = options.jobId || crypto.randomUUID();
    const job: QueueJob<T, R> = {
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

    this.waiting.sort((a, b) => {
      const jobA = this.jobs.get(a);
      const jobB = this.jobs.get(b);
      return (jobB?.priority || 0) - (jobA?.priority || 0);
    });

    log.info('Job added', { jobId, name: jobName, priority: job.priority, delay: job.delay });
    this._emit('added', job);

    if (this.processingFn && !this.isPaused) {
      this._processNext();
    }

    return job;
  }

  // ─── ADD BULK ───────────────────────────────────────────

  async addBulk(jobs: BulkJobEntry<T>[]): Promise<QueueJob<T, R>[]> {
    const results: QueueJob<T, R>[] = [];
    for (const { name, data, options } of jobs) {
      const job = await this.add(name, data, options || {});
      results.push(job);
    }
    return results;
  }

  // ─── PROCESS (register worker) ──────────────────────────

  process(fn: ProcessingFn<T, R>): void {
    this.processingFn = fn;
    log.info('Worker registered', { queue: this.name, concurrency: this.concurrency });
    this._processNext();
  }

  // ─── INTERNAL: PROCESS NEXT ─────────────────────────────

  private async _processNext(): Promise<void> {
    if (this.isPaused) return;
    if (this.activeCount >= this.concurrency) return;
    if (this.waiting.length === 0) return;

    const jobId = this.waiting.shift();
    if (!jobId) return;

    const job = this.jobs.get(jobId);
    if (!job || !this.processingFn) return;

    job.state = JobState.ACTIVE;
    job.processedAt = new Date();
    job.updatedAt = new Date();
    job.attempts++;
    this.activeCount++;
    this.active.set(jobId, job);

    log.info('Job processing', { jobId, name: job.name, attempt: job.attempts });
    this._emit('active', job);

    const timeoutId = setTimeout(() => {
      this._handleFailure(job, new Error(`Job timeout after ${this.jobTimeout}ms`));
    }, this.jobTimeout);

    try {
      const jobContext: JobContext<T> = {
        ...job,
        updateProgress: (progress: number) => {
          job.progress = progress;
          job.updatedAt = new Date();
          this._emit('progress', job, progress);
        },
        log: (message: string) => {
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

      log.info('Job completed', { jobId, name: job.name, attempt: job.attempts, timeMs: Date.now() - (job.processedAt?.getTime() || 0) });
      this._emit('completed', job, result);
    } catch (err) {
      clearTimeout(timeoutId);
      this._handleFailure(job, err as Error);
    }

    this._processNext();
  }

  // ─── HANDLE FAILURE ─────────────────────────────────────

  private _handleFailure(job: QueueJob<T, R>, error: Error & { code?: string; stage?: string; retryable?: boolean }): void {
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
      const backoffMs = Math.min(1000 * Math.pow(2, job.attempts - 1), 30000);
      job.state = JobState.DELAYED;

      log.warn('Job failed, scheduling retry', {
        jobId: job.id, attempt: job.attempts, maxAttempts: job.maxAttempts,
        backoffMs, error: job.error.message,
      });

      setTimeout(() => {
        job.state = JobState.WAITING;
        this.waiting.unshift(job.id);
        this._processNext();
      }, backoffMs);

      this._emit('failed', job, job.error);
    } else {
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

  pause(): void {
    this.isPaused = true;
    log.info('Queue paused', { queue: this.name });
  }

  resume(): void {
    this.isPaused = false;
    log.info('Queue resumed', { queue: this.name });
    this._processNext();
  }

  // ─── EVENT SYSTEM ───────────────────────────────────────

  on(event: string, fn: EventCallback): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
  }

  private _emit(event: string, ...args: unknown[]): void {
    const fns = this.listeners.get(event) || [];
    for (const fn of fns) {
      try { fn(...args); } catch (e) { log.error('Event handler error', { event, error: (e as Error).message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats(): QueueStats {
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

  getJob(jobId: string): QueueJob<T, R> | null {
    return this.jobs.get(jobId) || null;
  }

  getJobs(state: JobState | string): QueueJob<T, R>[] {
    return Array.from(this.jobs.values()).filter(j => j.state === state);
  }

  // ─── DRAIN ──────────────────────────────────────────────

  drain(): Promise<QueueStats> {
    return new Promise((resolve) => {
      const check = (): void => {
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

  clean(): void {
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

export function createQueue<T = unknown, R = unknown>(name: string, options?: QueueOptions): ContentQueue<T, R> {
  return new ContentQueue<T, R>(name, options);
}
