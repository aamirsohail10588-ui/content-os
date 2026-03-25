// ============================================================
// MODULE: modules/hookEngine.ts
// PURPOSE: Generate high-retention hooks for short-form video
// PHASE: 1
// STATUS: ACTIVE
// DEPENDENCIES: types, config, mocks/mockAiProvider, infra/logger
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import {
  Hook,
  HookPattern,
  HookGenerationRequest,
  HookGenerationResult,
  PipelineError,
  PipelineStage,
} from '../types';
import { HOOK_CONFIG, SYSTEM_CONFIG } from '../config';
import { getMockHooks } from '../mocks/mockAiProvider';
import { callClaudeWithFallback } from '../infra/aiClient';
import { createLogger } from '../infra/logger';

const log = createLogger('HookEngine');

// ─── PATTERN WEIGHTS (learned over time, hardcoded for Phase 1) ──

const PATTERN_WEIGHTS: Record<HookPattern, number> = {
  [HookPattern.CURIOSITY_GAP]: 0.25,
  [HookPattern.SHOCKING_STAT]: 0.20,
  [HookPattern.BOLD_CLAIM]: 0.15,
  [HookPattern.CONTRARIAN]: 0.15,
  [HookPattern.STORY_OPEN]: 0.10,
  [HookPattern.DIRECT_QUESTION]: 0.10,
  [HookPattern.PATTERN_INTERRUPT]: 0.05,
};

// ─── HOOK SCORING ───────────────────────────────────────────

function scoreHook(text: string, pattern: HookPattern): number {
  let score = 50; // baseline

  // Length scoring: 8-15 words is optimal for hooks
  const wordCount = text.split(/\s+/).length;
  if (wordCount >= 8 && wordCount <= 15) score += 15;
  else if (wordCount >= 5 && wordCount <= 20) score += 8;
  else score -= 10;

  // Pattern-specific bonuses
  if (pattern === HookPattern.CURIOSITY_GAP && text.includes('...')) score += 5;
  if (pattern === HookPattern.SHOCKING_STAT && /\d+%/.test(text)) score += 10;
  if (pattern === HookPattern.DIRECT_QUESTION && text.endsWith('?')) score += 5;
  if (pattern === HookPattern.PATTERN_INTERRUPT && text.includes('Stop')) score += 5;
  if (pattern === HookPattern.CONTRARIAN) score += 5; // contrarian hooks always perform

  // Emotional trigger words
  const emotionalTriggers = ['never', 'always', 'secret', 'truth', 'mistake', 'lie', 'nobody', 'everyone'];
  const triggerCount = emotionalTriggers.filter(t => text.toLowerCase().includes(t)).length;
  score += triggerCount * 3;

  // Specificity bonus (numbers, dollar amounts)
  if (/\$[\d,]+/.test(text)) score += 8;
  if (/\d+/.test(text)) score += 4;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

// ─── FINGERPRINT GENERATION ─────────────────────────────────

function generateFingerprint(text: string, pattern: HookPattern): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  return crypto.createHash('sha256').update(`${pattern}:${normalized}`).digest('hex').slice(0, 16);
}

// ─── ESTIMATE DURATION ──────────────────────────────────────

function estimateDuration(text: string): number {
  const wordCount = text.split(/\s+/).length;
  // Average speaking rate: ~2.5 words/second for hooks (slightly slower, dramatic pacing)
  return Math.round((wordCount / 2.2) * 10) / 10;
}

// ─── SELECT PATTERNS ────────────────────────────────────────

function selectPatterns(count: number, exclude: HookPattern[] = []): HookPattern[] {
  const available = Object.entries(PATTERN_WEIGHTS)
    .filter(([pattern]) => !exclude.includes(pattern as HookPattern))
    .map(([pattern, weight]) => ({ pattern: pattern as HookPattern, weight }));

  // Weighted random selection without replacement
  const selected: HookPattern[] = [];
  const pool = [...available];

  for (let i = 0; i < count && pool.length > 0; i++) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;

    for (let j = 0; j < pool.length; j++) {
      random -= pool[j].weight;
      if (random <= 0) {
        selected.push(pool[j].pattern);
        pool.splice(j, 1);
        break;
      }
    }
  }

  return selected;
}

// ─── MAIN: GENERATE HOOKS ───────────────────────────────────

export async function generateHooks(request: HookGenerationRequest): Promise<HookGenerationResult> {
  const startTime = Date.now();
  const language = request.voiceLanguage || 'english';
  log.info('Starting hook generation', {
    topic: request.topic,
    niche: request.niche,
    variantCount: request.variantCount,
    language,
  });

  const patterns = selectPatterns(request.variantCount, request.excludePatterns);
  const hooks: Hook[] = [];
  let totalTokens = 0;

  for (const pattern of patterns) {
    try {
      let hookText: string;

      const isIndian = language === 'hinglish' || language === 'hindi';
      const response = await callClaudeWithFallback(
        {
          systemPrompt: isIndian ? buildHinglishHookSystemPrompt() : buildSystemPrompt(request.niche, request.tone),
          prompt: buildHookPrompt(request.topic, pattern, request.targetDurationSeconds),
          maxTokens: 150,
          temperature: 0.85,
        },
        () => {
          if (isIndian) return `Yaar, ${request.topic} — sach mein shocking hai.`;
          const mockHooks = getMockHooks(pattern, 1);
          return mockHooks[0] || `${request.topic} — this changes everything.`;
        }
      );
      hookText = response.content.trim().replace(/^["']|["']$/g, ''); // strip quotes if AI added them
      totalTokens += response.tokensUsed;

      const strengthScore = scoreHook(hookText, pattern);

      // Filter out weak hooks
      if (strengthScore < HOOK_CONFIG.minStrengthScore) {
        log.warn('Hook below minimum strength, discarding', {
          pattern,
          score: strengthScore,
          threshold: HOOK_CONFIG.minStrengthScore,
        });
        continue;
      }

      const hook: Hook = {
        id: uuidv4(),
        text: hookText,
        pattern,
        estimatedDurationSeconds: estimateDuration(hookText),
        strengthScore,
        topic: request.topic,
        fingerprint: generateFingerprint(hookText, pattern),
      };

      hooks.push(hook);
      log.info('Hook generated', {
        pattern,
        score: strengthScore,
        duration: hook.estimatedDurationSeconds,
      });
    } catch (err) {
      const error = err as Error;
      log.error('Hook generation failed for pattern', {
        pattern,
        error: error.message,
      });
      // Continue — don't let one pattern failure kill the batch
    }
  }

  if (hooks.length === 0) {
    const pipelineError: PipelineError = {
      stage: PipelineStage.HOOK_GENERATION,
      code: 'NO_HOOKS_GENERATED',
      message: 'All hook generation attempts failed or scored below threshold',
      retryable: true,
      timestamp: new Date(),
    };
    throw pipelineError;
  }

  // Sort by strength score descending
  hooks.sort((a, b) => b.strengthScore - a.strengthScore);

  const generationTimeMs = Date.now() - startTime;

  log.info('Hook generation complete', {
    hooksGenerated: hooks.length,
    bestScore: hooks[0].strengthScore,
    timeMs: generationTimeMs,
  });

  return {
    hooks,
    generationTimeMs,
    tokensUsed: totalTokens,
    provider: SYSTEM_CONFIG.useMocks ? 'mock' : 'claude',
  };
}

// ─── PROMPT BUILDERS ────────────────────────────────────────

function buildSystemPrompt(niche: string, tone: string): string {
  return `You are an expert short-form video hook writer specializing in ${niche} content.
Your tone is ${tone}.
You write hooks that stop the scroll in the first 2-3 seconds.
Every hook must create an immediate emotional reaction: curiosity, shock, or urgency.
Never use generic phrases. Be specific. Use numbers and data where possible.
Output ONLY the hook text, nothing else.`;
}

function buildHinglishHookSystemPrompt(): string {
  return `You are a viral Indian content creator. Write ONE hook line in Hinglish (Hindi + English mix).

RULES:
- Max 12 words total
- Must be SPECIFIC to the given topic — mention real names, real numbers
- Mix Hindi and English naturally: "Yaar, Trump ne India ka market duba diya"
- Create instant SHOCK or burning CURIOSITY
- Address viewer: "Yaar" / "Bhai" / "Dosto" / "Suno"
- Use real numbers if topic has them

BAD (generic): "India mein 90% log yeh galti karte hain"
GOOD (specific): "Yaar, Trump ke ek tweet se Sensex 2000 points gir gaya"

Output ONLY the hook text. No quotes. No explanation.`;
}

function buildHookPrompt(topic: string, pattern: HookPattern, maxDuration: number): string {
  const maxWords = Math.floor(maxDuration * 2.5);

  const patternInstructions: Record<HookPattern, string> = {
    [HookPattern.CURIOSITY_GAP]: 'Create an open loop that the viewer MUST close. Hint at valuable information without revealing it.',
    [HookPattern.SHOCKING_STAT]: 'Lead with a specific, surprising statistic that challenges common assumptions.',
    [HookPattern.DIRECT_QUESTION]: 'Ask a question that makes the viewer immediately reflect on their own situation.',
    [HookPattern.PATTERN_INTERRUPT]: 'Use a command or unexpected statement that breaks the viewer\'s scrolling pattern.',
    [HookPattern.BOLD_CLAIM]: 'Make a provocative but defensible claim that challenges conventional wisdom.',
    [HookPattern.STORY_OPEN]: 'Start a personal or relatable story that immediately hooks with stakes or outcome.',
    [HookPattern.CONTRARIAN]: 'Take the opposite position of common advice. Be specific about what\'s wrong with the mainstream view.',
  };

  return `Topic: ${topic}
Pattern: ${pattern}
Instruction: ${patternInstructions[pattern]}
Max words: ${maxWords}
Write one hook. Output only the hook text.`;
}

// ─── EXPORT: SELECT BEST HOOK ───────────────────────────────

export function selectBestHook(hooks: Hook[]): Hook {
  if (hooks.length === 0) {
    throw new Error('No hooks to select from');
  }
  // Already sorted by score in generateHooks, but defensive re-sort
  return [...hooks].sort((a, b) => b.strengthScore - a.strengthScore)[0];
}
