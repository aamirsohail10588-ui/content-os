// ============================================================
// MODULE: modules/costController.ts
// PURPOSE: Budget tracking, per-API cost calculation, throttling
// PHASE: 2
// STATUS: ACTIVE
// NOTE: Tracks estimated costs per API call and per video
//       Enforces budget caps. Auto-throttles when budget tight.
// ============================================================

import { Logger, ContentConfig } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('CostController');

// ─── INTERFACES ─────────────────────────────────────────────

export interface TokenCostRate {
  inputTokenPer1k: number;
  outputTokenPer1k: number;
  name: string;
}

export interface CharacterCostRate {
  perCharacter: number;
  name: string;
}

export interface StorageCostRate {
  perGBMonth: number;
  name: string;
}

export interface ComputeCostRate {
  perMinute: number;
  name: string;
}

export type CostRate = TokenCostRate | CharacterCostRate | StorageCostRate | ComputeCostRate;

export interface CostRates {
  claude: TokenCostRate;
  openai: TokenCostRate;
  elevenlabs: CharacterCostRate;
  storage: StorageCostRate;
  compute: ComputeCostRate;
}

export interface BudgetConfig {
  dailyCapUSD: number;
  weeklyCapUSD: number;
  monthlyCapUSD: number;
  alertThresholdPercent: number;
  hardStopPercent: number;
}

export interface CostDetails {
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  sizeGB?: number;
  minutes?: number;
  estimatedCostUSD?: number;
}

export interface LedgerEntry {
  jobId: string;
  service: string;
  costUSD: number;
  details: CostDetails;
  timestamp: Date;
}

export interface VideoLedger {
  totalUSD: number;
  breakdown: LedgerEntry[];
}

export interface PeriodBudget {
  spent: number;
  cap: number;
  percentUsed: number;
  remaining: number;
}

export interface BudgetStatus {
  daily: PeriodBudget;
  weekly: PeriodBudget;
  monthly: PeriodBudget;
  canProceed: boolean;
  throttleLevel: 'none' | 'soft' | 'hard';
}

export interface CostEstimateBreakdown {
  ai: number;
  tts: number;
  storage: number;
  compute: number;
}

export interface CostEstimate {
  perVariant: {
    breakdown: CostEstimateBreakdown;
    total: number;
  };
  allVariants: {
    count: number;
    total: number;
  };
  currency: string;
}

export interface CostStats {
  totalCostUSD: number;
  totalVideos: number;
  avgCostPerVideoUSD: number;
  byService: Record<string, number>;
  budget: BudgetStatus;
  ledgerEntries: number;
}

type AlertCallback = (type: string, status: BudgetStatus) => void;

// ─── COST RATES (USD) ──────────────────────────────────────

export const COST_RATES: CostRates = {
  claude: {
    inputTokenPer1k: 0.003,
    outputTokenPer1k: 0.015,
    name: 'Claude API',
  },
  openai: {
    inputTokenPer1k: 0.005,
    outputTokenPer1k: 0.015,
    name: 'OpenAI API',
  },
  elevenlabs: {
    perCharacter: 0.00018,
    name: 'ElevenLabs TTS',
  },
  storage: {
    perGBMonth: 0.023,
    name: 'Cloud Storage',
  },
  compute: {
    perMinute: 0.001,
    name: 'Compute',
  },
};

// ─── BUDGET CONFIG ──────────────────────────────────────────

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyCapUSD: 10.00,
  weeklyCapUSD: 50.00,
  monthlyCapUSD: 150.00,
  alertThresholdPercent: 80,
  hardStopPercent: 100,
};

// ─── COST CONTROLLER ────────────────────────────────────────

export class CostController {
  private budget: BudgetConfig;
  private ledger: LedgerEntry[];
  private videoLedger: Record<string, VideoLedger>;
  private alertCallbacks: AlertCallback[];

  constructor(budget: BudgetConfig = DEFAULT_BUDGET) {
    this.budget = { ...budget };
    this.ledger = [];
    this.videoLedger = {};
    this.alertCallbacks = [];

    log.info('CostController initialized', {
      dailyCap: this.budget.dailyCapUSD,
      weeklyCap: this.budget.weeklyCapUSD,
      monthlyCap: this.budget.monthlyCapUSD,
    });
  }

  // ─── RECORD COST ─────────────────────────────────────────

  recordCost(jobId: string, service: string, details: CostDetails): LedgerEntry {
    let costUSD = 0;
    const rate = COST_RATES[service as keyof CostRates];

    if (!rate) {
      log.warn('Unknown service for cost tracking', { service });
      costUSD = details.estimatedCostUSD || 0;
    } else if (service === 'claude' || service === 'openai') {
      const tokenRate = rate as TokenCostRate;
      const inputCost = ((details.inputTokens || 0) / 1000) * tokenRate.inputTokenPer1k;
      const outputCost = ((details.outputTokens || 0) / 1000) * tokenRate.outputTokenPer1k;
      costUSD = inputCost + outputCost;
    } else if (service === 'elevenlabs') {
      costUSD = (details.characters || 0) * (rate as CharacterCostRate).perCharacter;
    } else if (service === 'storage') {
      costUSD = (details.sizeGB || 0) * (rate as StorageCostRate).perGBMonth;
    } else if (service === 'compute') {
      costUSD = (details.minutes || 0) * (rate as ComputeCostRate).perMinute;
    }

    const entry: LedgerEntry = {
      jobId,
      service,
      costUSD: Math.round(costUSD * 1000000) / 1000000,
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

  checkBudget(): BudgetStatus {
    const now = new Date();
    const daily = this._getCostForPeriod(this._startOfDay(now));
    const weekly = this._getCostForPeriod(this._startOfWeek(now));
    const monthly = this._getCostForPeriod(this._startOfMonth(now));

    const result: BudgetStatus = {
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
      throttleLevel: 'none',
    };

    const maxPercent = Math.max(
      result.daily.percentUsed,
      result.weekly.percentUsed,
      result.monthly.percentUsed
    );

    if (maxPercent >= this.budget.hardStopPercent) {
      result.canProceed = false;
      result.throttleLevel = 'hard';
    } else if (maxPercent >= this.budget.alertThresholdPercent) {
      result.throttleLevel = 'soft';
    }

    return result;
  }

  private _checkBudget(): void {
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

  estimateVideoCost(config: Partial<ContentConfig>): CostEstimate {
    const durationSeconds = config.targetDurationSeconds || 60;
    const variants = config.maxVariants || 1;

    const hookTokens = 500;
    const scriptTokens = 1500;
    const ttsCharacters = durationSeconds * 15;
    const storageGB = 0.05;
    const computeMinutes = 2;

    const perVariant: CostEstimateBreakdown = {
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

  getVideoCost(jobId: string): VideoLedger | null {
    return this.videoLedger[jobId] || null;
  }

  // ─── COST PER PERIOD ──────────────────────────────────────

  private _getCostForPeriod(since: Date): number {
    return this.ledger
      .filter((e: LedgerEntry) => e.timestamp >= since)
      .reduce((sum: number, e: LedgerEntry) => sum + e.costUSD, 0);
  }

  private _startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private _startOfWeek(date: Date): Date {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private _startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  // ─── ALERTING ─────────────────────────────────────────────

  onAlert(callback: AlertCallback): void {
    this.alertCallbacks.push(callback);
  }

  private _triggerAlert(type: string, status: BudgetStatus): void {
    for (const cb of this.alertCallbacks) {
      try { cb(type, status); } catch (e) { log.error('Alert callback error', { error: (e as Error).message }); }
    }
  }

  // ─── STATS ──────────────────────────────────────────────

  getStats(): CostStats {
    const budget = this.checkBudget();
    const videoCount = Object.keys(this.videoLedger).length;
    const totalCost = this.ledger.reduce((sum: number, e: LedgerEntry) => sum + e.costUSD, 0);
    const avgCostPerVideo = videoCount > 0 ? totalCost / videoCount : 0;

    const byService: Record<string, number> = {};
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

  clean(): void {
    this.ledger = [];
    this.videoLedger = {};
    log.info('CostController cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const costController = new CostController();
