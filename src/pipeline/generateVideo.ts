// ============================================================
// MODULE: pipeline/generateVideo.ts
// PURPOSE: End-to-end pipeline orchestrator for video generation
// PHASE: 1
// STATUS: ACTIVE
// FLOW: dedup check → hookEngine → scriptGenerator →
//       videoAssembler → registry store → return result
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import {
  ContentConfig,
  PipelineJob,
  PipelineResult,
  PipelineStage,
  PipelineCheckpoint,
  PipelineError,
  JobStatus,
  Hook,
  Script,
  VideoAssemblyResult,
  ContentFingerprint,
} from '../types';
import { PIPELINE_CONFIG, DEFAULT_CONTENT_CONFIG } from '../config';
import { generateHooks, selectBestHook } from '../modules/hookEngine';
import { generateScript } from '../modules/scriptGenerator';
import { assembleVideo } from '../modules/videoAssembler';
import { publishVideo, PublishResult } from '../modules/publisher';
import { checkDuplicate, registerContent } from '../registry/contentRegistry';
import { createLogger } from '../infra/logger';
import { redis } from '../infra/redis';
import { researchTopic } from '../infra/topicResearcher';
import { experimentEngine, HOOK_AB_EXPERIMENT } from '../core/engines';

const log = createLogger('Pipeline');

// ─── CHECKPOINT MANAGER (Redis-backed) ──────────────────────

const CHECKPOINT_TTL = 86400; // 24h in seconds

async function saveCheckpoint(jobId: string, stage: PipelineStage, data: PipelineCheckpoint['data']): Promise<void> {
  const checkpoint: PipelineCheckpoint = {
    stage,
    data,
    timestamp: new Date(),
  };
  await redis.set(`checkpoint:${jobId}`, JSON.stringify(checkpoint), 'EX', CHECKPOINT_TTL);
  log.debug('Checkpoint saved', { jobId, stage });
}

async function getCheckpoint(jobId: string): Promise<PipelineCheckpoint | null> {
  const raw = await redis.get(`checkpoint:${jobId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PipelineCheckpoint;
  } catch {
    return null;
  }
}

async function clearCheckpoint(jobId: string): Promise<void> {
  await redis.del(`checkpoint:${jobId}`);
}

// ─── STAGE EXECUTOR WITH TIMEOUT ────────────────────────────

async function executeStage<T>(
  stageName: PipelineStage,
  jobId: string,
  fn: () => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  const startTime = Date.now();
  const timeout = timeoutMs ?? PIPELINE_CONFIG.stageTimeoutMs;
  log.info(`Stage started: ${stageName}`, { jobId, timeoutMs: timeout });

  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Stage timeout: ${stageName}`)), timeout)
      ),
    ]);

    const elapsed = Date.now() - startTime;
    log.info(`Stage completed: ${stageName}`, { jobId, timeMs: elapsed });
    return result;
  } catch (err) {
    const error = err as Error | PipelineError;
    const elapsed = Date.now() - startTime;

    log.error(`Stage failed: ${stageName}`, {
      jobId,
      timeMs: elapsed,
      error: 'message' in error ? error.message : String(error),
    });

    throw error;
  }
}

// ─── MAIN PIPELINE ──────────────────────────────────────────

export async function generateVideo(
  topic: string,
  config: ContentConfig = DEFAULT_CONTENT_CONFIG
): Promise<PipelineResult> {
  const jobId = uuidv4();
  const startTime = Date.now();
  const stagesCompleted: PipelineStage[] = [];

  log.info('Pipeline started', {
    jobId,
    topic,
    niche: config.niche,
    targetDuration: config.targetDurationSeconds,
    format: config.format,
  });

  // Track job state
  const job: PipelineJob = {
    jobId,
    config,
    topic,
    currentStage: PipelineStage.DEDUP_CHECK,
    status: JobStatus.IN_PROGRESS,
    checkpoint: await getCheckpoint(jobId),
    attempts: 1,
    maxAttempts: PIPELINE_CONFIG.maxAttempts,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let researchBrief = '';
  let hook: Hook | undefined;
  let script: Script | undefined;
  let videoResult: VideoAssemblyResult | undefined;
  let fingerprint: ContentFingerprint | undefined;
  let publishResults: PublishResult[] = [];

  try {
    // ─── STAGE 1: DEDUPLICATION CHECK ───────────────────────
    await executeStage(PipelineStage.DEDUP_CHECK, jobId, async () => {
      const dupCheck = checkDuplicate(topic, '', ''); // pre-check on topic alone
      if (dupCheck.isDuplicate) {
        log.warn('Topic flagged as potential duplicate', {
          jobId,
          similarity: dupCheck.highestSimilarity,
          matchedId: dupCheck.matchedFingerprintId,
        });
        // For Phase 1: warn but don't block. Phase 3: configurable reject/mutate
      }
    });
    stagesCompleted.push(PipelineStage.DEDUP_CHECK);

    // ─── STAGE 1.5: TOPIC RESEARCH ──────────────────────────
    researchBrief = await executeStage(PipelineStage.TOPIC_RESEARCH, jobId, async () => {
      const brief = await researchTopic(topic, config.niche);
      if (!brief) log.warn('Topic research returned empty — continuing without research', { jobId });
      await saveCheckpoint(jobId, PipelineStage.TOPIC_RESEARCH, { researchBrief: brief });
      return brief;
    }).catch((err: Error) => {
      log.warn('Topic research stage failed — continuing without research', { jobId, error: err.message });
      return '';
    });

    // ─── STAGE 2: HOOK GENERATION ───────────────────────────
    hook = await executeStage(PipelineStage.HOOK_GENERATION, jobId, async () => {
      const hookResult = await generateHooks({
        topic,
        niche: config.niche,
        tone: config.tone || 'authoritative_yet_accessible',
        targetDurationSeconds: 5,
        variantCount: config.maxVariants,
        voiceLanguage: (config as any).voiceLanguage || 'english',
        researchBrief: researchBrief || undefined,
      });

      const bestHook = await selectBestHook(hookResult.hooks);

      await saveCheckpoint(jobId, PipelineStage.HOOK_GENERATION, { hook: bestHook, researchBrief });
      return bestHook;
    });
    stagesCompleted.push(PipelineStage.HOOK_GENERATION);

    // ─── STAGE 3: SCRIPT GENERATION ─────────────────────────
    script = await executeStage(PipelineStage.SCRIPT_GENERATION, jobId, async () => {
      const scriptResult = await generateScript({
        hook: hook!,
        topic,
        niche: config.niche,
        tone: config.tone || 'authoritative_yet_accessible',
        targetDurationSeconds: config.targetDurationSeconds,
        voiceLanguage: (config as any).voiceLanguage || 'english',
        researchBrief,
      });

      await saveCheckpoint(jobId, PipelineStage.SCRIPT_GENERATION, {
        hook: hook!,
        script: scriptResult.script,
      });

      return scriptResult.script;
    });
    stagesCompleted.push(PipelineStage.SCRIPT_GENERATION);

    // ─── STAGE 4: FULL DEDUP CHECK (with script content) ───
    await executeStage(PipelineStage.DEDUP_CHECK, jobId, async () => {
      const fullDupCheck = checkDuplicate(topic, hook!.text, script!.fullText);
      if (fullDupCheck.isDuplicate) {
        const error: PipelineError = {
          stage: PipelineStage.DEDUP_CHECK,
          code: 'DUPLICATE_CONTENT',
          message: `Content too similar to existing (similarity: ${fullDupCheck.highestSimilarity})`,
          retryable: true,
          timestamp: new Date(),
          details: {
            similarity: fullDupCheck.highestSimilarity,
            matchedId: fullDupCheck.matchedFingerprintId,
          },
        };
        throw error;
      }
    });

    // ─── STAGE 5: VIDEO ASSEMBLY (longer timeout: ElevenLabs + FFmpeg) ──
    videoResult = await executeStage(PipelineStage.VIDEO_ASSEMBLY, jobId, async () => {
      const result = await assembleVideo(script!, config.format, {
        language: (config as any).voiceLanguage || 'english',
        gender: (config as any).voiceGender || 'male',
      });

      await saveCheckpoint(jobId, PipelineStage.VIDEO_ASSEMBLY, {
        hook: hook!,
        script: script!,
        assemblyResult: result,
      });

      return result;
    }, PIPELINE_CONFIG.videoAssemblyTimeoutMs);
    stagesCompleted.push(PipelineStage.VIDEO_ASSEMBLY);

    // ─── STAGE 6: PUBLISH TO PLATFORMS ──────────────────────
    publishResults = await publishVideo(
      videoResult!.outputPath,
      topic,
      `${hook!.text}\n\n#finance #money #investing #personalfinance`
    );
    const publishedUrls = publishResults.filter(r => r.success);
    for (const r of publishResults) {
      if (r.success) log.info(`Published to ${r.platform}`, { url: r.url });
      else log.warn(`Publish failed: ${r.platform}`, { error: r.error });
    }

    // Wire ExperimentEngine to real production events after successful publish
    if (publishedUrls.length > 0 && hook) {
      experimentEngine.recordObservation(HOOK_AB_EXPERIMENT.id, hook.pattern, {
        views: 0,
        likes: 0,
      });
      log.debug('ExperimentEngine observation recorded', { pattern: hook.pattern });
    }

    // ─── STAGE 7: REGISTER IN CONTENT REGISTRY ─────────────
    fingerprint = await executeStage(PipelineStage.REGISTRY_STORE, jobId, async () => {
      return registerContent(
        jobId,
        topic,
        hook!.text,
        hook!.pattern,
        script!.fullText,
        script!.totalDurationSeconds,
        config.niche
      );
    });
    stagesCompleted.push(PipelineStage.REGISTRY_STORE);

    // ─── CLEANUP ────────────────────────────────────────────
    await clearCheckpoint(jobId);

    const totalTimeMs = Date.now() - startTime;

    const result: PipelineResult = {
      jobId,
      success: true,
      video: videoResult,
      script,
      hook,
      fingerprint,
      totalTimeMs,
      stagesCompleted,
    };

    log.info('Pipeline completed successfully', {
      jobId,
      totalTimeMs,
      stages: stagesCompleted.length,
      hookPattern: hook.pattern,
      hookScore: hook.strengthScore,
      scriptDuration: script.totalDurationSeconds,
      scriptSegments: script.segments.length,
    });

    return result;

  } catch (err) {
    const totalTimeMs = Date.now() - startTime;
    const error = err as PipelineError | Error;

    const pipelineError: PipelineError = 'stage' in error
      ? error
      : {
          stage: job.currentStage,
          code: 'UNKNOWN_ERROR',
          message: error.message || String(error),
          retryable: true,
          timestamp: new Date(),
        };

    log.error('Pipeline failed', {
      jobId,
      totalTimeMs,
      stage: pipelineError.stage,
      code: pipelineError.code,
      message: pipelineError.message,
      stagesCompleted: stagesCompleted.length,
    });

    return {
      jobId,
      success: false,
      hook,
      script,
      video: videoResult,
      fingerprint,
      totalTimeMs,
      stagesCompleted,
      error: pipelineError,
    };
  }
}
