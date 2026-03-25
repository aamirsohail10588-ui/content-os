// ============================================================
// MODULE: modules/experimentEngine.ts
// PURPOSE: Statistical A/B testing — confidence intervals, multi-armed bandit,
//          minimum sample thresholds, Thompson sampling
// PHASE: 4
// STATUS: ACTIVE
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('ExperimentEngine');

// ─── ENUMS ──────────────────────────────────────────────────

export enum ExperimentStatus {
  RUNNING = 'running',
  CONCLUDED = 'concluded',
  INSUFFICIENT_DATA = 'insufficient_data',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

// ─── INTERFACES ──────────────────────────────────────────────

export interface ExperimentVariant {
  id: string;
  label: string;
  data: Record<string, unknown>;
  impressions: number;
  engagements: number;
  conversions: number;
  totalWatchPercent: number;
  alphaParam: number;
  betaParam: number;
}

export interface Observation {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subscribersGained?: number;
  avgWatchPercent?: number;
}

export interface StatisticalTest {
  zStat: number;
  pValue: number;
  significant: boolean;
}

export interface ProportionCI {
  lower: number;
  upper: number;
  mean: number;
}

export interface VariantReport {
  id: string;
  label: string;
  impressions: number;
  engagements: number;
  engagementRate: string;
  conversions: number;
  avgWatchPercent: number;
  ci: ProportionCI;
}

export interface ExperimentResult {
  status: ExperimentStatus;
  reason?: string;
  winner?: ExperimentVariant;
  test?: StatisticalTest;
}

export interface ExperimentReport {
  id: string;
  name: string;
  status: ExperimentStatus;
  variants: VariantReport[];
  winner: { id: string; label: string } | null;
  statisticalResult: StatisticalTest | null;
  createdAt: string;
  concludedAt: string | null;
}

export interface ExperimentConfig {
  minSampleSize: number;
  confidenceLevel: number;
  maxDurationDays: number;
  explorationRate: number;
  bayesianPriorAlpha: number;
  bayesianPriorBeta: number;
}

export interface ExperimentStats {
  total: number;
  running: number;
  concluded: number;
  expired: number;
}

// ─── STATISTICS UTILITIES ───────────────────────────────────

// Cumulative distribution function for standard normal (Abramowitz & Stegun)
export function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

// Critical z-value for a given two-tailed confidence level (binary search)
export function zScore(confidence: number): number {
  const target = 1 - (1 - confidence) / 2;
  let lo = 0;
  let hi = 5;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (normalCDF(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Wilson score confidence interval for a proportion
export function proportionCI(successes: number, trials: number, confidence = 0.95): ProportionCI {
  if (trials === 0) return { lower: 0, upper: 1, mean: 0 };
  const z = zScore(confidence);
  const p = successes / trials;
  const n = trials;
  const z2n = (z * z) / n;
  const center = (p + z2n / 2) / (1 + z2n);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2n / (4 * n))) / (1 + z2n);
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    mean: p,
  };
}

// Two-proportion z-test (pooled)
export function twoProportionZTest(
  successA: number,
  trialsA: number,
  successB: number,
  trialsB: number
): StatisticalTest {
  if (trialsA === 0 || trialsB === 0) return { zStat: 0, pValue: 1, significant: false };
  const pA = successA / trialsA;
  const pB = successB / trialsB;
  const pPool = (successA + successB) / (trialsA + trialsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return { zStat: 0, pValue: 1, significant: false };
  const zStat = (pA - pB) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(zStat)));
  return { zStat: Math.round(zStat * 1e4) / 1e4, pValue: Math.round(pValue * 1e4) / 1e4, significant: pValue < 0.05 };
}

// Box-Muller normal sample
function _normalSample(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
}

// Marsaglia-Tsang gamma sampler (shape alpha >= 1)
function _gammaSample(alpha: number): number {
  if (alpha < 1) {
    return _gammaSample(1 + alpha) * Math.pow(Math.random(), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = _normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Beta sample via ratio of gammas (Thompson sampling)
export function betaSample(alpha: number, beta: number): number {
  const a = _gammaSample(Math.max(alpha, 1e-9));
  const b = _gammaSample(Math.max(beta, 1e-9));
  const sum = a + b;
  return sum === 0 ? 0.5 : a / sum;
}

// ─── EXPERIMENT ─────────────────────────────────────────────

export interface ExperimentConstructorVariant {
  id?: string;
  label?: string;
  data?: Record<string, unknown>;
}

const DEFAULT_CONFIG: ExperimentConfig = {
  minSampleSize: 30,
  confidenceLevel: 0.95,
  maxDurationDays: 14,
  explorationRate: 0.1,
  bayesianPriorAlpha: 1,
  bayesianPriorBeta: 1,
};

export class Experiment {
  id: string;
  name: string;
  variants: ExperimentVariant[];
  status: ExperimentStatus;
  createdAt: string;
  concludedAt: string | null;
  winner: ExperimentVariant | null;
  statisticalResult: StatisticalTest | null;
  private readonly cfg: ExperimentConfig;

  constructor(id: string, name: string, variants: ExperimentConstructorVariant[]) {
    this.id = id;
    this.name = name;
    this.status = ExperimentStatus.RUNNING;
    this.createdAt = new Date().toISOString();
    this.concludedAt = null;
    this.winner = null;
    this.statisticalResult = null;
    this.cfg = { ...DEFAULT_CONFIG };
    this.variants = variants.map((v, i) => ({
      id: v.id ?? `variant_${i}`,
      label: v.label ?? `Variant ${String.fromCharCode(65 + i)}`,
      data: v.data ?? {},
      impressions: 0,
      engagements: 0,
      conversions: 0,
      totalWatchPercent: 0,
      alphaParam: this.cfg.bayesianPriorAlpha,
      betaParam: this.cfg.bayesianPriorBeta,
    }));
    log.info('Experiment created', { id, name, variants: this.variants.length });
  }

  recordObservation(variantId: string, metrics: Observation): void {
    const v = this.variants.find(x => x.id === variantId);
    if (!v) { log.warn('Variant not found', { variantId }); return; }
    const views = metrics.views ?? 0;
    const eng = (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0);
    v.impressions += views;
    v.engagements += eng;
    v.conversions += metrics.subscribersGained ?? 0;
    v.totalWatchPercent += metrics.avgWatchPercent ?? 0;
    // Update Beta distribution parameters
    if (views > 0) {
      v.alphaParam += eng;
      v.betaParam += Math.max(0, views - eng);
    }
  }

  // Thompson sampling: draw from each Beta posterior, pick highest
  selectVariant(): ExperimentVariant {
    if (this.variants.length === 0) throw new Error('No variants in experiment');
    let best = this.variants[0];
    let bestDraw = -Infinity;
    for (const v of this.variants) {
      const draw = betaSample(v.alphaParam, v.betaParam);
      if (draw > bestDraw) { bestDraw = draw; best = v; }
    }
    return best;
  }

  evaluate(): ExperimentResult {
    if (this.status === ExperimentStatus.CONCLUDED || this.status === ExperimentStatus.EXPIRED) {
      return { status: this.status, winner: this.winner ?? undefined, test: this.statisticalResult ?? undefined };
    }

    // Check expiry
    const ageDays = (Date.now() - new Date(this.createdAt).getTime()) / 86_400_000;
    if (ageDays > this.cfg.maxDurationDays) {
      this.status = ExperimentStatus.EXPIRED;
      log.warn('Experiment expired', { id: this.id, ageDays: ageDays.toFixed(1) });
      return { status: ExperimentStatus.EXPIRED, reason: `Expired after ${ageDays.toFixed(1)} days` };
    }

    // Minimum sample size gate
    const minSamples = this.variants.every(v => v.impressions >= this.cfg.minSampleSize);
    if (!minSamples) {
      const min = Math.min(...this.variants.map(v => v.impressions));
      return {
        status: ExperimentStatus.INSUFFICIENT_DATA,
        reason: `Min impressions per variant: ${this.cfg.minSampleSize} (current min: ${min})`,
      };
    }

    // Rank variants by engagement rate
    const ranked = [...this.variants].sort((a, b) => {
      const rA = a.impressions > 0 ? a.engagements / a.impressions : 0;
      const rB = b.impressions > 0 ? b.engagements / b.impressions : 0;
      return rB - rA;
    });

    const [top, second] = ranked;
    const test = twoProportionZTest(top.engagements, top.impressions, second.engagements, second.impressions);

    if (test.significant) {
      this.status = ExperimentStatus.CONCLUDED;
      this.winner = top;
      this.statisticalResult = test;
      this.concludedAt = new Date().toISOString();
      log.info('Experiment concluded', { id: this.id, winner: top.label, zStat: test.zStat, pValue: test.pValue });
      return { status: ExperimentStatus.CONCLUDED, winner: top, test };
    }

    return { status: ExperimentStatus.RUNNING, test };
  }

  getReport(): ExperimentReport {
    const variants: VariantReport[] = this.variants.map(v => ({
      id: v.id,
      label: v.label,
      impressions: v.impressions,
      engagements: v.engagements,
      engagementRate: v.impressions > 0 ? (v.engagements / v.impressions * 100).toFixed(2) + '%' : '0.00%',
      conversions: v.conversions,
      avgWatchPercent: v.impressions > 0 ? Math.round((v.totalWatchPercent / v.impressions) * 100) / 100 : 0,
      ci: proportionCI(v.engagements, v.impressions, this.cfg.confidenceLevel),
    }));
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      variants,
      winner: this.winner ? { id: this.winner.id, label: this.winner.label } : null,
      statisticalResult: this.statisticalResult,
      createdAt: this.createdAt,
      concludedAt: this.concludedAt,
    };
  }
}

// ─── EXPERIMENT ENGINE ──────────────────────────────────────

export class ExperimentEngine {
  private experiments: Map<string, Experiment>;

  constructor() {
    this.experiments = new Map();
    log.info('ExperimentEngine initialized');
  }

  create(name: string, variants: ExperimentConstructorVariant[]): Experiment {
    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const exp = new Experiment(id, name, variants);
    this.experiments.set(id, exp);
    log.info('Experiment registered', { id, name, variantCount: variants.length });
    return exp;
  }

  get(id: string): Experiment | null {
    return this.experiments.get(id) ?? null;
  }

  recordObservation(experimentId: string, variantId: string, metrics: Observation): ExperimentResult | null {
    const exp = this.experiments.get(experimentId);
    if (!exp) { log.warn('Experiment not found', { experimentId }); return null; }
    exp.recordObservation(variantId, metrics);
    return exp.evaluate();
  }

  selectVariant(experimentId: string): ExperimentVariant | null {
    const exp = this.experiments.get(experimentId);
    if (!exp || exp.status !== ExperimentStatus.RUNNING) return null;
    return exp.selectVariant();
  }

  evaluateAll(): Record<string, ExperimentResult> {
    const results: Record<string, ExperimentResult> = {};
    for (const [id, exp] of this.experiments) {
      results[id] = exp.evaluate();
    }
    log.info('Evaluated all experiments', { count: this.experiments.size });
    return results;
  }

  getReport(experimentId: string): ExperimentReport | null {
    const exp = this.experiments.get(experimentId);
    return exp ? exp.getReport() : null;
  }

  getStats(): ExperimentStats {
    let running = 0, concluded = 0, expired = 0;
    for (const exp of this.experiments.values()) {
      if (exp.status === ExperimentStatus.RUNNING || exp.status === ExperimentStatus.INSUFFICIENT_DATA) running++;
      else if (exp.status === ExperimentStatus.CONCLUDED) concluded++;
      else if (exp.status === ExperimentStatus.EXPIRED) expired++;
    }
    return { total: this.experiments.size, running, concluded, expired };
  }

  clean(): void {
    this.experiments.clear();
    log.info('ExperimentEngine cleared');
  }
}
