// ============================================================
// MODULE: pipeline.js
// PURPOSE: End-to-end pipeline orchestrator
// PHASE: 1
// FLOW: dedup → hooks → script → assembly → register → result
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { PIPELINE_CONFIG } = require('./config');
const { generateHooks, selectBestHook } = require('./hookEngine');
const { generateScript } = require('./scriptGenerator');
const { assembleVideo } = require('./videoAssembler');
const { checkDuplicate, registerContent } = require('./contentRegistry');

const log = createLogger('Pipeline');

// In-memory checkpoints (Phase 2: Redis)
const checkpoints = new Map();

function saveCheckpoint(jobId, stage, data) {
  checkpoints.set(jobId, { stage, data, timestamp: new Date() });
}

function clearCheckpoint(jobId) {
  checkpoints.delete(jobId);
}

async function executeStage(stageName, jobId, fn) {
  const start = Date.now();
  log.info(`Stage started: ${stageName}`, { jobId });
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${stageName}`)), PIPELINE_CONFIG.stageTimeoutMs)),
    ]);
    log.info(`Stage completed: ${stageName}`, { jobId, timeMs: Date.now() - start });
    return result;
  } catch (err) {
    log.error(`Stage failed: ${stageName}`, { jobId, timeMs: Date.now() - start, error: err.message || String(err) });
    throw err;
  }
}

async function generateVideoInternal(jobId, topic, config) {
  const startTime = Date.now();
  const stagesCompleted = [];

  log.info('Pipeline started', { jobId, topic, niche: config.niche, targetDuration: config.targetDurationSeconds, format: config.format });

  let hook, script, videoResult, fingerprint;

  try {
    // STAGE 1: Pre-dedup check (topic only)
    await executeStage('dedup_check', jobId, async () => {
      const dup = checkDuplicate(topic, '', '');
      if (dup.isDuplicate) log.warn('Topic flagged as potential duplicate', { jobId, similarity: dup.highestSimilarity });
    });
    stagesCompleted.push('dedup_check');

    // STAGE 2: Hook generation
    hook = await executeStage('hook_generation', jobId, async () => {
      const result = await generateHooks({
        topic, niche: config.niche, tone: config.tone || 'authoritative_yet_accessible',
        targetDurationSeconds: 5, variantCount: config.maxVariants,
        voiceLanguage: config.voiceLanguage || 'english',
      });
      const best = selectBestHook(result.hooks);
      saveCheckpoint(jobId, 'hook_generation', { hook: best });
      return best;
    });
    stagesCompleted.push('hook_generation');

    // STAGE 3: Script generation
    script = await executeStage('script_generation', jobId, async () => {
      const result = await generateScript({
        hook, topic, niche: config.niche,
        tone: config.tone || 'authoritative_yet_accessible',
        targetDurationSeconds: config.targetDurationSeconds,
        voiceLanguage: config.voiceLanguage || 'english',
      });
      saveCheckpoint(jobId, 'script_generation', { hook, script: result.script });
      return result.script;
    });
    stagesCompleted.push('script_generation');

    // STAGE 4: Full dedup check (with script content)
    await executeStage('full_dedup_check', jobId, async () => {
      const dup = checkDuplicate(topic, hook.text, script.fullText);
      if (dup.isDuplicate) {
        throw { stage: 'dedup_check', code: 'DUPLICATE_CONTENT', message: `Too similar (${dup.highestSimilarity})`, retryable: true };
      }
    });
    stagesCompleted.push('full_dedup_check');

    // STAGE 5: Video assembly
    videoResult = await executeStage('video_assembly', jobId, async () => {
      const result = await assembleVideo(script, config.format, {
        language: config.voiceLanguage || 'english',
        gender: config.voiceGender || 'male',
      });
      saveCheckpoint(jobId, 'video_assembly', { hook, script, assemblyResult: result });
      return result;
    });
    stagesCompleted.push('video_assembly');

    // STAGE 6: Register content
    fingerprint = await executeStage('registry_store', jobId, async () => {
      return registerContent(jobId, topic, hook.text, hook.pattern, script.fullText, script.totalDurationSeconds, config.niche);
    });
    stagesCompleted.push('registry_store');

    clearCheckpoint(jobId);

    const result = {
      jobId, success: true, video: videoResult, script, hook, fingerprint,
      totalTimeMs: Date.now() - startTime, stagesCompleted,
    };

    log.info('Pipeline completed', {
      jobId, totalTimeMs: result.totalTimeMs, stages: stagesCompleted.length,
      hookPattern: hook.pattern, hookScore: hook.strengthScore,
      scriptDuration: script.totalDurationSeconds,
    });

    return result;

  } catch (err) {
    const pipelineError = err.stage ? err : { stage: 'unknown', code: 'UNKNOWN_ERROR', message: err.message || String(err), retryable: true };

    log.error('Pipeline failed', { jobId, totalTimeMs: Date.now() - startTime, stage: pipelineError.stage, code: pipelineError.code });

    return {
      jobId, success: false, hook, script, video: videoResult, fingerprint,
      totalTimeMs: Date.now() - startTime, stagesCompleted, error: pipelineError,
    };
  }
}

async function generateVideo(topic, config) {
  const jobId = crypto.randomUUID();
  const startTime = Date.now();

  return Promise.race([
    generateVideoInternal(jobId, topic, config),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Total pipeline timeout after ${PIPELINE_CONFIG.totalTimeoutMs}ms`)),
        PIPELINE_CONFIG.totalTimeoutMs
      )
    ),
  ]).catch(err => {
    log.error('Pipeline timed out or failed', { jobId, totalTimeMs: Date.now() - startTime, error: err.message });
    return {
      jobId, success: false, hook: undefined, script: undefined, video: undefined, fingerprint: undefined,
      totalTimeMs: Date.now() - startTime, stagesCompleted: [],
      error: { stage: 'pipeline', code: 'TOTAL_TIMEOUT', message: err.message, retryable: false },
    };
  });
}

module.exports = { generateVideo };
