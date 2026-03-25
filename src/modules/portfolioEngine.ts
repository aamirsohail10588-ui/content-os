// ============================================================
// MODULE: modules/portfolioEngine.ts
// PURPOSE: Multi-account portfolio management — resource allocation,
//          ROI-based scaling, niche kill/scale, cross-account arbitrage
// PHASE: 4
// STATUS: ACTIVE
// MINDSET: Hedge fund thinking applied to content accounts.
//          Each account = asset. Optimize portfolio-level returns.
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('PortfolioEngine');

// ─── ENUMS ──────────────────────────────────────────────────

export enum AccountHealth {
  THRIVING = 'thriving',
  STABLE = 'stable',
  STRUGGLING = 'struggling',
  BLEEDING = 'bleeding',
  NEW = 'new',
}

export enum AllocationStrategy {
  AGGRESSIVE = 'aggressive',     // Winners take more — ROI-proportional
  BALANCED = 'balanced',         // Equal split
  CONSERVATIVE = 'conservative', // Stability-weighted — reduce variance
  GROWTH = 'growth',             // Invest in new/growing accounts
}

// ─── INTERFACES ──────────────────────────────────────────────

export interface AccountConfig {
  platform?: string;
  channelName?: string;
  niche?: string;
  subNiche?: string;
}

export interface AccountMetrics {
  videos?: number;
  revenue?: number;
  cost?: number;
  views?: number;
  engagement?: number;
}

export interface AccountState {
  id: string;
  platform: string;
  channelName: string;
  niche: string;
  subNiche: string;
  health: AccountHealth;
  totalVideos: number;
  totalRevenue: number;
  totalCost: number;
  profit: number;
  roi: number;
  avgEngagement: number;
  trend: string;
  budgetAllocation: number;
  videosPerWeek: number;
}

export interface AllocationResult {
  timestamp: string;
  strategy: AllocationStrategy;
  allocations: Array<{ id: string; allocation: number }>;
}

export interface PortfolioRecommendation {
  type: 'scale' | 'kill' | 'pivot' | 'expand';
  accountId?: string;
  action: string;
  params: Record<string, unknown>;
}

export interface PortfolioSummary {
  strategy: AllocationStrategy;
  accountCount: number;
  totalVideos: number;
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  portfolioROI: number;
  healthBreakdown: Record<AccountHealth, number>;
  accounts: AccountState[];
  recommendations: PortfolioRecommendation[];
}

export interface PortfolioStats {
  accountCount: number;
  totalRevenue: number;
  totalCost: number;
  portfolioROI: number;
}

// ─── ACCOUNT ─────────────────────────────────────────────────

export class Account {
  id: string;
  platform: string;
  channelName: string;
  niche: string;
  subNiche: string;
  createdAt: string;
  totalVideos: number;
  totalRevenue: number;
  totalCost: number;
  totalViews: number;
  avgEngagement: number;
  engagementHistory: number[];
  budgetAllocation: number;
  videosPerWeek: number;
  health: AccountHealth;
  lastPublishedAt: string | null;

  constructor(id: string, config: AccountConfig) {
    this.id = id;
    this.platform = config.platform ?? 'youtube';
    this.channelName = config.channelName ?? `channel_${id}`;
    this.niche = config.niche ?? 'general';
    this.subNiche = config.subNiche ?? '';
    this.createdAt = new Date().toISOString();
    this.totalVideos = 0;
    this.totalRevenue = 0;
    this.totalCost = 0;
    this.totalViews = 0;
    this.avgEngagement = 0;
    this.engagementHistory = [];
    this.budgetAllocation = 0;
    this.videosPerWeek = 3;
    this.health = AccountHealth.NEW;
    this.lastPublishedAt = null;
  }

  updateMetrics(metrics: AccountMetrics): void {
    if (metrics.videos !== undefined) this.totalVideos += metrics.videos;
    if (metrics.revenue !== undefined) this.totalRevenue += metrics.revenue;
    if (metrics.cost !== undefined) this.totalCost += metrics.cost;
    if (metrics.views !== undefined) this.totalViews += metrics.views;
    if (metrics.engagement !== undefined) {
      // Exponential moving average for engagement
      this.avgEngagement = this.engagementHistory.length === 0
        ? metrics.engagement
        : this.avgEngagement * 0.8 + metrics.engagement * 0.2;
      this.engagementHistory.push(metrics.engagement);
      if (this.engagementHistory.length > 30) this.engagementHistory = this.engagementHistory.slice(-30);
    }
    this.lastPublishedAt = new Date().toISOString();
    this.health = this.computeHealth();
  }

  computeHealth(): AccountHealth {
    if (this.totalVideos < 5) return AccountHealth.NEW;
    const roi = this.getROI();
    const eng = this.avgEngagement;
    if (roi >= 0.3 && eng >= 0.5) return AccountHealth.THRIVING;
    if (roi >= 0 && eng >= 0.25) return AccountHealth.STABLE;
    if (roi < -0.25 && this.totalVideos >= 10) return AccountHealth.BLEEDING;
    return AccountHealth.STRUGGLING;
  }

  getTrend(): string {
    const h = this.engagementHistory;
    if (h.length < 4) return 'insufficient_data';
    const recent = h.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const older = h.slice(-6, -3);
    if (older.length === 0) return 'new';
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    if (recent > olderAvg * 1.15) return 'growing';
    if (recent < olderAvg * 0.85) return 'declining';
    return 'stable';
  }

  getROI(): number {
    if (this.totalCost === 0) return 0;
    return (this.totalRevenue - this.totalCost) / this.totalCost;
  }

  getProfit(): number {
    return this.totalRevenue - this.totalCost;
  }

  getSummary(): AccountState {
    return {
      id: this.id,
      platform: this.platform,
      channelName: this.channelName,
      niche: this.niche,
      subNiche: this.subNiche,
      health: this.health,
      totalVideos: this.totalVideos,
      totalRevenue: Math.round(this.totalRevenue * 100) / 100,
      totalCost: Math.round(this.totalCost * 100) / 100,
      profit: Math.round(this.getProfit() * 100) / 100,
      roi: Math.round(this.getROI() * 1e4) / 1e4,
      avgEngagement: Math.round(this.avgEngagement * 1e4) / 1e4,
      trend: this.getTrend(),
      budgetAllocation: this.budgetAllocation,
      videosPerWeek: this.videosPerWeek,
    };
  }
}

// ─── PORTFOLIO ENGINE ───────────────────────────────────────

const DEFAULT_BUDGET_USD = 500;

export class PortfolioEngine {
  private accounts: Map<string, Account>;
  private strategy: AllocationStrategy;
  private totalBudgetUSD: number;
  private allocationHistory: AllocationResult[];

  constructor() {
    this.accounts = new Map();
    this.strategy = AllocationStrategy.BALANCED;
    this.totalBudgetUSD = DEFAULT_BUDGET_USD;
    this.allocationHistory = [];
    log.info('PortfolioEngine initialized', { strategy: this.strategy, budget: this.totalBudgetUSD });
  }

  addAccount(id: string, config: AccountConfig): Account {
    const account = new Account(id, config);
    this.accounts.set(id, account);
    this.reallocate();
    log.info('Account added', { id, platform: account.platform, niche: account.niche });
    return account;
  }

  removeAccount(id: string): void {
    if (!this.accounts.has(id)) { log.warn('Account not found for removal', { id }); return; }
    this.accounts.delete(id);
    this.reallocate();
    log.info('Account removed', { id });
  }

  getAccount(id: string): Account | null {
    return this.accounts.get(id) ?? null;
  }

  updateAccountMetrics(id: string, metrics: AccountMetrics): AccountState | null {
    const account = this.accounts.get(id);
    if (!account) { log.warn('Account not found', { id }); return null; }
    account.updateMetrics(metrics);
    log.info('Account metrics updated', { id, health: account.health, roi: account.getROI().toFixed(3) });
    return account.getSummary();
  }

  setStrategy(strategy: AllocationStrategy): void {
    this.strategy = strategy;
    this.reallocate();
    log.info('Strategy updated', { strategy });
  }

  reallocate(): void {
    if (this.accounts.size === 0) return;
    const accounts = [...this.accounts.values()];
    const allocations: Array<{ id: string; allocation: number }> = [];
    let weights: Record<string, number> = {};

    switch (this.strategy) {
      case AllocationStrategy.BALANCED: {
        // Equal split
        const share = 1 / accounts.length;
        for (const a of accounts) weights[a.id] = share;
        break;
      }
      case AllocationStrategy.AGGRESSIVE: {
        // ROI-proportional: winners take more, losers get minimum floor
        const floor = 0.05;
        const baseWeights: Record<string, number> = {};
        let positiveSum = 0;
        for (const a of accounts) {
          const roi = Math.max(0, a.getROI());
          baseWeights[a.id] = roi;
          positiveSum += roi;
        }
        if (positiveSum === 0) {
          // No positive ROI yet — equal split
          for (const a of accounts) weights[a.id] = 1 / accounts.length;
        } else {
          const floorTotal = floor * accounts.length;
          const scalable = 1 - floorTotal;
          for (const a of accounts) {
            weights[a.id] = floor + scalable * (baseWeights[a.id] / positiveSum);
          }
        }
        break;
      }
      case AllocationStrategy.CONSERVATIVE: {
        // Stability-weighted: more to accounts with consistent (low-variance) engagement
        for (const a of accounts) {
          const h = a.engagementHistory;
          if (h.length < 2) { weights[a.id] = 1; continue; }
          const mean = h.reduce((s, v) => s + v, 0) / h.length;
          const variance = h.reduce((s, v) => s + (v - mean) ** 2, 0) / h.length;
          weights[a.id] = 1 / (variance + 0.01); // inverse variance
        }
        // Normalize
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        for (const k of Object.keys(weights)) weights[k] /= total;
        break;
      }
      case AllocationStrategy.GROWTH: {
        // Invest in NEW and GROWING accounts
        for (const a of accounts) {
          const trend = a.getTrend();
          if (a.health === AccountHealth.NEW) weights[a.id] = 3;
          else if (trend === 'growing') weights[a.id] = 2;
          else if (a.health === AccountHealth.BLEEDING) weights[a.id] = 0.1;
          else weights[a.id] = 1;
        }
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        for (const k of Object.keys(weights)) weights[k] /= total;
        break;
      }
    }

    for (const account of accounts) {
      const alloc = Math.round((weights[account.id] ?? (1 / accounts.length)) * this.totalBudgetUSD * 100) / 100;
      account.budgetAllocation = alloc;
      account.videosPerWeek = Math.max(1, Math.round(alloc / 20)); // ~$20/video
      allocations.push({ id: account.id, allocation: alloc });
    }

    const result: AllocationResult = {
      timestamp: new Date().toISOString(),
      strategy: this.strategy,
      allocations,
    };
    this.allocationHistory.push(result);
    if (this.allocationHistory.length > 100) this.allocationHistory = this.allocationHistory.slice(-100);

    log.info('Budget reallocated', { strategy: this.strategy, accounts: accounts.length, totalBudget: this.totalBudgetUSD });
  }

  getRecommendations(): PortfolioRecommendation[] {
    const recs: PortfolioRecommendation[] = [];

    for (const account of this.accounts.values()) {
      const summary = account.getSummary();

      if (account.health === AccountHealth.THRIVING) {
        recs.push({
          type: 'scale',
          accountId: account.id,
          action: `Scale ${account.channelName} — ROI ${(summary.roi * 100).toFixed(1)}%, engagement ${(summary.avgEngagement * 100).toFixed(1)}%`,
          params: { roi: summary.roi, engagement: summary.avgEngagement, suggestedVideosPerWeek: account.videosPerWeek * 2 },
        });
      }

      if (account.health === AccountHealth.BLEEDING && account.totalVideos >= 10) {
        recs.push({
          type: 'kill',
          accountId: account.id,
          action: `Kill ${account.channelName} — losing money (ROI: ${(summary.roi * 100).toFixed(1)}%)`,
          params: { roi: summary.roi, totalLoss: summary.profit, videosProduced: account.totalVideos },
        });
      }

      if (account.health === AccountHealth.STRUGGLING && account.totalVideos >= 5) {
        recs.push({
          type: 'pivot',
          accountId: account.id,
          action: `Pivot ${account.channelName} niche — engagement ${(summary.avgEngagement * 100).toFixed(1)}% not improving`,
          params: { currentNiche: account.niche, trend: summary.trend, avgEngagement: summary.avgEngagement },
        });
      }
    }

    // Cross-account arbitrage: if one niche thriving, suggest expand to similar
    const thriving = [...this.accounts.values()].filter(a => a.health === AccountHealth.THRIVING);
    for (const a of thriving) {
      const similar = [...this.accounts.values()].filter(
        b => b.id !== a.id && b.niche !== a.niche && b.health !== AccountHealth.THRIVING
      );
      if (similar.length > 0) {
        recs.push({
          type: 'expand',
          action: `Expand successful "${a.niche}" niche playbook to underperforming accounts`,
          params: { sourceAccount: a.id, niche: a.niche, targetAccounts: similar.map(b => b.id) },
        });
      }
    }

    return recs;
  }

  getPortfolioSummary(): PortfolioSummary {
    const accounts = [...this.accounts.values()];
    const totalVideos = accounts.reduce((s, a) => s + a.totalVideos, 0);
    const totalRevenue = accounts.reduce((s, a) => s + a.totalRevenue, 0);
    const totalCost = accounts.reduce((s, a) => s + a.totalCost, 0);
    const totalProfit = totalRevenue - totalCost;
    const portfolioROI = totalCost > 0 ? (totalRevenue - totalCost) / totalCost : 0;

    const healthBreakdown: Record<AccountHealth, number> = {
      [AccountHealth.THRIVING]: 0,
      [AccountHealth.STABLE]: 0,
      [AccountHealth.STRUGGLING]: 0,
      [AccountHealth.BLEEDING]: 0,
      [AccountHealth.NEW]: 0,
    };
    for (const a of accounts) healthBreakdown[a.health]++;

    return {
      strategy: this.strategy,
      accountCount: accounts.length,
      totalVideos,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      portfolioROI: Math.round(portfolioROI * 1e4) / 1e4,
      healthBreakdown,
      accounts: accounts.map(a => a.getSummary()),
      recommendations: this.getRecommendations(),
    };
  }

  getStats(): PortfolioStats {
    const accounts = [...this.accounts.values()];
    const totalRevenue = accounts.reduce((s, a) => s + a.totalRevenue, 0);
    const totalCost = accounts.reduce((s, a) => s + a.totalCost, 0);
    return {
      accountCount: accounts.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      portfolioROI: totalCost > 0 ? Math.round(((totalRevenue - totalCost) / totalCost) * 1e4) / 1e4 : 0,
    };
  }

  clean(): void {
    this.accounts.clear();
    this.allocationHistory = [];
    log.info('PortfolioEngine cleared');
  }
}
