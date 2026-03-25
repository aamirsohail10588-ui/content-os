// ============================================================
// MODULE: monetizationTracker.js
// PURPOSE: Revenue attribution per video, per account, P&L calculation
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock revenue data. Production: AdSense API, affiliate link tracking
// FEEDS: costController for true profit/loss per video
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('MonetizationTracker');

// ─── REVENUE SOURCES ────────────────────────────────────────

const RevenueSource = {
  ADSENSE: 'adsense',
  AFFILIATE: 'affiliate',
  SPONSORSHIP: 'sponsorship',
  MERCHANDISE: 'merchandise',
  TIPS: 'tips',
};

// ─── MOCK REVENUE ESTIMATOR ─────────────────────────────────

function estimateAdRevenue(platform, views, engagementScore) {
  // CPM rates vary by niche, platform, and audience quality
  const baseCPM = {
    youtube: { min: 4.00, max: 12.00 },   // finance niche has high CPM
    instagram: { min: 0.50, max: 2.00 },   // IG Reels monetization is lower
    tiktok: { min: 0.20, max: 1.00 },      // TikTok creator fund pays least
  };

  const rates = baseCPM[platform] || { min: 0.50, max: 3.00 };

  // CPM scales with engagement (quality traffic = better CPM)
  const engagementMultiplier = 0.5 + (engagementScore / 100) * 1.0;
  const cpm = (rates.min + Math.random() * (rates.max - rates.min)) * engagementMultiplier;

  const estimatedRevenue = (views / 1000) * cpm;

  return {
    estimatedRevenueUSD: Math.round(estimatedRevenue * 100) / 100,
    cpm: Math.round(cpm * 100) / 100,
    views,
    platform,
    source: RevenueSource.ADSENSE,
    note: 'Estimated — actual varies by audience geo, ad fill rate',
  };
}

function estimateAffiliateRevenue(views, clickRate, conversionRate, avgCommission) {
  const clicks = Math.floor(views * (clickRate || 0.02));        // 2% CTR default
  const conversions = Math.floor(clicks * (conversionRate || 0.03)); // 3% conversion
  const revenue = conversions * (avgCommission || 15.00);         // $15 avg commission

  return {
    estimatedRevenueUSD: Math.round(revenue * 100) / 100,
    clicks,
    conversions,
    avgCommission: avgCommission || 15.00,
    source: RevenueSource.AFFILIATE,
  };
}

// ─── MONETIZATION TRACKER ───────────────────────────────────

class MonetizationTracker {
  constructor() {
    this.videoRevenue = new Map();   // videoId -> { sources: [], totalUSD }
    this.accountRevenue = new Map(); // accountId -> { totalUSD, videos: [] }
    this.costData = new Map();       // videoId -> costUSD (from costController)
  }

  // ─── RECORD COST (from costController) ─────────────────

  recordCost(videoId, costUSD) {
    this.costData.set(videoId, costUSD);
    log.info('Cost recorded for P&L', { videoId, costUSD });
  }

  // ─── TRACK REVENUE ─────────────────────────────────────

  recordRevenue(videoId, source, revenueUSD, metadata = {}) {
    if (!this.videoRevenue.has(videoId)) {
      this.videoRevenue.set(videoId, { sources: [], totalUSD: 0 });
    }

    const entry = {
      source,
      revenueUSD: Math.round(revenueUSD * 100) / 100,
      recordedAt: new Date().toISOString(),
      metadata,
    };

    const record = this.videoRevenue.get(videoId);
    record.sources.push(entry);
    record.totalUSD = Math.round((record.totalUSD + revenueUSD) * 100) / 100;

    log.info('Revenue recorded', {
      videoId,
      source,
      revenueUSD: entry.revenueUSD,
      videoTotal: record.totalUSD,
    });

    return entry;
  }

  // ─── ESTIMATE ALL REVENUE FOR VIDEO ────────────────────

  estimateRevenue(videoId, platform, views, engagementScore = 50) {
    // Ad revenue
    const adRevenue = estimateAdRevenue(platform, views, engagementScore);
    this.recordRevenue(videoId, RevenueSource.ADSENSE, adRevenue.estimatedRevenueUSD, adRevenue);

    // Affiliate revenue (only for YouTube where links work)
    if (platform === 'youtube') {
      const affiliateRevenue = estimateAffiliateRevenue(views);
      this.recordRevenue(videoId, RevenueSource.AFFILIATE, affiliateRevenue.estimatedRevenueUSD, affiliateRevenue);
    }

    return this.getVideoRevenue(videoId);
  }

  // ─── LINK VIDEO TO ACCOUNT ─────────────────────────────

  linkToAccount(accountId, videoId) {
    if (!this.accountRevenue.has(accountId)) {
      this.accountRevenue.set(accountId, { totalUSD: 0, videos: [] });
    }
    const account = this.accountRevenue.get(accountId);
    if (!account.videos.includes(videoId)) {
      account.videos.push(videoId);
    }
  }

  // ─── GET VIDEO P&L ─────────────────────────────────────

  getVideoRevenue(videoId) {
    const revenue = this.videoRevenue.get(videoId) || { sources: [], totalUSD: 0 };
    const cost = this.costData.get(videoId) || 0;
    const profit = revenue.totalUSD - cost;

    return {
      videoId,
      revenue: revenue.totalUSD,
      cost,
      profit: Math.round(profit * 100) / 100,
      roi: cost > 0 ? Math.round((profit / cost) * 100) : 0,
      sources: revenue.sources,
      isProfitable: profit > 0,
    };
  }

  // ─── GET ACCOUNT P&L ───────────────────────────────────

  getAccountRevenue(accountId) {
    const account = this.accountRevenue.get(accountId);
    if (!account) return null;

    let totalRevenue = 0;
    let totalCost = 0;
    const videoBreakdown = [];

    for (const videoId of account.videos) {
      const pl = this.getVideoRevenue(videoId);
      totalRevenue += pl.revenue;
      totalCost += pl.cost;
      videoBreakdown.push(pl);
    }

    const totalProfit = totalRevenue - totalCost;

    return {
      accountId,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      roi: totalCost > 0 ? Math.round((totalProfit / totalCost) * 100) : 0,
      videoCount: account.videos.length,
      avgRevenuePerVideo: account.videos.length > 0
        ? Math.round((totalRevenue / account.videos.length) * 100) / 100
        : 0,
      avgProfitPerVideo: account.videos.length > 0
        ? Math.round((totalProfit / account.videos.length) * 100) / 100
        : 0,
      videos: videoBreakdown,
      isProfitable: totalProfit > 0,
    };
  }

  // ─── BEST / WORST PERFORMERS ───────────────────────────

  getTopEarners(limit = 5) {
    return Array.from(this.videoRevenue.keys())
      .map(id => this.getVideoRevenue(id))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit);
  }

  getWorstPerformers(limit = 5) {
    return Array.from(this.videoRevenue.keys())
      .map(id => this.getVideoRevenue(id))
      .sort((a, b) => a.profit - b.profit)
      .slice(0, limit);
  }

  // ─── STATS ─────────────────────────────────────────────

  getStats() {
    const allVideos = Array.from(this.videoRevenue.keys()).map(id => this.getVideoRevenue(id));
    const totalRevenue = allVideos.reduce((s, v) => s + v.revenue, 0);
    const totalCost = allVideos.reduce((s, v) => s + v.cost, 0);
    const totalProfit = totalRevenue - totalCost;

    const bySource = {};
    for (const video of allVideos) {
      for (const src of video.sources) {
        bySource[src.source] = (bySource[src.source] || 0) + src.revenueUSD;
      }
    }

    return {
      totalVideosTracked: this.videoRevenue.size,
      totalAccountsTracked: this.accountRevenue.size,
      totalRevenueUSD: Math.round(totalRevenue * 100) / 100,
      totalCostUSD: Math.round(totalCost * 100) / 100,
      totalProfitUSD: Math.round(totalProfit * 100) / 100,
      overallROI: totalCost > 0 ? Math.round((totalProfit / totalCost) * 100) : 0,
      avgRevenuePerVideo: allVideos.length > 0
        ? Math.round((totalRevenue / allVideos.length) * 100) / 100
        : 0,
      revenueBySource: bySource,
      profitableVideoPercent: allVideos.length > 0
        ? Math.round((allVideos.filter(v => v.isProfitable).length / allVideos.length) * 100)
        : 0,
    };
  }

  // ─── CLEAN ─────────────────────────────────────────────

  clean() {
    this.videoRevenue.clear();
    this.accountRevenue.clear();
    this.costData.clear();
    log.info('MonetizationTracker cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const monetizationTracker = new MonetizationTracker();

module.exports = {
  MonetizationTracker,
  monetizationTracker,
  RevenueSource,
  estimateAdRevenue,
  estimateAffiliateRevenue,
};
