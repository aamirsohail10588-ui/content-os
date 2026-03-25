// ============================================================
// MODULE: checkpointManager.js
// PURPOSE: Checkpoint-based recovery for pipeline jobs
// PHASE: 2
// STATUS: ACTIVE
// NOTE: In-memory + file-backed. Production: Redis persistence
// RULE: Each pipeline stage writes checkpoint BEFORE executing
//       On retry → read last checkpoint → skip completed stages
//       Prevents wasted API calls on restart
// ============================================================

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('CheckpointManager');

const CHECKPOINT_DIR = '/tmp/content-os/checkpoints';

// ─── PIPELINE STAGES (ordered) ──────────────────────────────

const STAGES = [
  'dedup_check',
  'hook_generation',
  'script_generation',
  'full_dedup_check',
  'voice_generation',
  'video_assembly',
  'quality_scoring',
  'registry_store',
  'complete',
];

function getStageIndex(stage) {
  return STAGES.indexOf(stage);
}

// ─── CHECKPOINT STORE ───────────────────────────────────────

class CheckpointManager {
  constructor() {
    this.checkpoints = new Map();
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
  }

  // ─── SAVE CHECKPOINT ───────────────────────────────────

  save(jobId, stage, data) {
    const checkpoint = {
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
      log.warn('Failed to persist checkpoint to disk', { jobId, error: err.message });
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

  get(jobId) {
    // Try memory first
    let checkpoint = this.checkpoints.get(jobId);

    // Fallback to disk
    if (!checkpoint) {
      try {
        const filePath = path.join(CHECKPOINT_DIR, `${jobId}.json`);
        if (fs.existsSync(filePath)) {
          checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          this.checkpoints.set(jobId, checkpoint); // cache
        }
      } catch (err) {
        log.warn('Failed to read checkpoint from disk', { jobId, error: err.message });
      }
    }

    return checkpoint || null;
  }

  // ─── CHECK IF STAGE CAN BE SKIPPED ──────────────────────

  canSkipStage(jobId, stage) {
    const checkpoint = this.get(jobId);
    if (!checkpoint) return false;

    const checkpointStageIndex = checkpoint.stageIndex;
    const requestedStageIndex = getStageIndex(stage);

    // Can skip if checkpoint is at or past this stage
    return checkpointStageIndex >= requestedStageIndex;
  }

  // ─── GET RESUME POINT ───────────────────────────────────

  getResumePoint(jobId) {
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
      skippedStages: STAGES.slice(0, nextStageIndex),
    };
  }

  // ─── CLEAR CHECKPOINT ───────────────────────────────────

  clear(jobId) {
    this.checkpoints.delete(jobId);

    try {
      const filePath = path.join(CHECKPOINT_DIR, `${jobId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      log.warn('Failed to delete checkpoint file', { jobId, error: err.message });
    }

    log.info('Checkpoint cleared', { jobId });
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats() {
    // Count disk-backed checkpoints
    let diskCount = 0;
    try {
      diskCount = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json')).length;
    } catch (e) { /* ignore */ }

    return {
      inMemory: this.checkpoints.size,
      onDisk: diskCount,
      stages: STAGES,
    };
  }

  // ─── LIST ACTIVE CHECKPOINTS ────────────────────────────

  listActive() {
    return Array.from(this.checkpoints.values()).map(cp => ({
      jobId: cp.jobId,
      stage: cp.stage,
      savedAt: cp.savedAt,
    }));
  }

  // ─── CLEAN ALL ──────────────────────────────────────────

  cleanAll() {
    this.checkpoints.clear();
    try {
      const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(CHECKPOINT_DIR, file));
      }
    } catch (e) { /* ignore */ }
    log.info('All checkpoints cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const checkpointManager = new CheckpointManager();

module.exports = { CheckpointManager, checkpointManager, STAGES, getStageIndex };
