// ============================================================
// MODULE: modules/variantGenerator.ts
// PURPOSE: Generate N video variants per topic, score and select best
// PHASE: 2
// STATUS: ACTIVE
// FLOW: For each topic -> generate N variants in parallel ->
//       score each -> rank -> return best + alternatives
// ============================================================

import * as crypto from 'crypto';
import {
  Logger,
  Hook,
  Script,
  VideoAssemblyResult,
  QualityScore,
  ContentConfig,
  ContentFingerprint,
  HookPattern,
  VideoFormat,
} from '../types';
import { createLogger } from '../infra/logger';
import { generateHooks } from '../modules/hookEngine';
import { generateScript } from '../modules/scriptGenerator';
import { assembleVideo } from '../modules/videoAssembler';
import { checkDuplicate, registerContent } from '../registry/contentRegistry';
import { costController, BudgetStatus } from '../modules/costController';

const log: Logger = createLogger('VariantGenerator');

// ─── INTERFACES ─────────────────────────────────────────────

export interface VariantResult {
  variantId: string;
  variantIndex: number;
  hook: Hook;
  script: Script;
  video: VideoAssemblyResult;
  qualityScore: QualityScore;
  totalTimeMs: number;
  cost: { totalUSD: number } | null;
}

export interface VariantBatchResult {
  success: boolean;
  topic: string;
  best: VariantResult | null;
  alternatives: VariantResult[];
  variants: VariantResult[];
  stats: {
    attempted: number;
    valid: number;
    failed: number;
    totalTimeMs: number;
    scoreRange: {
      min: number;
      max: number;
    };
  };
  error?: {
    code: string;
    message: string;
  };
}

// ─── QUALITY SCORING ────────────────────────────────────────

export function scoreVariant(hook: Hook, script: Script, _videoResult: VideoAssemblyResult): QualityScore {
  const scores: Record<string, number> = {};

  // Hook strength (already scored by hookEngine)
  scores.hookStrength = hook.strengthScore;

  // Script coherence — word count relative to target
  const targetWords = script.totalDurationSeconds * 2.5;
  const wordRatio = script.wordCount / targetWords;
  scores.scriptCoherence = Math.max(0, Math.min(100, 100 - Math.abs(1 - wordRatio) * 100));

  // Pacing consistency — variance in segment durations
  const segDurations = script.segments.map(s => s.estimatedDurationSeconds);
  const avgDuration = segDurations.reduce((a, b) => a + b, 0) / segDurations.length;
  const variance = segDurations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / segDurations.length;
  scores.pacingConsistency = Math.max(0, Math.min(100, 100 - variance * 5));

  // Segment count appropriateness
  const idealSegments = Math.ceil(script.totalDurationSeconds / 10);
  const segDiff = Math.abs(script.segments.length - idealSegments);
  scores.structureScore = Math.max(0, 100 - segDiff * 15);

  // Estimated retention (mock — Phase 4 replaces with real analytics)
  scores.estimatedRetention = Math.round(
    scores.hookStrength * 0.4 +
    scores.pacingConsistency * 0.3 +
    scores.scriptCoherence * 0.2 +
    scores.structureScore * 0.1
  );

  // Overall
  const overall = Math.round(
    scores.hookStrength * 0.30 +
    scores.scriptCoherence * 0.25 +
    scores.pacingConsistency * 0.20 +
    scores.estimatedRetention * 0.15 +
    scores.structureScore * 0.10
  );

  return {
    overall,
    hookStrength: scores.hookStrength,
    pacingConsistency: scores.pacingConsistency,
    scriptCoherence: scores.scriptCoherence,
    estimatedRetention: scores.estimatedRetention,
    breakdown: scores,
  };
}

// ─── GENERATE SINGLE VARIANT ────────────────────────────────

export async function generateVariant(
  topic: string,
  config: Partial<ContentConfig>,
  variantIndex: number
): Promise<VariantResult | null> {
  const variantId = crypto.randomUUID();
  const startTime = Date.now();

  log.info('Generating variant', { variantId, variantIndex, topic });

  try {
    // Generate hooks (each variant gets different random hooks)
    const hookResult = await generateHooks({
      topic,
      niche: config.niche || 'finance',
      tone: config.tone || 'authoritative_yet_accessible',
      targetDurationSeconds: 5,
      variantCount: 3,
    });

    // Pick best hook for this variant
    const hook: Hook = hookResult.hooks[0]; // already sorted by score

    // Track cost
    costController.recordCost(variantId, config.aiProvider || 'claude', {
      inputTokens: 500,
      outputTokens: hookResult.tokensUsed || 200,
    });

    // Generate script
    const scriptResult = await generateScript({
      hook,
      topic,
      niche: config.niche || 'finance',
      tone: config.tone || 'authoritative_yet_accessible',
      targetDurationSeconds: config.targetDurationSeconds || 60,
    });

    costController.recordCost(variantId, config.aiProvider || 'claude', {
      inputTokens: 800,
      outputTokens: scriptResult.tokensUsed || 500,
    });

    // Dedup check
    const dupCheck = checkDuplicate(topic, hook.text, scriptResult.script.fullText);
    if (dupCheck.isDuplicate) {
      log.warn('Variant is duplicate, skipping', { variantId, similarity: dupCheck.highestSimilarity });
      return null;
    }

    // Assemble video
    const videoResult = await assembleVideo(
      scriptResult.script,
      (config.format as VideoFormat) || VideoFormat.YOUTUBE_SHORT
    );

    costController.recordCost(variantId, 'storage', {
      sizeGB: videoResult.fileSizeBytes / (1024 * 1024 * 1024),
    });

    // Score variant
    const qualityScore = scoreVariant(hook, scriptResult.script, videoResult);

    return {
      variantId,
      variantIndex,
      hook,
      script: scriptResult.script,
      video: videoResult,
      qualityScore,
      totalTimeMs: Date.now() - startTime,
      cost: costController.getVideoCost(variantId),
    };

  } catch (err) {
    log.error('Variant generation failed', {
      variantId,
      variantIndex,
      error: (err as Error).message || String(err),
    });
    return null;
  }
}

// ─── GENERATE ALL VARIANTS + SELECT BEST ────────────────────

export async function generateVariants(
  topic: string,
  config: Partial<ContentConfig>
): Promise<VariantBatchResult> {
  const variantCount = config.maxVariants || 3;
  const startTime = Date.now();

  log.info('Starting multi-variant generation', { topic, variantCount, niche: config.niche });

  // Budget check before starting
  const budget: BudgetStatus = costController.checkBudget();
  if (!budget.canProceed) {
    log.error('Budget exceeded, cannot generate variants', { budget: budget as unknown as Record<string, unknown> });
    return {
      success: false,
      topic,
      error: { code: 'BUDGET_EXCEEDED', message: 'Daily/weekly/monthly budget cap reached' },
      variants: [],
      best: null,
      alternatives: [],
      stats: { attempted: 0, valid: 0, failed: 0, totalTimeMs: 0, scoreRange: { min: 0, max: 0 } },
    };
  }

  // If soft throttle, reduce variant count
  let effectiveCount = variantCount;
  if (budget.throttleLevel === 'soft') {
    effectiveCount = Math.max(1, Math.floor(variantCount / 2));
    log.warn('Budget soft throttle: reducing variants', { original: variantCount, reduced: effectiveCount });
  }

  // Generate variants (parallel execution)
  const promises: Promise<VariantResult | null>[] = [];
  for (let i = 0; i < effectiveCount; i++) {
    promises.push(generateVariant(topic, config, i));
  }

  const results = await Promise.all(promises);

  // Filter out null (failed or duplicate)
  const validVariants: VariantResult[] = results.filter((v): v is VariantResult => v !== null);

  if (validVariants.length === 0) {
    log.error('All variants failed or were duplicates', { topic, attempted: effectiveCount });
    return {
      success: false,
      topic,
      error: { code: 'ALL_VARIANTS_FAILED', message: 'No valid variants generated' },
      variants: [],
      best: null,
      alternatives: [],
      stats: {
        attempted: effectiveCount,
        valid: 0,
        failed: effectiveCount,
        totalTimeMs: Date.now() - startTime,
        scoreRange: { min: 0, max: 0 },
      },
    };
  }

  // Rank by quality score
  validVariants.sort((a, b) => b.qualityScore.overall - a.qualityScore.overall);

  const best = validVariants[0];
  const alternatives = validVariants.slice(1);

  // Register best variant in content registry
  registerContent(
    best.variantId,
    topic,
    best.hook.text,
    best.hook.pattern as HookPattern,
    best.script.fullText,
    best.script.totalDurationSeconds,
    config.niche || 'finance'
  );

  const totalTimeMs = Date.now() - startTime;

  log.info('Multi-variant generation complete', {
    topic,
    attempted: effectiveCount,
    valid: validVariants.length,
    bestScore: best.qualityScore.overall,
    bestHookPattern: best.hook.pattern,
    totalTimeMs,
  });

  return {
    success: true,
    topic,
    best,
    alternatives,
    variants: validVariants,
    stats: {
      attempted: effectiveCount,
      valid: validVariants.length,
      failed: effectiveCount - validVariants.length,
      totalTimeMs,
      scoreRange: {
        min: validVariants[validVariants.length - 1].qualityScore.overall,
        max: best.qualityScore.overall,
      },
    },
  };
}
