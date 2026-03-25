// ============================================================
// MODULE: portfolioEngine.js
// PURPOSE: Multi-account portfolio management — resource allocation,
//          ROI-based scaling, niche kill/scale, cross-account arbitrage
// PHASE: 4
// STATUS: ACTIVE
// MINDSET: Hedge fund thinking applied to content accounts.
//          Each account = asset. Optimize portfolio-level returns.
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('PortfolioEngine');

// ─── ACCOUNT HEALTH STATUS ──────────────────────────────────

const AccountHealth = {
  THRIVING: 'thriving',       // High ROI, growing engagement
  STABLE: 'stable',           // Moderate ROI, flat
  STRUGGLING: 'struggling',   // Low ROI, declining
  BLEEDING: 'bleeding',       // Negative ROI, burning cash
  NEW: 'new',                 // Insufficient data
};

// ─── PORTFOLIO STRATEGY ─────────────────────────────────────

const AllocationStrategy = {
  AGGRESSIVE: 'aggressive',   // Heavy on high performers
  BALANCED: 'balanced',       // Equal distribution
  CONSERVATIVE: 'conservative', // Minimize losses
  GROWTH: 'growth',           // Invest in new/growing
};

// ─── ACCOUNT ENTITY ─────────────────────────────────────────

class Account {
  constructor(id, config) {
    this.id = id;
    this.platform = config.platform || 'youtube';
    this.channelName = config.channelName || id;
    this.niche = config.niche || 'finance';
    this.subNiche = config.subNiche || 'general';
    this.createdAt = new Date().toISOString();

    // Performance metrics
    this.totalVideos = 0;
    this.totalRevenue = 0;
    this.totalCost = 0;
    this.totalViews = 0;
    this.avgEngagement = 0;
    this.engagementHistory = [];

    // Allocation
    this.budgetAllocation = 0; // % of total budget
    this.videosPerWeek = 3;    // target output

    // Status
    this.health = AccountHealth.NEW;
    this.lastPublishedAt = null;
  }

  updateMetrics(metrics) {
    this.totalVideos += metrics.videos || 0;
    this.totalRevenue += metrics.revenue || 0;
    this.totalCost += metrics.cost || 0;
    this.totalViews += metrics.views || 0;

    if (metrics.engagement !== undefined) {
      this.engagementHistory.push(metrics.engagement);
      if (this.engagementHistory.length > 20) this.engagementHistory.shift();
      this.avgEngagement = Math.round(
        (this.engagementHistory.reduce((a, b) => a + b, 0) / this.engagementHistory.length) * 10
      ) / 10;
    }

    this.health = this._computeHealth();
  }

  _computeHealth() {
    if (this.totalVideos < 5) return AccountHealth.NEW;

    const roi = this.totalCost > 0 ? (this.totalRevenue - this.totalCost) / this.totalCost : 0;
    const trend = this._getTrend();

    if (roi > 2 && trend !== 'declining') return AccountHealth.THRIVING;
    if (roi > 0.5) return AccountHealth.STABLE;
    if (roi > 0) return AccountHealth.STRUGGLING;
    return AccountHealth.BLEEDING;
  }

  _getTrend() {
    if (this.engagementHistory.length < 5) return 'unknown';
    const recent = this.engagementHistory.slice(-5);
    const older = this.engagementHistory.slice(-10, -5);
    if (older.length === 0) return 'unknown';

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    if (recentAvg > olderAvg * 1.1) return 'growing';
    if (recentAvg < olderAvg * 0.9) return 'declining';
    return 'stable';
  }

  getROI() {
    return this.totalCost > 0
      ? Math.round(((this.totalRevenue - this.totalCost) / this.totalCost) * 100)
      : 0;
  }

  getProfit() {
    return Math.round((this.totalRevenue - this.totalCost) * 100) / 100;
  }

  getSummary() {
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
      profit: this.getProfit(),
      roi: this.getROI(),
      avgEngagement: this.avgEngagement,
      trend: this._getTrend(),
      budgetAllocation: this.budgetAllocation,
      videosPerWeek: this.videosPerWeek,
    };
  }
}

// ─── PORTFOLIO ENGINE ───────────────────────────────────────

class PortfolioEngine {
  constructor() {
    this.accounts = new Map();
    this.strategy = AllocationStrategy.BALANCED;
    this.totalBudgetUSD = 150; // monthly budget
    this.allocationHistory = [];

    log.info('PortfolioEngine initialized', { strategy: this.strategy });
  }

  // ─── ACCOUNT MANAGEMENT ─────────────────────────────────

  addAccount(id, config) {
    const account = new Account(id, config);
    this.accounts.set(id, account);
    this._reallocate();
    log.info('Account added', { id, platform: config.platform, niche: config.niche });
    return account;
  }

  removeAccount(id) {
    this.accounts.delete(id);
    this._reallocate();
    log.info('Account removed', { id });
  }

  getAccount(id) {
    return this.accounts.get(id) || null;
  }

  updateAccountMetrics(id, metrics) {
    const account = this.accounts.get(id);
    if (!account) return null;
    account.updateMetrics(metrics);
    return account.getSummary();
  }

  // ─── ALLOCATION ENGINE ──────────────────────────────────

  setStrategy(strategy) {
    this.strategy = strategy;
    this._reallocate();
    log.info('Strategy updated', { strategy });
  }

  _reallocate() {
    const accounts = Array.from(this.accounts.values());
    if (accounts.length === 0) return;

    switch (this.strategy) {
      case AllocationStrategy.AGGRESSIVE:
        this._allocateAggressive(accounts);
        break;
      case AllocationStrategy.GROWTH:
        this._allocateGrowth(accounts);
        break;
      case AllocationStrategy.CONSERVATIVE:
        this._allocateConservative(accounts);
        break;
      default:
        this._allocateBalanced(accounts);
    }

    this.allocationHistory.push({
      timestamp: new Date().toISOString(),
      strategy: this.strategy,
      allocations: accounts.map(a => ({ id: a.id, allocation: a.budgetAllocation })),
    });
  }

  _allocateBalanced(accounts) {
    const share = Math.round(100 / accounts.length);
    accounts.forEach(a => { a.budgetAllocation = share; });
  }

  _allocateAggressive(accounts) {
    // Weight heavily by ROI — top performers get most
    const totalROI = accounts.reduce((s, a) => s + Math.max(0, a.getROI()), 0) || 1;
    accounts.forEach(a => {
      const roi = Math.max(0, a.getROI());
      a.budgetAllocation = Math.max(5, Math.round((roi / totalROI) * 100));
    });
    // Normalize to 100
    const total = accounts.reduce((s, a) => s + a.budgetAllocation, 0);
    if (total > 0) accounts.forEach(a => { a.budgetAllocation = Math.round((a.budgetAllocation / total) * 100); });
  }

  _allocateGrowth(accounts) {
    // Favor new and growing accounts
    accounts.forEach(a => {
      const trend = a._getTrend();
      const base = Math.round(100 / accounts.length);
      if (a.health === AccountHealth.NEW || trend === 'growing') {
        a.budgetAllocation = Math.round(base * 1.5);
      } else if (trend === 'declining') {
        a.budgetAllocation = Math.round(base * 0.5);
      } else {
        a.budgetAllocation = base;
      }
    });
    const total = accounts.reduce((s, a) => s + a.budgetAllocation, 0);
    if (total > 0) accounts.forEach(a => { a.budgetAllocation = Math.round((a.budgetAllocation / total) * 100); });
  }

  _allocateConservative(accounts) {
    // Minimize risk — spread evenly but cut bleeders
    const viable = accounts.filter(a => a.health !== AccountHealth.BLEEDING);
    const bleeders = accounts.filter(a => a.health === AccountHealth.BLEEDING);

    if (viable.length === 0) {
      this._allocateBalanced(accounts);
      return;
    }

    const viableShare = Math.round(95 / viable.length);
    const bleederShare = bleeders.length > 0 ? Math.round(5 / bleeders.length) : 0;

    viable.forEach(a => { a.budgetAllocation = viableShare; });
    bleeders.forEach(a => { a.budgetAllocation = bleederShare; });
  }

  // ─── PORTFOLIO DECISIONS ─────────────────────────────────

  getRecommendations() {
    const recommendations = [];
    const accounts = Array.from(this.accounts.values());

    for (const account of accounts) {
      const summary = account.getSummary();

      if (summary.health === AccountHealth.THRIVING && summary.trend === 'growing') {
        recommendations.push({
          type: 'scale',
          accountId: account.id,
          action: `Double down on ${account.channelName} — ROI ${summary.roi}%, trend growing`,
          params: { currentVideos: account.videosPerWeek, recommended: Math.min(7, account.videosPerWeek * 2) },
        });
      }

      if (summary.health === AccountHealth.BLEEDING && summary.totalVideos >= 10) {
        recommendations.push({
          type: 'kill',
          accountId: account.id,
          action: `Consider shutting down ${account.channelName} — negative ROI, ${summary.totalVideos} videos produced`,
          params: { totalLoss: Math.abs(summary.profit) },
        });
      }

      if (summary.health === AccountHealth.STRUGGLING && summary.trend === 'declining') {
        recommendations.push({
          type: 'pivot',
          accountId: account.id,
          action: `Pivot ${account.channelName} — try different sub-niche or format`,
          params: { currentNiche: account.subNiche },
        });
      }
    }

    // Cross-account opportunity detection
    const niches = {};
    for (const a of accounts) {
      if (!niches[a.niche]) niches[a.niche] = [];
      niches[a.niche].push(a);
    }
    for (const [niche, nicheAccounts] of Object.entries(niches)) {
      const avgROI = nicheAccounts.reduce((s, a) => s + a.getROI(), 0) / nicheAccounts.length;
      if (avgROI > 200 && nicheAccounts.length < 3) {
        recommendations.push({
          type: 'expand',
          action: `${niche} niche averaging ${avgROI}% ROI — consider adding another account`,
          params: { currentAccounts: nicheAccounts.length, avgROI },
        });
      }
    }

    return recommendations;
  }

  // ─── PORTFOLIO STATS ────────────────────────────────────

  getPortfolioSummary() {
    const accounts = Array.from(this.accounts.values());
    const totalRevenue = accounts.reduce((s, a) => s + a.totalRevenue, 0);
    const totalCost = accounts.reduce((s, a) => s + a.totalCost, 0);
    const totalVideos = accounts.reduce((s, a) => s + a.totalVideos, 0);
    const totalProfit = totalRevenue - totalCost;

    return {
      strategy: this.strategy,
      accountCount: accounts.length,
      totalVideos,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      portfolioROI: totalCost > 0 ? Math.round((totalProfit / totalCost) * 100) : 0,
      healthBreakdown: accounts.reduce((acc, a) => { acc[a.health] = (acc[a.health] || 0) + 1; return acc; }, {}),
      accounts: accounts.map(a => a.getSummary()),
      recommendations: this.getRecommendations(),
    };
  }

  clean() {
    this.accounts.clear();
    this.allocationHistory = [];
    log.info('PortfolioEngine cleaned');
  }
}

const portfolioEngine = new PortfolioEngine();

module.exports = { PortfolioEngine, portfolioEngine, AccountHealth, AllocationStrategy, Account };
