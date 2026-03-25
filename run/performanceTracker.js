// ============================================================
// MODULE: performanceTracker.js
// PURPOSE: Collect platform analytics, retention curves, engagement scoring
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock analytics for now. Production: YouTube/IG/TikTok API polling.
// FLOW: poll platforms -> store metrics -> compute retention curve ->
//       engagement score -> feed into decisionEngine (Phase 4)
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('PerformanceTracker');

// ─── METRIC TYPES ───────────────────────────────────────────

const MetricType = {
  VIEWS: 'views',
  LIKES: 'likes',
  COMMENTS: 'comments',
  SHARES: 'shares',
  WATCH_TIME: 'watch_time',
  RETENTION: 'retention',
  CTR: 'ctr',
  SUBSCRIBERS_GAINED: 'subscribers_gained',
};

// ─── TIME WINDOWS ───────────────────────────────────────────

const TimeWindow = {
  HOUR_1: '1h',
  HOUR_6: '6h',
  HOUR_24: '24h',
  DAY_3: '3d',
  DAY_7: '7d',
  DAY_30: '30d',
};

// ─── MOCK ANALYTICS GENERATOR ───────────────────────────────

function generateMockMetrics(videoId, platform, hoursLive) {
  // Simulate realistic growth curves
  // Short-form content: fast spike in first 24h, then plateau
  const virality = Math.random(); // 0-1 luck factor
  const baseMultiplier = { youtube: 1.0, instagram: 0.8, tiktok: 1.3 }[platform] || 1.0;

  // Views follow a log curve capped by virality
  const maxViews = Math.floor(500 + virality * 50000);
  const viewsGrowthRate = 0.3 + virality * 0.7;
  const views = Math.min(maxViews, Math.floor(maxViews * (1 - Math.exp(-viewsGrowthRate * hoursLive / 24)) * baseMultiplier));

  // Engagement ratios
  const likeRate = 0.03 + Math.random() * 0.07;   // 3-10%
  const commentRate = 0.005 + Math.random() * 0.02; // 0.5-2.5%
  const shareRate = 0.002 + Math.random() * 0.01;   // 0.2-1.2%
  const subGainRate = 0.001 + Math.random() * 0.005; // 0.1-0.6%

  // Watch time / retention
  const avgWatchPercent = 30 + Math.random() * 50; // 30-80%
  const avgWatchSeconds = (avgWatchPercent / 100) * 60; // assuming 60s video

  // Retention curve (10 data points at 10% intervals)
  const retentionCurve = [];
  let currentRetention = 100;
  for (let i = 0; i <= 10; i++) {
    retentionCurve.push({
      percentThrough: i * 10,
      viewersRemaining: Math.round(currentRetention * 10) / 10,
    });
    // Drop rate: steep at start, gradual in middle, spike at end
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
      ctr: Math.round((2 + Math.random() * 8) * 100) / 100, // 2-10%
    },
    retentionCurve,
  };
}

// ─── ENGAGEMENT SCORER ──────────────────────────────────────

function computeEngagementScore(metrics) {
  // Weighted engagement score (0-100)
  // Heavily weights retention + shares (signals quality)
  const weights = {
    avgWatchPercent: 0.30,   // retention is king
    likeToViewRatio: 0.15,
    commentToViewRatio: 0.15,
    shareToViewRatio: 0.20,  // shares = strong signal
    ctr: 0.10,
    subGainRatio: 0.10,
  };

  const views = metrics.views || 1;

  const scores = {
    avgWatchPercent: Math.min(100, metrics.avgWatchPercent || 0),
    likeToViewRatio: Math.min(100, ((metrics.likes || 0) / views) * 1000),
    commentToViewRatio: Math.min(100, ((metrics.comments || 0) / views) * 2000),
    shareToViewRatio: Math.min(100, ((metrics.shares || 0) / views) * 5000),
    ctr: Math.min(100, (metrics.ctr || 0) * 10),
    subGainRatio: Math.min(100, ((metrics.subscribersGained || 0) / views) * 10000),
  };

  let overall = 0;
  for (const [key, weight] of Object.entries(weights)) {
    overall += (scores[key] || 0) * weight;
  }

  return {
    overall: Math.round(overall * 10) / 10,
    breakdown: scores,
    weights,
    verdict: overall >= 70 ? 'viral' : overall >= 50 ? 'strong' : overall >= 30 ? 'average' : 'underperforming',
  };
}

// ─── RETENTION ANALYZER ─────────────────────────────────────

function analyzeRetention(retentionCurve) {
  if (!retentionCurve || retentionCurve.length < 3) {
    return { dropPoints: [], strongPoints: [], avgRetention: 0 };
  }

  const dropPoints = [];
  const strongPoints = [];

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
      strongPoints.push({
        position,
        retention: retentionCurve[i].viewersRemaining,
        note: 'Strong hold — audience engaged',
      });
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

class PerformanceTracker {
  constructor() {
    this.snapshots = new Map();   // videoId -> [snapshot, snapshot, ...]
    this.scores = new Map();      // videoId -> latest engagement score
    this.trackedVideos = new Map(); // videoId -> { platform, publishedAt, uploadId }
  }

  // ─── TRACK A VIDEO ─────────────────────────────────────

  track(videoId, platform, uploadId) {
    this.trackedVideos.set(videoId, {
      platform,
      uploadId,
      publishedAt: new Date().toISOString(),
      lastPolledAt: null,
    });
    this.snapshots.set(videoId, []);
    log.info('Tracking video', { videoId, platform, uploadId });
  }

  // ─── POLL / COLLECT METRICS ────────────────────────────

  async collectMetrics(videoId) {
    const tracked = this.trackedVideos.get(videoId);
    if (!tracked) {
      log.warn('Video not tracked', { videoId });
      return null;
    }

    const hoursLive = (Date.now() - new Date(tracked.publishedAt).getTime()) / 3600000;

    // Mock: generate simulated metrics
    // Production: call YouTube/IG/TikTok APIs
    const snapshot = generateMockMetrics(videoId, tracked.platform, Math.max(1, hoursLive));

    // Store snapshot
    const history = this.snapshots.get(videoId) || [];
    history.push(snapshot);
    this.snapshots.set(videoId, history);

    // Compute engagement score
    const score = computeEngagementScore(snapshot.metrics);
    this.scores.set(videoId, score);

    // Analyze retention
    const retention = analyzeRetention(snapshot.retentionCurve);

    tracked.lastPolledAt = new Date().toISOString();

    log.info('Metrics collected', {
      videoId,
      platform: tracked.platform,
      views: snapshot.metrics.views,
      engagement: score.overall,
      verdict: score.verdict,
      hookRetention: retention.hookRetention,
    });

    return {
      snapshot,
      engagementScore: score,
      retentionAnalysis: retention,
    };
  }

  // ─── POLL ALL TRACKED VIDEOS ───────────────────────────

  async pollAll() {
    const results = {};
    for (const [videoId] of this.trackedVideos) {
      results[videoId] = await this.collectMetrics(videoId);
    }
    log.info('Poll complete', { trackedCount: this.trackedVideos.size });
    return results;
  }

  // ─── GET VIDEO PERFORMANCE ─────────────────────────────

  getPerformance(videoId) {
    const history = this.snapshots.get(videoId) || [];
    const score = this.scores.get(videoId) || null;
    const tracked = this.trackedVideos.get(videoId) || null;

    if (history.length === 0) return null;

    const latest = history[history.length - 1];

    return {
      videoId,
      platform: tracked?.platform,
      publishedAt: tracked?.publishedAt,
      latestMetrics: latest.metrics,
      engagementScore: score,
      retentionAnalysis: analyzeRetention(latest.retentionCurve),
      snapshotCount: history.length,
      trend: this._computeTrend(history),
    };
  }

  // ─── TREND COMPUTATION ─────────────────────────────────

  _computeTrend(history) {
    if (history.length < 2) return { direction: 'stable', delta: 0 };

    const latest = history[history.length - 1].metrics.views;
    const previous = history[history.length - 2].metrics.views;
    const delta = latest - previous;
    const percentChange = previous > 0 ? Math.round((delta / previous) * 100) : 0;

    return {
      direction: delta > 0 ? 'growing' : delta < 0 ? 'declining' : 'stable',
      delta,
      percentChange,
    };
  }

  // ─── TOP PERFORMERS ────────────────────────────────────

  getTopPerformers(limit = 5) {
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

  // ─── STATS ─────────────────────────────────────────────

  getStats() {
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
      }, {}),
    };
  }

  // ─── CLEAN ─────────────────────────────────────────────

  clean() {
    this.snapshots.clear();
    this.scores.clear();
    this.trackedVideos.clear();
    log.info('PerformanceTracker cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const performanceTracker = new PerformanceTracker();

module.exports = {
  PerformanceTracker,
  performanceTracker,
  MetricType,
  TimeWindow,
  computeEngagementScore,
  analyzeRetention,
  generateMockMetrics,
};
