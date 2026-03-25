// ============================================================
// MODULE: experimentEngine.js
// PURPOSE: Statistical A/B testing — confidence intervals, multi-armed bandit,
//          minimum sample thresholds, Thompson sampling
// PHASE: 4
// STATUS: ACTIVE
// NOTE: This is NOT just "which got more views" — it's statistically rigorous.
//       Minimum sample sizes, confidence intervals, exploration vs exploitation.
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('ExperimentEngine');

// ─── CONFIG ─────────────────────────────────────────────────

const EXPERIMENT_CONFIG = {
  minSampleSize: 30,            // minimum views per variant before declaring winner
  confidenceLevel: 0.95,        // 95% confidence
  maxDurationDays: 14,          // auto-conclude after 14 days
  explorationRate: 0.2,         // epsilon for epsilon-greedy (20% explore)
  bayesianPriorAlpha: 1,        // Beta distribution prior
  bayesianPriorBeta: 1,
};

// ─── EXPERIMENT STATUS ──────────────────────────────────────

const ExperimentStatus = {
  RUNNING: 'running',
  CONCLUDED: 'concluded',
  INSUFFICIENT_DATA: 'insufficient_data',
  EXPIRED: 'expired',
};

// ─── STATISTICS UTILITIES ───────────────────────────────────

// Normal approximation for Z-score
function zScore(confidence) {
  // Common Z-scores
  const table = { 0.90: 1.645, 0.95: 1.96, 0.99: 2.576 };
  return table[confidence] || 1.96;
}

// Confidence interval for a proportion
function proportionCI(successes, trials, confidence = 0.95) {
  if (trials === 0) return { lower: 0, upper: 0, mean: 0 };
  const p = successes / trials;
  const z = zScore(confidence);
  const se = Math.sqrt(p * (1 - p) / trials);
  return {
    lower: Math.max(0, Math.round((p - z * se) * 10000) / 10000),
    upper: Math.min(1, Math.round((p + z * se) * 10000) / 10000),
    mean: Math.round(p * 10000) / 10000,
  };
}

// Two-proportion Z-test (is A significantly better than B?)
function twoProportionZTest(successA, trialsA, successB, trialsB) {
  if (trialsA === 0 || trialsB === 0) return { zStat: 0, pValue: 1, significant: false };

  const pA = successA / trialsA;
  const pB = successB / trialsB;
  const pPool = (successA + successB) / (trialsA + trialsB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / trialsA + 1 / trialsB));

  if (se === 0) return { zStat: 0, pValue: 1, significant: false };

  const zStat = (pA - pB) / se;
  // Approximate p-value using normal distribution
  const pValue = Math.round(2 * (1 - normalCDF(Math.abs(zStat))) * 10000) / 10000;

  return {
    zStat: Math.round(zStat * 1000) / 1000,
    pValue,
    significant: pValue < (1 - EXPERIMENT_CONFIG.confidenceLevel),
  };
}

// Approximate CDF of standard normal distribution
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// Thompson Sampling — sample from Beta distribution
function betaSample(alpha, beta) {
  // Jöhnk's algorithm for Beta distribution
  function gammaSample(shape) {
    if (shape < 1) {
      return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = normalRandom();
        v = Math.pow(1 + c * x, 3);
      } while (v <= 0);
      const u = Math.random();
      if (u < 1 - 0.0331 * Math.pow(x, 4) || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v;
      }
    }
  }
  function normalRandom() {
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

// ─── EXPERIMENT ─────────────────────────────────────────────

class Experiment {
  constructor(id, name, variants) {
    this.id = id;
    this.name = name;
    this.variants = variants.map((v, i) => ({
      id: v.id || `variant_${i}`,
      label: v.label || `Variant ${String.fromCharCode(65 + i)}`,
      data: v.data || {},
      // Metrics
      impressions: 0,
      engagements: 0,      // likes + comments + shares
      conversions: 0,       // subscriber gains
      totalWatchPercent: 0,
      // Bayesian
      alphaParam: EXPERIMENT_CONFIG.bayesianPriorAlpha,
      betaParam: EXPERIMENT_CONFIG.bayesianPriorBeta,
    }));
    this.status = ExperimentStatus.RUNNING;
    this.createdAt = new Date().toISOString();
    this.concludedAt = null;
    this.winner = null;
    this.statisticalResult = null;
  }

  // Record an observation
  recordObservation(variantId, metrics) {
    const variant = this.variants.find(v => v.id === variantId);
    if (!variant) return;

    variant.impressions += metrics.views || 1;
    variant.engagements += (metrics.likes || 0) + (metrics.comments || 0) + (metrics.shares || 0);
    variant.conversions += metrics.subscribersGained || 0;
    variant.totalWatchPercent += metrics.avgWatchPercent || 0;

    // Update Bayesian params (engagement as "success")
    const engagementRate = variant.impressions > 0 ? variant.engagements / variant.impressions : 0;
    variant.alphaParam = EXPERIMENT_CONFIG.bayesianPriorAlpha + variant.engagements;
    variant.betaParam = EXPERIMENT_CONFIG.bayesianPriorBeta + (variant.impressions - variant.engagements);
  }

  // Select next variant to show (Thompson Sampling)
  selectVariant() {
    if (this.status !== ExperimentStatus.RUNNING) {
      return this.winner || this.variants[0];
    }

    // Epsilon-greedy exploration
    if (Math.random() < EXPERIMENT_CONFIG.explorationRate) {
      return this.variants[Math.floor(Math.random() * this.variants.length)];
    }

    // Thompson Sampling — sample from each variant's posterior and pick highest
    let bestSample = -1;
    let bestVariant = this.variants[0];
    for (const v of this.variants) {
      const sample = betaSample(v.alphaParam, v.betaParam);
      if (sample > bestSample) {
        bestSample = sample;
        bestVariant = v;
      }
    }
    return bestVariant;
  }

  // Check if experiment can be concluded
  evaluate() {
    // Check minimum sample size
    const allMeetMinimum = this.variants.every(v => v.impressions >= EXPERIMENT_CONFIG.minSampleSize);
    if (!allMeetMinimum) {
      return { status: ExperimentStatus.INSUFFICIENT_DATA, reason: 'Not enough data yet' };
    }

    // Check expiration
    const daysSinceCreation = (Date.now() - new Date(this.createdAt).getTime()) / 86400000;
    if (daysSinceCreation > EXPERIMENT_CONFIG.maxDurationDays) {
      this.status = ExperimentStatus.EXPIRED;
      this._conclude();
      return { status: ExperimentStatus.EXPIRED, reason: 'Max duration exceeded' };
    }

    // Run statistical test between all pairs
    if (this.variants.length === 2) {
      const a = this.variants[0];
      const b = this.variants[1];
      const test = twoProportionZTest(a.engagements, a.impressions, b.engagements, b.impressions);

      if (test.significant) {
        const engRateA = a.impressions > 0 ? a.engagements / a.impressions : 0;
        const engRateB = b.impressions > 0 ? b.engagements / b.impressions : 0;
        this.winner = engRateA > engRateB ? a : b;
        this.statisticalResult = test;
        this.status = ExperimentStatus.CONCLUDED;
        this._conclude();
        return { status: ExperimentStatus.CONCLUDED, winner: this.winner, test };
      }
    } else {
      // Multi-variant: find best by engagement rate
      const sorted = [...this.variants]
        .map(v => ({ ...v, engRate: v.impressions > 0 ? v.engagements / v.impressions : 0 }))
        .sort((a, b) => b.engRate - a.engRate);

      // Test best vs second best
      const best = sorted[0];
      const second = sorted[1];
      const test = twoProportionZTest(best.engagements, best.impressions, second.engagements, second.impressions);

      if (test.significant) {
        this.winner = this.variants.find(v => v.id === best.id);
        this.statisticalResult = test;
        this.status = ExperimentStatus.CONCLUDED;
        this._conclude();
        return { status: ExperimentStatus.CONCLUDED, winner: this.winner, test };
      }
    }

    return { status: ExperimentStatus.RUNNING, reason: 'No significant difference yet' };
  }

  _conclude() {
    this.concludedAt = new Date().toISOString();
    // Pick winner by engagement rate if not already set
    if (!this.winner) {
      this.winner = [...this.variants]
        .sort((a, b) => {
          const rateA = a.impressions > 0 ? a.engagements / a.impressions : 0;
          const rateB = b.impressions > 0 ? b.engagements / b.impressions : 0;
          return rateB - rateA;
        })[0];
    }
  }

  getReport() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      variants: this.variants.map(v => ({
        id: v.id,
        label: v.label,
        impressions: v.impressions,
        engagements: v.engagements,
        engagementRate: v.impressions > 0 ? Math.round((v.engagements / v.impressions) * 10000) / 100 + '%' : '0%',
        conversions: v.conversions,
        avgWatchPercent: v.impressions > 0 ? Math.round(v.totalWatchPercent / v.impressions) : 0,
        ci: proportionCI(v.engagements, v.impressions),
      })),
      winner: this.winner ? { id: this.winner.id, label: this.winner.label } : null,
      statisticalResult: this.statisticalResult,
      createdAt: this.createdAt,
      concludedAt: this.concludedAt,
    };
  }
}

// ─── EXPERIMENT ENGINE ──────────────────────────────────────

class ExperimentEngine {
  constructor() {
    this.experiments = new Map();
  }

  create(name, variants) {
    const id = `exp_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const experiment = new Experiment(id, name, variants);
    this.experiments.set(id, experiment);

    log.info('Experiment created', {
      id,
      name,
      variants: variants.length,
    });

    return experiment;
  }

  get(id) {
    return this.experiments.get(id) || null;
  }

  recordObservation(experimentId, variantId, metrics) {
    const exp = this.experiments.get(experimentId);
    if (!exp) return null;
    exp.recordObservation(variantId, metrics);
    return exp.evaluate();
  }

  selectVariant(experimentId) {
    const exp = this.experiments.get(experimentId);
    if (!exp) return null;
    return exp.selectVariant();
  }

  evaluateAll() {
    const results = {};
    for (const [id, exp] of this.experiments) {
      if (exp.status === ExperimentStatus.RUNNING) {
        results[id] = exp.evaluate();
      }
    }
    return results;
  }

  getReport(experimentId) {
    const exp = this.experiments.get(experimentId);
    return exp ? exp.getReport() : null;
  }

  getStats() {
    const all = Array.from(this.experiments.values());
    return {
      total: all.length,
      running: all.filter(e => e.status === ExperimentStatus.RUNNING).length,
      concluded: all.filter(e => e.status === ExperimentStatus.CONCLUDED).length,
      expired: all.filter(e => e.status === ExperimentStatus.EXPIRED).length,
    };
  }

  clean() {
    this.experiments.clear();
    log.info('ExperimentEngine cleaned');
  }
}

const experimentEngine = new ExperimentEngine();

module.exports = {
  ExperimentEngine,
  experimentEngine,
  Experiment,
  ExperimentStatus,
  EXPERIMENT_CONFIG,
  proportionCI,
  twoProportionZTest,
  betaSample,
};
