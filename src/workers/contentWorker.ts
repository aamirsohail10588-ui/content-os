// ============================================================
// MODULE: workers/contentWorker.ts
// PURPOSE: Worker that processes content generation jobs from queue
// PHASE: 2
// STATUS: ACTIVE
// FEATURES:
//   - Checkpoint-based recovery (resumes from last stage on retry)
//   - Cost tracking per stage
//   - Progress reporting back to queue
//   - Timeout per stage
//   - Integrates with DLQ for permanent failures
// ============================================================

import { Logger, Hook, Script, VideoAssemblyResult, ContentFingerprint, VideoFormat } from '../types';
import { PIPELINE_CONFIG } from '../config';
import { createLogger } from '../infra/logger';
import { generateHooks, selectBestHook } from '../modules/hookEngine';
import { generateScript } from '../modules/scriptGenerator';
import { assembleVideo } from '../modules/videoAssembler';
import { checkDuplicate, registerContent } from '../registry/contentRegistry';
import { checkpointManager } from '../queue/checkpointManager';
import { costController } from '../modules/costController';
import { JobContext } from '../queue/queue';

const log: Logger = createLogger('ContentWorker');

// ─── INTERFACES ─────────────────────────────────────────────

export interface WorkerJobData {
  topic: string;
  config: {
    niche: string;
    subNiche?: string;
    tone?: string;
    targetDurationSeconds?: number;
    format?: VideoFormat;
    aiProvider?: string;
    maxVariants?: number;
  };
}

export interface WorkerResult {
  jobId: string;
  success: boolean;
  video: VideoAssemblyResult | null;
  script: Script | null;
  hook: Hook | null;
  fingerprint: ContentFingerprint | null;
  totalTimeMs: number;
  stagesCompleted: string[];
  wasResumed: boolean;
}

interface PipelineErrorThrowable {
  stage: string;
  code: string;
  message: string;
  retryable: boolean;
}

// ─── PROGRESS MAP ───────────────────────────────────────────

const PROGRESS_MAP: Record<string, number> = {
  dedup_check: 10,
  hook_generation: 25,
  script_generation: 45,
  full_dedup_check: 55,
  video_assembly: 75,
  quality_scoring: 85,
  registry_store: 95,
};

// ─── STAGE EXECUTOR WITH TIMEOUT + COST ─────────────────────

async function executeStage<R>(
  stageName: string,
  jobId: string,
  fn: () => Promise<R>,
  job?: JobContext<WorkerJobData>
): Promise<R> {
  const start = Date.now();

  if (job?.updateProgress) {
    job.updateProgress(PROGRESS_MAP[stageName] || 0);
  }

  log.info(`Stage: ${stageName}`, { jobId });

  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject({
            message: `Timeout: ${stageName}`,
            code: 'timeout',
            stage: stageName,
            retryable: true,
          }),
          PIPELINE_CONFIG.stageTimeoutMs
        )
      ),
    ]);

    // Track compute cost
    const elapsed = Date.now() - start;
    costController.recordCost(jobId, 'compute', { minutes: elapsed / 60000 });

    return result;
  } catch (err) {
    log.error(`Stage failed: ${stageName}`, { jobId, error: (err as Error).message || String(err) });
    throw err;
  }
}

// ─── PROCESS SINGLE JOB (with checkpoint recovery) ──────────

export async function processJob(job: JobContext<WorkerJobData>): Promise<WorkerResult> {
  const jobId = job.id;
  const { topic, config } = job.data;
  const startTime = Date.now();
  const stagesCompleted: string[] = [];

  log.info('Worker processing job', { jobId, topic, niche: config.niche });

  // Check for resume point
  const resumePoint = checkpointManager.getResumePoint(jobId);
  let hook: Hook | null = (resumePoint.data.hook as Hook) || null;
  let script: Script | null = (resumePoint.data.script as Script) || null;
  let videoResult: VideoAssemblyResult | null = (resumePoint.data.assemblyResult as VideoAssemblyResult) || null;
  let fingerprint: ContentFingerprint | null = null;

  if (resumePoint.isResume) {
    log.info('Resuming from checkpoint', {
      jobId,
      resumeFrom: resumePoint.resumeFrom,
      skipped: resumePoint.skippedStages,
    });
    stagesCompleted.push(...(resumePoint.skippedStages || []));
  }

  const shouldRun = (stage: string): boolean => {
    if (resumePoint.isResume && resumePoint.skippedStages?.includes(stage)) return false;
    return true;
  };

  try {
    // STAGE 1: Dedup check
    if (shouldRun('dedup_check')) {
      await executeStage('dedup_check', jobId, async () => {
        const dup = checkDuplicate(topic, '', '');
        if (dup.isDuplicate) {
          log.warn('Topic flagged as potential duplicate', { jobId, similarity: dup.highestSimilarity });
        }
      }, job);
      stagesCompleted.push('dedup_check');
    }

    // STAGE 2: Hook generation
    if (shouldRun('hook_generation')) {
      hook = await executeStage('hook_generation', jobId, async () => {
        const result = await generateHooks({
          topic,
          niche: config.niche,
          tone: config.tone || 'authoritative_yet_accessible',
          targetDurationSeconds: 5,
          variantCount: config.maxVariants || 3,
        });

        // Track AI cost
        costController.recordCost(jobId, config.aiProvider || 'claude', {
          inputTokens: 500,
          outputTokens: result.tokensUsed || 200,
        });

        const best = selectBestHook(result.hooks);
        checkpointManager.save(jobId, 'hook_generation', { hook: best });
        return best;
      }, job);
      stagesCompleted.push('hook_generation');
    }

    // STAGE 3: Script generation
    if (shouldRun('script_generation')) {
      script = await executeStage('script_generation', jobId, async () => {
        const result = await generateScript({
          hook: hook!,
          topic,
          niche: config.niche,
          tone: config.tone || 'authoritative_yet_accessible',
          targetDurationSeconds: config.targetDurationSeconds || 60,
        });

        // Track AI cost
        costController.recordCost(jobId, config.aiProvider || 'claude', {
          inputTokens: 800,
          outputTokens: result.tokensUsed || 500,
        });

        checkpointManager.save(jobId, 'script_generation', { hook, script: result.script });
        return result.script;
      }, job);
      stagesCompleted.push('script_generation');
    }

    // STAGE 4: Full dedup check
    if (shouldRun('full_dedup_check')) {
      await executeStage('full_dedup_check', jobId, async () => {
        const dup = checkDuplicate(topic, hook!.text, script!.fullText);
        if (dup.isDuplicate) {
          const dupError: PipelineErrorThrowable = {
            stage: 'dedup_check',
            code: 'DUPLICATE_CONTENT',
            message: `Too similar (${dup.highestSimilarity})`,
            retryable: false,
          };
          throw dupError;
        }
      }, job);
      stagesCompleted.push('full_dedup_check');
    }

    // STAGE 5: Video assembly
    if (shouldRun('video_assembly')) {
      videoResult = await executeStage('video_assembly', jobId, async () => {
        const result = await assembleVideo(script!, config.format || VideoFormat.YOUTUBE_SHORT);
        checkpointManager.save(jobId, 'video_assembly', {
          hook: hook as unknown as Record<string, unknown>,
          script: script as unknown as Record<string, unknown>,
          assemblyResult: result as unknown as Record<string, unknown>,
        });

        // Track storage cost
        costController.recordCost(jobId, 'storage', {
          sizeGB: result.fileSizeBytes / (1024 * 1024 * 1024),
        });

        return result;
      }, job);
      stagesCompleted.push('video_assembly');
    }

    // STAGE 6: Register
    if (shouldRun('registry_store')) {
      fingerprint = await executeStage('registry_store', jobId, async () => {
        return registerContent(
          jobId, topic, hook!.text, hook!.pattern,
          script!.fullText, script!.totalDurationSeconds, config.niche
        );
      }, job);
      stagesCompleted.push('registry_store');
    }

    // Cleanup checkpoint
    checkpointManager.clear(jobId);

    if (job.updateProgress) job.updateProgress(100);

    const result: WorkerResult = {
      jobId,
      success: true,
      video: videoResult,
      script,
      hook,
      fingerprint,
      totalTimeMs: Date.now() - startTime,
      stagesCompleted,
      wasResumed: resumePoint.isResume,
    };

    log.info('Job completed', {
      jobId,
      totalTimeMs: result.totalTimeMs,
      stages: stagesCompleted.length,
      resumed: resumePoint.isResume,
      cost: costController.getVideoCost(jobId)?.totalUSD || 0,
    });

    return result;

  } catch (err) {
    const rawErr = err as PipelineErrorThrowable & Error;
    const pipelineError: PipelineErrorThrowable = rawErr.stage
      ? rawErr
      : {
          stage: 'unknown',
          code: 'UNKNOWN',
          message: rawErr.message || String(err),
          retryable: true,
        };

    throw pipelineError;
  }
}
