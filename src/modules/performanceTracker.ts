// ============================================================
// MODULE: modules/performanceTracker.ts
// PURPOSE: Collect platform analytics, retention curves, engagement scoring
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock analytics for now. Production: YouTube/IG/TikTok API polling.
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('PerformanceTracker');

// ─── ENUMS ──────────────────────────────────────────────────

export enum MetricType {
  VIEWS = 'views',
  LIKES = 'likes',
  COMMENTS = 'comments',
  SHARES = 'shares',
  WATCH_TIME = 'watch_time',
  RETENTION = 'retention',
  CTR = 'ctr',
  SUBSCRIBERS_GAINED = 'subscribers_gained',
}

export enum TimeWindow {
  HOUR_1 = '1h',
  HOUR_6 = '6h',
  HOUR_24 = '24h',
  DAY_3 = '3d',
  DAY_7 = '7d',
  DAY_30 = '30d',
}

// ─── INTERFACES ─────────────────────────────────────────────

export interface VideoMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  avgWatchPercent: number;
  avgWatchSeconds: number;
  ctr: number;
}

export interface RetentionPoint {
  percentThrough: number;
  viewersRemaining: number;
}

export interface MetricSnapshot {
  videoId: string;
  platform: string;
  collectedAt: string;
  hoursLive: number;
  metrics: VideoMetrics;
  retentionCurve: RetentionPoint[];
}

export interface EngagementScore {
  overall: number;
  breakdown: Record<string, number>;
  weights: Record<string, number>;
  verdict: 'viral' | 'strong' | 'average' | 'underperforming';
}

export interface DropPoint {
  position: number;
  drop: number;
  severity: 'critical' | 'moderate';
  recommendation: string;
}

export interface StrongPoint {
  position: number;
  retention: number;
  note: string;
}

export interface RetentionAnalysis {
  dropPoints: DropPoint[];
  strongPoints: StrongPoint[];
  avgRetention: number;
  hookRetention: number;
  endRetention: number;
}

export interface VideoTrend {
  direction: 'growing' | 'declining' | 'stable';
  delta: number;
  percentChange: number;
}

export interface VideoPerformance {
  videoId: string;
  platform: string | undefined;
  publishedAt: string | undefined;
  latestMetrics: VideoMetrics;
  engagementScore: EngagementScore | null;
  retentionAnalysis: RetentionAnalysis;
  snapshotCount: number;
  trend: VideoTrend;
}

export interface TrackedVideo {
  platform: string;
  uploadId: string;
  publishedAt: string;
  lastPolledAt: string | null;
}

export interface PerformanceStats {
  trackedVideos: number;
  totalSnapshots: number;
  avgEngagement: number;
  verdictBreakdown: Record<string, number>;
}

export interface CollectResult {
  snapshot: MetricSnapshot;
  engagementScore: EngagementScore;
  retentionAnalysis: RetentionAnalysis;
}

// ─── MOCK ANALYTICS GENERATOR ───────────────────────────────

export function generateMockMetrics(videoId: string, platform: string, hoursLive: number): MetricSnapshot {
  const virality = Math.random();
  const baseMultiplier: Record<string, number> = { youtube: 1.0, instagram: 0.8, tiktok: 1.3 };
  const mult = baseMultiplier[platform] || 1.0;

  const maxViews = Math.floor(500 + virality * 50000);
  const viewsGrowthRate = 0.3 + virality * 0.7;
  const views = Math.min(maxViews, Math.floor(maxViews * (1 - Math.exp(-viewsGrowthRate * hoursLive / 24)) * mult));

  const likeRate = 0.03 + Math.random() * 0.07;
  const commentRate = 0.005 + Math.random() * 0.02;
  const shareRate = 0.002 + Math.random() * 0.01;
  const subGainRate = 0.001 + Math.random() * 0.005;
  const avgWatchPercent = 30 + Math.random() * 50;
  const avgWatchSeconds = (avgWatchPercent / 100) * 60;

  const retentionCurve: RetentionPoint[] = [];
  let currentRetention = 100;
  for (let i = 0; i <= 10; i++) {
    retentionCurve.push({
      percentThrough: i * 10,
      viewersRemaining: Math.round(currentRetention * 10) / 10,
    });
    const dropRate = i < 2 ? 8 + Math.random() * 5
      : i < 8 ? 2 + Math.random() * 3
        : 5 + Math.random() * 4;
    currentRetention = Math.max(0, currentRetention - dropRate);
  }

  return {
    videoId,
    platform,
    collectedAt: new Date().toISOString(),
    hoursLive,
    metrics: {
      views,
      likes: Math.floor(views * likeRate),
      comments: Math.floor(views * commentRate),
      shares: Math.floor(views * shareRate),
      subscribersGained: Math.floor(views * subGainRate),
      avgWatchPercent: Math.round(avgWatchPercent * 10) / 10,
      avgWatchSeconds: Math.round(avgWatchSeconds * 10) / 10,
      ctr: Math.round((2 + Math.random() * 8) * 100) / 100,
    },
    retentionCurve,
  };
}

// ─── ENGAGEMENT SCORER ──────────────────────────────────────

export function computeEngagementScore(metrics: VideoMetrics): EngagementScore {
  const weights: Record<string, number> = {
    avgWatchPercent: 0.30,
    likeToViewRatio: 0.15,
    commentToViewRatio: 0.15,
    shareToViewRatio: 0.20,
    ctr: 0.10,
    subGainRatio: 0.10,
  };

  const views = metrics.views || 1;
  const scores: Record<string, number> = {
    avgWatchPercent: Math.min(100, metrics.avgWatchPercent || 0),
    likeToViewRatio: Math.min(100, (metrics.likes / views) * 1000),
    commentToViewRatio: Math.min(100, (metrics.comments / views) * 2000),
    shareToViewRatio: Math.min(100, (metrics.shares / views) * 5000),
    ctr: Math.min(100, (metrics.ctr || 0) * 10),
    subGainRatio: Math.min(100, (metrics.subscribersGained / views) * 10000),
  };

  let overall = 0;
  for (const [key, weight] of Object.entries(weights)) {
    overall += (scores[key] || 0) * weight;
  }

  const verdict: EngagementScore['verdict'] =
    overall >= 70 ? 'viral' : overall >= 50 ? 'strong' : overall >= 30 ? 'average' : 'underperforming';

  return { overall: Math.round(overall * 10) / 10, breakdown: scores, weights, verdict };
}

// ─── RETENTION ANALYZER ─────────────────────────────────────

export function analyzeRetention(retentionCurve: RetentionPoint[]): RetentionAnalysis {
  if (!retentionCurve || retentionCurve.length < 3) {
    return { dropPoints: [], strongPoints: [], avgRetention: 0, hookRetention: 0, endRetention: 0 };
  }

  const dropPoints: DropPoint[] = [];
  const strongPoints: StrongPoint[] = [];

  for (let i = 1; i < retentionCurve.length; i++) {
    const drop = retentionCurve[i - 1].viewersRemaining - retentionCurve[i].viewersRemaining;
    const position = retentionCurve[i].percentThrough;

    if (drop > 8) {
      dropPoints.push({
        position,
        drop: Math.round(drop * 10) / 10,
        severity: drop > 15 ? 'critical' : 'moderate',
        recommendation: position <= 20
          ? 'Hook is weak — improve opening seconds'
          : position >= 80
            ? 'Ending drags — tighten CTA'
            : 'Pacing dip — restructure mid-section',
      });
    } else if (drop < 2) {
      strongPoints.push({ position, retention: retentionCurve[i].viewersRemaining, note: 'Strong hold — audience engaged' });
    }
  }

  const avgRetention = retentionCurve.reduce((s, p) => s + p.viewersRemaining, 0) / retentionCurve.length;

  return {
    dropPoints,
    strongPoints,
    avgRetention: Math.round(avgRetention * 10) / 10,
    hookRetention: retentionCurve.length > 1 ? retentionCurve[1].viewersRemaining : 0,
    endRetention: retentionCurve[retentionCurve.length - 1].viewersRemaining,
  };
}

// ─── PERFORMANCE TRACKER ────────────────────────────────────

export class PerformanceTracker {
  private snapshots: Map<string, MetricSnapshot[]>;
  private scores: Map<string, EngagementScore>;
  private trackedVideos: Map<string, TrackedVideo>;

  constructor() {
    this.snapshots = new Map();
    this.scores = new Map();
    this.trackedVideos = new Map();
  }

  track(videoId: string, platform: string, uploadId: string): void {
    this.trackedVideos.set(videoId, {
      platform,
      uploadId,
      publishedAt: new Date().toISOString(),
      lastPolledAt: null,
    });
    this.snapshots.set(videoId, []);
    log.info('Tracking video', { videoId, platform, uploadId });
  }

  async collectMetrics(videoId: string): Promise<CollectResult | null> {
    const tracked = this.trackedVideos.get(videoId);
    if (!tracked) return null;

    const hoursLive = (Date.now() - new Date(tracked.publishedAt).getTime()) / 3600000;
    const snapshot = generateMockMetrics(videoId, tracked.platform, Math.max(1, hoursLive));

    const history = this.snapshots.get(videoId) || [];
    history.push(snapshot);
    this.snapshots.set(videoId, history);

    const score = computeEngagementScore(snapshot.metrics);
    this.scores.set(videoId, score);

    const retention = analyzeRetention(snapshot.retentionCurve);
    tracked.lastPolledAt = new Date().toISOString();

    log.info('Metrics collected', {
      videoId,
      platform: tracked.platform,
      views: snapshot.metrics.views,
      engagement: score.overall,
      verdict: score.verdict,
    });

    return { snapshot, engagementScore: score, retentionAnalysis: retention };
  }

  async pollAll(): Promise<Record<string, CollectResult | null>> {
    const results: Record<string, CollectResult | null> = {};
    for (const [videoId] of this.trackedVideos) {
      results[videoId] = await this.collectMetrics(videoId);
    }
    return results;
  }

  getPerformance(videoId: string): VideoPerformance | null {
    const history = this.snapshots.get(videoId) || [];
    if (history.length === 0) return null;

    const latest = history[history.length - 1];
    const tracked = this.trackedVideos.get(videoId);

    return {
      videoId,
      platform: tracked?.platform,
      publishedAt: tracked?.publishedAt,
      latestMetrics: latest.metrics,
      engagementScore: this.scores.get(videoId) || null,
      retentionAnalysis: analyzeRetention(latest.retentionCurve),
      snapshotCount: history.length,
      trend: this._computeTrend(history),
    };
  }

  private _computeTrend(history: MetricSnapshot[]): VideoTrend {
    if (history.length < 2) return { direction: 'stable', delta: 0, percentChange: 0 };
    const latest = history[history.length - 1].metrics.views;
    const previous = history[history.length - 2].metrics.views;
    const delta = latest - previous;
    return {
      direction: delta > 0 ? 'growing' : delta < 0 ? 'declining' : 'stable',
      delta,
      percentChange: previous > 0 ? Math.round((delta / previous) * 100) : 0,
    };
  }

  getTopPerformers(limit: number = 5): Array<{ videoId: string; engagement: number; verdict: string; platform?: string }> {
    return Array.from(this.scores.entries())
      .sort(([, a], [, b]) => b.overall - a.overall)
      .slice(0, limit)
      .map(([videoId, score]) => ({
        videoId,
        engagement: score.overall,
        verdict: score.verdict,
        platform: this.trackedVideos.get(videoId)?.platform,
      }));
  }

  getStats(): PerformanceStats {
    const allScores = Array.from(this.scores.values()).map(s => s.overall);
    return {
      trackedVideos: this.trackedVideos.size,
      totalSnapshots: Array.from(this.snapshots.values()).reduce((s, arr) => s + arr.length, 0),
      avgEngagement: allScores.length > 0
        ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) / 10
        : 0,
      verdictBreakdown: Array.from(this.scores.values()).reduce((acc, s) => {
        acc[s.verdict] = (acc[s.verdict] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
  }

  clean(): void {
    this.snapshots.clear();
    this.scores.clear();
    this.trackedVideos.clear();
    log.info('PerformanceTracker cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const performanceTracker = new PerformanceTracker();
