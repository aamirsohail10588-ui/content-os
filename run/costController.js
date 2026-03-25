// ============================================================
// MODULE: costController.js
// PURPOSE: Budget tracking, per-API cost calculation, throttling
// PHASE: 2
// STATUS: ACTIVE
// NOTE: Tracks estimated costs per API call and per video
//       Enforces budget caps. Auto-throttles when budget tight.
// ============================================================

const { createLogger } = require('./logger');

const log = createLogger('CostController');

// ─── COST RATES (USD) ──────────────────────────────────────

const COST_RATES = {
  claude: {
    inputTokenPer1k: 0.003,   // Claude Sonnet input
    outputTokenPer1k: 0.015,  // Claude Sonnet output
    name: 'Claude API',
  },
  openai: {
    inputTokenPer1k: 0.005,   // GPT-4o input
    outputTokenPer1k: 0.015,  // GPT-4o output
    name: 'OpenAI API',
  },
  elevenlabs: {
    perCharacter: 0.00018,    // ElevenLabs per character
    name: 'ElevenLabs TTS',
  },
  storage: {
    perGBMonth: 0.023,        // S3 standard
    name: 'Cloud Storage',
  },
  compute: {
    perMinute: 0.001,         // Video processing compute
    name: 'Compute',
  },
};

// ─── BUDGET CONFIG ──────────────────────────────────────────

const DEFAULT_BUDGET = {
  dailyCapUSD: 10.00,
  weeklyCapUSD: 50.00,
  monthlyCapUSD: 150.00,
  alertThresholdPercent: 80,  // alert at 80% of cap
  hardStopPercent: 100,       // block at 100%
};

// ─── COST CONTROLLER ────────────────────────────────────────

class CostController {
  constructor(budget = DEFAULT_BUDGET) {
    this.budget = { ...budget };
    this.ledger = [];       // all cost entries
    this.videoLedger = {};  // jobId → cost breakdown
    this.alertCallbacks = [];

    log.info('CostController initialized', {
      dailyCap: this.budget.dailyCapUSD,
      weeklyCap: this.budget.weeklyCapUSD,
      monthlyCap: this.budget.monthlyCapUSD,
    });
  }

  // ─── RECORD COST ─────────────────────────────────────────

  recordCost(jobId, service, details) {
    let costUSD = 0;
    const rate = COST_RATES[service];

    if (!rate) {
      log.warn('Unknown service for cost tracking', { service });
      costUSD = details.estimatedCostUSD || 0;
    } else if (service === 'claude' || service === 'openai') {
      const inputCost = ((details.inputTokens || 0) / 1000) * rate.inputTokenPer1k;
      const outputCost = ((details.outputTokens || 0) / 1000) * rate.outputTokenPer1k;
      costUSD = inputCost + outputCost;
    } else if (service === 'elevenlabs') {
      costUSD = (details.characters || 0) * rate.perCharacter;
    } else if (service === 'storage') {
      costUSD = (details.sizeGB || 0) * rate.perGBMonth;
    } else if (service === 'compute') {
      costUSD = (details.minutes || 0) * rate.perMinute;
    }

    const entry = {
      jobId,
      service,
      costUSD: Math.round(costUSD * 1000000) / 1000000, // 6 decimal precision
      details,
      timestamp: new Date(),
    };

    this.ledger.push(entry);

    // Track per-video costs
    if (!this.videoLedger[jobId]) {
      this.videoLedger[jobId] = { totalUSD: 0, breakdown: [] };
    }
    this.videoLedger[jobId].totalUSD += entry.costUSD;
    this.videoLedger[jobId].breakdown.push(entry);

    log.info('Cost recorded', {
      jobId,
      service: rate?.name || service,
      costUSD: entry.costUSD,
      videoTotal: this.videoLedger[jobId].totalUSD,
    });

    // Check budget alerts
    this._checkBudget();

    return entry;
  }

  // ─── CHECK BUDGET ─────────────────────────────────────────

  checkBudget() {
    const now = new Date();
    const daily = this._getCostForPeriod(this._startOfDay(now));
    const weekly = this._getCostForPeriod(this._startOfWeek(now));
    const monthly = this._getCostForPeriod(this._startOfMonth(now));

    const result = {
      daily: {
        spent: Math.round(daily * 100) / 100,
        cap: this.budget.dailyCapUSD,
        percentUsed: Math.round((daily / this.budget.dailyCapUSD) * 100),
        remaining: Math.round((this.budget.dailyCapUSD - daily) * 100) / 100,
      },
      weekly: {
        spent: Math.round(weekly * 100) / 100,
        cap: this.budget.weeklyCapUSD,
        percentUsed: Math.round((weekly / this.budget.weeklyCapUSD) * 100),
        remaining: Math.round((this.budget.weeklyCapUSD - weekly) * 100) / 100,
      },
      monthly: {
        spent: Math.round(monthly * 100) / 100,
        cap: this.budget.monthlyCapUSD,
        percentUsed: Math.round((monthly / this.budget.monthlyCapUSD) * 100),
        remaining: Math.round((this.budget.monthlyCapUSD - monthly) * 100) / 100,
      },
      canProceed: true,
      throttleLevel: 'none', // none, soft, hard
    };

    // Determine throttle level
    const maxPercent = Math.max(result.daily.percentUsed, result.weekly.percentUsed, result.monthly.percentUsed);

    if (maxPercent >= this.budget.hardStopPercent) {
      result.canProceed = false;
      result.throttleLevel = 'hard';
    } else if (maxPercent >= this.budget.alertThresholdPercent) {
      result.throttleLevel = 'soft';
    }

    return result;
  }

  _checkBudget() {
    const status = this.checkBudget();

    if (status.throttleLevel === 'hard') {
      log.error('BUDGET HARD STOP: Cap exceeded', {
        daily: status.daily.percentUsed + '%',
        weekly: status.weekly.percentUsed + '%',
        monthly: status.monthly.percentUsed + '%',
      });
      this._triggerAlert('hard_stop', status);
    } else if (status.throttleLevel === 'soft') {
      log.warn('BUDGET WARNING: Approaching cap', {
        daily: status.daily.percentUsed + '%',
        weekly: status.weekly.percentUsed + '%',
        monthly: status.monthly.percentUsed + '%',
      });
      this._triggerAlert('warning', status);
    }
  }

  // ─── ESTIMATE VIDEO COST ──────────────────────────────────

  estimateVideoCost(config) {
    const durationSeconds = config.targetDurationSeconds || 60;
    const variants = config.maxVariants || 1;

    // Estimate per variant
    const hookTokens = 500;       // ~500 tokens for hook generation
    const scriptTokens = 1500;    // ~1500 tokens for script
    const ttsCharacters = durationSeconds * 15; // ~15 chars/second speaking
    const storageGB = 0.05;       // ~50MB per video
    const computeMinutes = 2;     // ~2 min processing

    const perVariant = {
      ai: ((hookTokens + scriptTokens) / 1000) * (COST_RATES.claude.inputTokenPer1k + COST_RATES.claude.outputTokenPer1k),
      tts: ttsCharacters * COST_RATES.elevenlabs.perCharacter,
      storage: storageGB * COST_RATES.storage.perGBMonth,
      compute: computeMinutes * COST_RATES.compute.perMinute,
    };

    const totalPerVariant = Object.values(perVariant).reduce((sum, v) => sum + v, 0);
    const totalAllVariants = totalPerVariant * variants;

    return {
      perVariant: {
        breakdown: perVariant,
        total: Math.round(totalPerVariant * 10000) / 10000,
      },
      allVariants: {
        count: variants,
        total: Math.round(totalAllVariants * 10000) / 10000,
      },
      currency: 'USD',
    };
  }

  // ─── GET VIDEO COST ───────────────────────────────────────

  getVideoCost(jobId) {
    return this.videoLedger[jobId] || null;
  }

  // ─── COST PER PERIOD ──────────────────────────────────────

  _getCostForPeriod(since) {
    return this.ledger
      .filter(e => e.timestamp >= since)
      .reduce((sum, e) => sum + e.costUSD, 0);
  }

  _startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  _startOfWeek(date) {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  _startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  // ─── ALERTING ─────────────────────────────────────────────

  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  _triggerAlert(type, status) {
    for (const cb of this.alertCallbacks) {
      try { cb(type, status); } catch (e) { log.error('Alert callback error', { error: e.message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats() {
    const budget = this.checkBudget();
    const videoCount = Object.keys(this.videoLedger).length;
    const totalCost = this.ledger.reduce((sum, e) => sum + e.costUSD, 0);
    const avgCostPerVideo = videoCount > 0 ? totalCost / videoCount : 0;

    // Cost by service
    const byService = {};
    for (const entry of this.ledger) {
      byService[entry.service] = (byService[entry.service] || 0) + entry.costUSD;
    }

    return {
      totalCostUSD: Math.round(totalCost * 100) / 100,
      totalVideos: videoCount,
      avgCostPerVideoUSD: Math.round(avgCostPerVideo * 10000) / 10000,
      byService,
      budget,
      ledgerEntries: this.ledger.length,
    };
  }

  // ─── CLEAN ──────────────────────────────────────────────

  clean() {
    this.ledger = [];
    this.videoLedger = {};
    log.info('CostController cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const costController = new CostController();

module.exports = { CostController, costController, COST_RATES, DEFAULT_BUDGET };
