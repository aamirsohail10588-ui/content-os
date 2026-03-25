// ============================================================
// MODULE: modules/evolutionEngine.ts
// PURPOSE: Self-improving content strategy — learn from results, evolve templates
// PHASE: 4
// STATUS: ACTIVE
// FLOW: decisions + performance → update weights → evolve hook/script templates →
//       store learned patterns → apply to next generation cycle
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('EvolutionEngine');

const MEMORY_PATH = path.join('/tmp', 'content-os', 'pattern-memory.json');
const LEARNING_RATE = 0.1;      // EMA weight for new observations
const MIN_DATA_POINTS = 3;      // Minimum before updating weights

// ─── INTERFACES ──────────────────────────────────────────────

export interface PatternMemoryState {
  hookWeights: Record<string, number>;
  topicScores: Record<string, TopicScore>;
  platformWeights: Record<string, number>;
  timingWeights: Record<string, number>;
  formatRules: FormatRule[];
}

export interface TopicScore {
  score: number;
  count: number;
  trend: 'new' | 'growing' | 'declining' | 'stable' | 'killed';
  history: number[];
}

export interface FormatRule {
  type: string;
  value: string | number;
  confidence: number;
  learnedAt: string;
  reason: string;
}

export interface WeightUpdate {
  key: string;
  newWeight: number;
  previousWeight: number;
}

export interface EvolutionConfig {
  preferredHookPatterns: Array<{ pattern: string; weight: number }>;
  avoidTopics: string[];
  preferredPlatforms: Array<{ platform: string; weight: number }>;
  formatRules: FormatRule[];
  generation: number;
}

export interface TopicEntry {
  topic: string;
  engagement: number;
  views: number;
}

export interface PerformanceData {
  duration?: number;
  engagement?: number;
  hasCTA?: boolean;
  views?: number;
  hookPattern?: string;
  platform?: string;
  retentionAvg?: number;
  topic?: string;
}

export interface EvolutionStats {
  generation: number;
  lastEvolved: string | null;
  hookPatterns: number;
  trackedTopics: number;
  platformsTracked: number;
  formatRules: number;
  evolutionCycles: number;
}

export interface EvolutionResult {
  generation: number;
  hookWeights: Record<string, number>;
  platformWeights: Record<string, number>;
  topTopics: Array<{ topic: string; score: number; trend: string }>;
  formatRules: FormatRule[];
  elapsed: number;
}

// ─── HELPERS ────────────────────────────────────────────────

function ema(current: number, newValue: number, rate: number): number {
  return current * (1 - rate) + newValue * rate;
}

function normalizeTo1(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) return weights;
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) result[k] = Math.round((v / total) * 1e4) / 1e4;
  return result;
}

function topicTrend(history: number[]): TopicScore['trend'] {
  if (history.length < 2) return 'new';
  const recent = history.slice(-3);
  const older = history.slice(-6, -3);
  if (older.length === 0) return 'new';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  if (recentAvg < 0.1) return 'killed';
  if (recentAvg > olderAvg * 1.15) return 'growing';
  if (recentAvg < olderAvg * 0.85) return 'declining';
  return 'stable';
}

// ─── PATTERN MEMORY ─────────────────────────────────────────

export class PatternMemory {
  hookWeights: Record<string, number> = {};
  topicScores: Record<string, TopicScore> = {};
  platformWeights: Record<string, number> = {};
  timingWeights: Record<string, number> = {};
  formatRules: FormatRule[] = [];
  generation: number = 0;
  lastEvolved: string | null = null;

  _load(): void {
    try {
      if (fs.existsSync(MEMORY_PATH)) {
        const raw = fs.readFileSync(MEMORY_PATH, 'utf8');
        const state: PatternMemoryState & { generation: number; lastEvolved: string | null } = JSON.parse(raw);
        this.hookWeights = state.hookWeights ?? {};
        this.topicScores = state.topicScores ?? {};
        this.platformWeights = state.platformWeights ?? {};
        this.timingWeights = state.timingWeights ?? {};
        this.formatRules = state.formatRules ?? [];
        const s = state as unknown as Record<string, unknown>;
        this.generation = s['generation'] as number ?? 0;
        this.lastEvolved = s['lastEvolved'] as string | null ?? null;
        log.info('PatternMemory loaded', { generation: this.generation, hooks: Object.keys(this.hookWeights).length });
      } else {
        this._initDefaults();
      }
    } catch {
      log.warn('PatternMemory load failed — using defaults');
      this._initDefaults();
    }
  }

  private _initDefaults(): void {
    // Equal starting weights for all hook patterns
    const defaultHooks = ['curiosity_gap', 'shocking_stat', 'direct_question', 'pattern_interrupt', 'bold_claim', 'story_open', 'contrarian'];
    for (const h of defaultHooks) this.hookWeights[h] = 1 / defaultHooks.length;
    const defaultPlatforms = ['youtube', 'instagram', 'tiktok'];
    for (const p of defaultPlatforms) this.platformWeights[p] = 1 / defaultPlatforms.length;
  }

  save(): void {
    try {
      const dir = path.dirname(MEMORY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const state = {
        hookWeights: this.hookWeights,
        topicScores: this.topicScores,
        platformWeights: this.platformWeights,
        timingWeights: this.timingWeights,
        formatRules: this.formatRules,
        generation: this.generation,
        lastEvolved: this.lastEvolved,
      };
      fs.writeFileSync(MEMORY_PATH, JSON.stringify(state, null, 2), 'utf8');
      log.info('PatternMemory saved', { generation: this.generation });
    } catch (err) {
      log.warn('PatternMemory save failed', { error: (err as Error).message });
    }
  }
}

// ─── EVOLUTION ENGINE ───────────────────────────────────────

export class EvolutionEngine {
  private memory: PatternMemory;
  private evolutionLog: Array<{ generation: number; timestamp: string; dataPoints: number; elapsed: number }> = [];

  constructor() {
    this.memory = new PatternMemory();
    this.memory._load();
    log.info('EvolutionEngine initialized', { generation: this.memory.generation });
  }

  evolve(performanceData: PerformanceData[], decisions: unknown[] = []): EvolutionResult {
    const start = Date.now();
    if (performanceData.length < MIN_DATA_POINTS) {
      log.warn('Insufficient data for evolution', { count: performanceData.length, min: MIN_DATA_POINTS });
    }

    // ── Update hook weights ───────────────────────────────────
    const hookBuckets: Record<string, number[]> = {};
    for (const d of performanceData) {
      if (d.hookPattern && d.engagement !== undefined) {
        if (!hookBuckets[d.hookPattern]) hookBuckets[d.hookPattern] = [];
        hookBuckets[d.hookPattern].push(d.engagement);
      }
    }
    for (const [pattern, scores] of Object.entries(hookBuckets)) {
      const avgEng = scores.reduce((a, b) => a + b, 0) / scores.length;
      const current = this.memory.hookWeights[pattern] ?? 0.14;
      this.memory.hookWeights[pattern] = ema(current, avgEng, LEARNING_RATE);
    }
    // Normalize so weights sum to ~1
    if (Object.keys(this.memory.hookWeights).length > 0) {
      this.memory.hookWeights = normalizeTo1(this.memory.hookWeights);
    }

    // ── Update platform weights ───────────────────────────────
    const platformBuckets: Record<string, number[]> = {};
    for (const d of performanceData) {
      if (d.platform && d.engagement !== undefined) {
        if (!platformBuckets[d.platform]) platformBuckets[d.platform] = [];
        platformBuckets[d.platform].push(d.engagement);
      }
    }
    for (const [platform, scores] of Object.entries(platformBuckets)) {
      const avgEng = scores.reduce((a, b) => a + b, 0) / scores.length;
      const current = this.memory.platformWeights[platform] ?? 0.33;
      this.memory.platformWeights[platform] = ema(current, avgEng, LEARNING_RATE);
    }
    if (Object.keys(this.memory.platformWeights).length > 0) {
      this.memory.platformWeights = normalizeTo1(this.memory.platformWeights);
    }

    // ── Update topic scores ───────────────────────────────────
    const topicBuckets: Record<string, number[]> = {};
    for (const d of performanceData) {
      if (d.topic && d.engagement !== undefined) {
        if (!topicBuckets[d.topic]) topicBuckets[d.topic] = [];
        topicBuckets[d.topic].push(d.engagement);
      }
    }
    for (const [topic, scores] of Object.entries(topicBuckets)) {
      const avgEng = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (!this.memory.topicScores[topic]) {
        this.memory.topicScores[topic] = { score: avgEng, count: scores.length, trend: 'new', history: [] };
      } else {
        const t = this.memory.topicScores[topic];
        t.score = ema(t.score, avgEng, LEARNING_RATE);
        t.count += scores.length;
        t.history.push(avgEng);
        if (t.history.length > 20) t.history = t.history.slice(-20);
        t.trend = topicTrend(t.history);
      }
    }

    // ── Update timing weights (video duration buckets) ────────
    const durationBuckets: Record<string, number[]> = { short: [], medium: [], long: [] };
    for (const d of performanceData) {
      if (d.duration !== undefined && d.retentionAvg !== undefined) {
        const bucket = d.duration <= 30 ? 'short' : d.duration <= 60 ? 'medium' : 'long';
        durationBuckets[bucket].push(d.retentionAvg);
      }
    }
    for (const [bucket, retentions] of Object.entries(durationBuckets)) {
      if (retentions.length === 0) continue;
      const avgRet = retentions.reduce((a, b) => a + b, 0) / retentions.length;
      const current = this.memory.timingWeights[bucket] ?? 0.33;
      this.memory.timingWeights[bucket] = ema(current, avgRet, LEARNING_RATE);
    }

    // ── Derive format rules ───────────────────────────────────
    this.memory.formatRules = [];

    // Best hook pattern rule
    const bestHook = Object.entries(this.memory.hookWeights).sort((a, b) => b[1] - a[1])[0];
    if (bestHook) {
      this.memory.formatRules.push({
        type: 'preferred_hook',
        value: bestHook[0],
        confidence: Math.min(1, bestHook[1] * 3),
        learnedAt: new Date().toISOString(),
        reason: `Highest engagement weight: ${(bestHook[1] * 100).toFixed(1)}%`,
      });
    }

    // Best duration rule
    const bestTiming = Object.entries(this.memory.timingWeights).sort((a, b) => b[1] - a[1])[0];
    if (bestTiming) {
      const durationMap: Record<string, number> = { short: 30, medium: 55, long: 90 };
      this.memory.formatRules.push({
        type: 'preferred_duration',
        value: durationMap[bestTiming[0]] ?? 55,
        confidence: Math.min(1, bestTiming[1] * 2),
        learnedAt: new Date().toISOString(),
        reason: `${bestTiming[0]} videos have highest avg retention: ${(bestTiming[1] * 100).toFixed(1)}%`,
      });
    }

    // CTA rule (if hasCTA data present)
    const withCTA = performanceData.filter(d => d.hasCTA === true);
    const withoutCTA = performanceData.filter(d => d.hasCTA === false);
    if (withCTA.length >= 3 && withoutCTA.length >= 3) {
      const ctaEng = withCTA.reduce((a, b) => a + (b.engagement ?? 0), 0) / withCTA.length;
      const noCTAEng = withoutCTA.reduce((a, b) => a + (b.engagement ?? 0), 0) / withoutCTA.length;
      this.memory.formatRules.push({
        type: 'cta_required',
        value: ctaEng > noCTAEng ? 'true' : 'false',
        confidence: Math.min(1, Math.abs(ctaEng - noCTAEng) * 5),
        learnedAt: new Date().toISOString(),
        reason: `CTA ${ctaEng > noCTAEng ? 'boosts' : 'hurts'} engagement by ${Math.abs(ctaEng - noCTAEng).toFixed(3)}`,
      });
    }

    // ── Finalize ──────────────────────────────────────────────
    this.memory.generation++;
    this.memory.lastEvolved = new Date().toISOString();
    this.memory.save();

    const elapsed = Date.now() - start;
    this.evolutionLog.push({ generation: this.memory.generation, timestamp: this.memory.lastEvolved, dataPoints: performanceData.length, elapsed });

    const topTopics = Object.entries(this.memory.topicScores)
      .filter(([, t]) => t.trend !== 'killed')
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5)
      .map(([topic, t]) => ({ topic, score: Math.round(t.score * 1e4) / 1e4, trend: t.trend }));

    const result: EvolutionResult = {
      generation: this.memory.generation,
      hookWeights: { ...this.memory.hookWeights },
      platformWeights: { ...this.memory.platformWeights },
      topTopics,
      formatRules: [...this.memory.formatRules],
      elapsed,
    };

    log.info('Evolution cycle complete', {
      generation: result.generation,
      dataPoints: performanceData.length,
      decisions: decisions.length,
      formatRules: result.formatRules.length,
      elapsed,
    });

    return result;
  }

  getRecommendedConfig(): EvolutionConfig {
    const sortedHooks = Object.entries(this.memory.hookWeights)
      .sort((a, b) => b[1] - a[1])
      .map(([pattern, weight]) => ({ pattern, weight }));

    const sortedPlatforms = Object.entries(this.memory.platformWeights)
      .sort((a, b) => b[1] - a[1])
      .map(([platform, weight]) => ({ platform, weight }));

    const avoidTopics = Object.entries(this.memory.topicScores)
      .filter(([, t]) => t.trend === 'killed' || (t.trend === 'declining' && t.score < 0.15))
      .map(([topic]) => topic);

    return {
      preferredHookPatterns: sortedHooks,
      avoidTopics,
      preferredPlatforms: sortedPlatforms,
      formatRules: [...this.memory.formatRules],
      generation: this.memory.generation,
    };
  }

  getStats(): EvolutionStats {
    return {
      generation: this.memory.generation,
      lastEvolved: this.memory.lastEvolved,
      hookPatterns: Object.keys(this.memory.hookWeights).length,
      trackedTopics: Object.keys(this.memory.topicScores).length,
      platformsTracked: Object.keys(this.memory.platformWeights).length,
      formatRules: this.memory.formatRules.length,
      evolutionCycles: this.evolutionLog.length,
    };
  }

  clean(): void {
    this.memory = new PatternMemory();
    this.memory._load();
    this.evolutionLog = [];
    log.info('EvolutionEngine reset to persisted memory');
  }
}
