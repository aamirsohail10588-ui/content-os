// ============================================================
// MODULE: modules/monetizationTracker.ts
// PURPOSE: Revenue attribution per video, per account, P&L calculation
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock revenue data. Production: AdSense API, affiliate link tracking
// FEEDS: costController for true profit/loss per video
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('MonetizationTracker');

// ─── ENUMS ──────────────────────────────────────────────────

export enum RevenueSource {
  ADSENSE = 'adsense',
  AFFILIATE = 'affiliate',
  SPONSORSHIP = 'sponsorship',
  MERCHANDISE = 'merchandise',
  TIPS = 'tips',
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface AdRevenueEstimate {
  estimatedRevenueUSD: number;
  cpm: number;
  views: number;
  platform: string;
  source: RevenueSource;
  note: string;
}

export interface AffiliateRevenueEstimate {
  estimatedRevenueUSD: number;
  clicks: number;
  conversions: number;
  avgCommission: number;
  source: RevenueSource;
}

export interface RevenueEntry {
  source: string;
  revenueUSD: number;
  recordedAt: string;
  metadata: Record<string, unknown>;
}

export interface VideoRevenueRecord {
  sources: RevenueEntry[];
  totalUSD: number;
}

export interface VideoPL {
  videoId: string;
  revenue: number;
  cost: number;
  profit: number;
  roi: number;
  sources: RevenueEntry[];
  isProfitable: boolean;
}

export interface AccountPL {
  accountId: string;
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  roi: number;
  videoCount: number;
  avgRevenuePerVideo: number;
  avgProfitPerVideo: number;
  videos: VideoPL[];
  isProfitable: boolean;
}

export interface MonetizationStats {
  totalVideosTracked: number;
  totalAccountsTracked: number;
  totalRevenueUSD: number;
  totalCostUSD: number;
  totalProfitUSD: number;
  overallROI: number;
  avgRevenuePerVideo: number;
  revenueBySource: Record<string, number>;
  profitableVideoPercent: number;
}

// ─── MOCK REVENUE ESTIMATORS ────────────────────────────────

export function estimateAdRevenue(platform: string, views: number, engagementScore: number): AdRevenueEstimate {
  const baseCPM: Record<string, { min: number; max: number }> = {
    youtube: { min: 4.00, max: 12.00 },
    instagram: { min: 0.50, max: 2.00 },
    tiktok: { min: 0.20, max: 1.00 },
  };

  const rates = baseCPM[platform] || { min: 0.50, max: 3.00 };
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

export function estimateAffiliateRevenue(
  views: number,
  clickRate: number = 0.02,
  conversionRate: number = 0.03,
  avgCommission: number = 15.00
): AffiliateRevenueEstimate {
  const clicks = Math.floor(views * clickRate);
  const conversions = Math.floor(clicks * conversionRate);
  const revenue = conversions * avgCommission;

  return {
    estimatedRevenueUSD: Math.round(revenue * 100) / 100,
    clicks,
    conversions,
    avgCommission,
    source: RevenueSource.AFFILIATE,
  };
}

// ─── MONETIZATION TRACKER ───────────────────────────────────

export class MonetizationTracker {
  private videoRevenue: Map<string, VideoRevenueRecord>;
  private accountRevenue: Map<string, { totalUSD: number; videos: string[] }>;
  private costData: Map<string, number>;

  constructor() {
    this.videoRevenue = new Map();
    this.accountRevenue = new Map();
    this.costData = new Map();
  }

  recordCost(videoId: string, costUSD: number): void {
    this.costData.set(videoId, costUSD);
    log.info('Cost recorded for P&L', { videoId, costUSD });
  }

  recordRevenue(videoId: string, source: string, revenueUSD: number, metadata: Record<string, unknown> = {}): RevenueEntry {
    if (!this.videoRevenue.has(videoId)) {
      this.videoRevenue.set(videoId, { sources: [], totalUSD: 0 });
    }

    const entry: RevenueEntry = {
      source,
      revenueUSD: Math.round(revenueUSD * 100) / 100,
      recordedAt: new Date().toISOString(),
      metadata,
    };

    const record = this.videoRevenue.get(videoId)!;
    record.sources.push(entry);
    record.totalUSD = Math.round((record.totalUSD + revenueUSD) * 100) / 100;

    log.info('Revenue recorded', { videoId, source, revenueUSD: entry.revenueUSD, videoTotal: record.totalUSD });
    return entry;
  }

  estimateRevenue(videoId: string, platform: string, views: number, engagementScore: number = 50): VideoPL {
    const adRevenue = estimateAdRevenue(platform, views, engagementScore);
    this.recordRevenue(videoId, RevenueSource.ADSENSE, adRevenue.estimatedRevenueUSD, adRevenue as unknown as Record<string, unknown>);

    if (platform === 'youtube') {
      const affiliateRevenue = estimateAffiliateRevenue(views);
      this.recordRevenue(videoId, RevenueSource.AFFILIATE, affiliateRevenue.estimatedRevenueUSD, affiliateRevenue as unknown as Record<string, unknown>);
    }

    return this.getVideoRevenue(videoId);
  }

  linkToAccount(accountId: string, videoId: string): void {
    if (!this.accountRevenue.has(accountId)) {
      this.accountRevenue.set(accountId, { totalUSD: 0, videos: [] });
    }
    const account = this.accountRevenue.get(accountId)!;
    if (!account.videos.includes(videoId)) {
      account.videos.push(videoId);
    }
  }

  getVideoRevenue(videoId: string): VideoPL {
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

  getAccountRevenue(accountId: string): AccountPL | null {
    const account = this.accountRevenue.get(accountId);
    if (!account) return null;

    let totalRevenue = 0;
    let totalCost = 0;
    const videoBreakdown: VideoPL[] = [];

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
      avgRevenuePerVideo: account.videos.length > 0 ? Math.round((totalRevenue / account.videos.length) * 100) / 100 : 0,
      avgProfitPerVideo: account.videos.length > 0 ? Math.round((totalProfit / account.videos.length) * 100) / 100 : 0,
      videos: videoBreakdown,
      isProfitable: totalProfit > 0,
    };
  }

  getTopEarners(limit: number = 5): VideoPL[] {
    return Array.from(this.videoRevenue.keys())
      .map(id => this.getVideoRevenue(id))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, limit);
  }

  getStats(): MonetizationStats {
    const allVideos = Array.from(this.videoRevenue.keys()).map(id => this.getVideoRevenue(id));
    const totalRevenue = allVideos.reduce((s, v) => s + v.revenue, 0);
    const totalCost = allVideos.reduce((s, v) => s + v.cost, 0);
    const totalProfit = totalRevenue - totalCost;

    const bySource: Record<string, number> = {};
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
      avgRevenuePerVideo: allVideos.length > 0 ? Math.round((totalRevenue / allVideos.length) * 100) / 100 : 0,
      revenueBySource: bySource,
      profitableVideoPercent: allVideos.length > 0
        ? Math.round((allVideos.filter(v => v.isProfitable).length / allVideos.length) * 100)
        : 0,
    };
  }

  clean(): void {
    this.videoRevenue.clear();
    this.accountRevenue.clear();
    this.costData.clear();
    log.info('MonetizationTracker cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const monetizationTracker = new MonetizationTracker();
