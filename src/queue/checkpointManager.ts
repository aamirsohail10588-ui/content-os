// ============================================================
// MODULE: queue/checkpointManager.ts
// PURPOSE: Checkpoint-based recovery for pipeline jobs
// PHASE: 2
// STATUS: ACTIVE
// NOTE: In-memory + file-backed. Production: Redis persistence
// RULE: Each pipeline stage writes checkpoint BEFORE executing
//       On retry -> read last checkpoint -> skip completed stages
//       Prevents wasted API calls on restart
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('CheckpointManager');

const CHECKPOINT_DIR = '/tmp/content-os/checkpoints';

// ─── PIPELINE STAGES (ordered) ──────────────────────────────

export const STAGES: readonly string[] = [
  'dedup_check',
  'hook_generation',
  'script_generation',
  'full_dedup_check',
  'voice_generation',
  'video_assembly',
  'quality_scoring',
  'registry_store',
  'complete',
] as const;

export type PipelineStageName = typeof STAGES[number];

export function getStageIndex(stage: string): number {
  return STAGES.indexOf(stage);
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface Checkpoint {
  jobId: string;
  stage: string;
  stageIndex: number;
  data: Record<string, unknown>;
  savedAt: string;
  version: number;
}

export interface ResumePoint {
  resumeFrom: string;
  data: Record<string, unknown>;
  isResume: boolean;
  lastCompleted?: string;
  skippedStages?: string[];
}

export interface CheckpointStats {
  inMemory: number;
  onDisk: number;
  stages: readonly string[];
}

export interface ActiveCheckpoint {
  jobId: string;
  stage: string;
  savedAt: string;
}

// ─── CHECKPOINT STORE ───────────────────────────────────────

export class CheckpointManager {
  private checkpoints: Map<string, Checkpoint>;

  constructor() {
    this.checkpoints = new Map();
    this._ensureDir();
  }

  private _ensureDir(): void {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
  }

  // ─── SAVE CHECKPOINT ───────────────────────────────────

  save(jobId: string, stage: string, data: Record<string, unknown>): Checkpoint {
    const checkpoint: Checkpoint = {
      jobId,
      stage,
      stageIndex: getStageIndex(stage),
      data: { ...data },
      savedAt: new Date().toISOString(),
      version: 1,
    };

    // In-memory
    this.checkpoints.set(jobId, checkpoint);

    // File-backed (survives process restart)
    try {
      const filePath = path.join(CHECKPOINT_DIR, `${jobId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
    } catch (err) {
      log.warn('Failed to persist checkpoint to disk', { jobId, error: (err as Error).message });
    }

    log.info('Checkpoint saved', {
      jobId,
      stage,
      stageIndex: checkpoint.stageIndex,
      dataKeys: Object.keys(data),
    });

    return checkpoint;
  }

  // ─── GET CHECKPOINT ─────────────────────────────────────

  get(jobId: string): Checkpoint | null {
    // Try memory first
    let checkpoint = this.checkpoints.get(jobId) || null;

    // Fallback to disk
    if (!checkpoint) {
      try {
        const filePath = path.join(CHECKPOINT_DIR, `${jobId}.json`);
        if (fs.existsSync(filePath)) {
          checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Checkpoint;
          this.checkpoints.set(jobId, checkpoint); // cache
        }
      } catch (err) {
        log.warn('Failed to read checkpoint from disk', { jobId, error: (err as Error).message });
      }
    }

    return checkpoint;
  }

  // ─── CHECK IF STAGE CAN BE SKIPPED ──────────────────────

  canSkipStage(jobId: string, stage: string): boolean {
    const checkpoint = this.get(jobId);
    if (!checkpoint) return false;

    const checkpointStageIndex = checkpoint.stageIndex;
    const requestedStageIndex = getStageIndex(stage);

    return checkpointStageIndex >= requestedStageIndex;
  }

  // ─── GET RESUME POINT ───────────────────────────────────

  getResumePoint(jobId: string): ResumePoint {
    const checkpoint = this.get(jobId);
    if (!checkpoint) {
      return { resumeFrom: STAGES[0], data: {}, isResume: false };
    }

    const nextStageIndex = checkpoint.stageIndex + 1;
    if (nextStageIndex >= STAGES.length) {
      return { resumeFrom: 'complete', data: checkpoint.data, isResume: true };
    }

    const resumeStage = STAGES[nextStageIndex];

    log.info('Resume point determined', {
      jobId,
      lastCompleted: checkpoint.stage,
      resumeFrom: resumeStage,
      skippedStages: STAGES.slice(0, nextStageIndex),
    });

    return {
      resumeFrom: resumeStage,
      data: checkpoint.data,
      isResume: true,
      lastCompleted: checkpoint.stage,
      skippedStages: STAGES.slice(0, nextStageIndex) as string[],
    };
  }

  // ─── CLEAR CHECKPOINT ───────────────────────────────────

  clear(jobId: string): void {
    this.checkpoints.delete(jobId);

    try {
      const filePath = path.join(CHECKPOINT_DIR, `${jobId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      log.warn('Failed to delete checkpoint file', { jobId, error: (err as Error).message });
    }

    log.info('Checkpoint cleared', { jobId });
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats(): CheckpointStats {
    let diskCount = 0;
    try {
      diskCount = fs.readdirSync(CHECKPOINT_DIR).filter((f: string) => f.endsWith('.json')).length;
    } catch (_e) { /* ignore */ }

    return {
      inMemory: this.checkpoints.size,
      onDisk: diskCount,
      stages: STAGES,
    };
  }

  // ─── LIST ACTIVE CHECKPOINTS ────────────────────────────

  listActive(): ActiveCheckpoint[] {
    return Array.from(this.checkpoints.values()).map((cp: Checkpoint) => ({
      jobId: cp.jobId,
      stage: cp.stage,
      savedAt: cp.savedAt,
    }));
  }

  // ─── CLEAN ALL ──────────────────────────────────────────

  cleanAll(): void {
    this.checkpoints.clear();
    try {
      const files = fs.readdirSync(CHECKPOINT_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(CHECKPOINT_DIR, file));
      }
    } catch (_e) { /* ignore */ }
    log.info('All checkpoints cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const checkpointManager = new CheckpointManager();
