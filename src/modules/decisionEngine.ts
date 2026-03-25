// ============================================================
// MODULE: modules/decisionEngine.ts
// PURPOSE: Convert analytics data into actionable content strategy decisions
// PHASE: 4
// STATUS: ACTIVE
// FLOW: performanceTracker data → analyze patterns → generate decisions →
//       feed into orchestrator for next batch
// ============================================================

import { createLogger } from '../infra/logger';
import { Logger } from '../types';

const log: Logger = createLogger('DecisionEngine');

// ─── ENUMS ──────────────────────────────────────────────────

export enum DecisionType {
  SCALE_TOPIC = 'scale_topic',
  KILL_TOPIC = 'kill_topic',
  SHIFT_FORMAT = 'shift_format',
  ADJUST_FREQUENCY = 'adjust_frequency',
  ROTATE_NICHE = 'rotate_niche',
  OPTIMIZE_TIMING = 'optimize_timing',
  BUDGET_REALLOC = 'budget_realloc',
}

export enum Confidence {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

// ─── INTERFACES ──────────────────────────────────────────────

export interface PerformanceEntry {
  videoId: string;
  topic: string;
  platform: string;
  engagement: number;
  views: number;
  hookPattern: string;
  retentionAvg: number;
}

export interface PatternGroup {
  topic?: string;
  avgEngagement: number;
  avgViews: number;
  count: number;
}

export interface Decision {
  id: string;
  type: DecisionType;
  confidence: Confidence;
  target: string;
  action: string;
  params: Record<string, unknown>;
  createdAt: string;
  executed: boolean;
  executedAt?: string;
}

export interface DecisionStats {
  totalDecisions: number;
  executed: number;
  pending: number;
  byType: Record<string, number>;
  byConfidence: Record<string, number>;
}

// ─── HELPERS ────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function confidence(count: number, highThreshold: number, mediumThreshold: number): Confidence {
  if (count >= highThreshold) return Confidence.HIGH;
  if (count >= mediumThreshold) return Confidence.MEDIUM;
  return Confidence.LOW;
}

function makeId(): string {
  return `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── DECISION ENGINE ────────────────────────────────────────

export class DecisionEngine {
  private decisions: Decision[] = [];
  private executedCount: number = 0;
  private patterns: Record<string, unknown> | null = null;

  analyze(
    performanceData: PerformanceEntry[],
    currentStrategy?: Record<string, unknown>
  ): { patterns: Record<string, unknown>; decisions: Decision[] } {
    const startTime = Date.now();
    const newDecisions: Decision[] = [];

    // ── Group by topic ───────────────────────────────────────
    const byTopic = groupBy(performanceData, e => e.topic);
    const topicGroups = new Map<string, PatternGroup>();
    for (const [topic, entries] of byTopic) {
      topicGroups.set(topic, {
        topic,
        avgEngagement: avg(entries.map(e => e.engagement)),
        avgViews: avg(entries.map(e => e.views)),
        count: entries.length,
      });
    }

    // Scale high-performing topics
    for (const [topic, group] of topicGroups) {
      if (group.avgEngagement >= 0.6 && group.count >= 2) {
        newDecisions.push({
          id: makeId(),
          type: DecisionType.SCALE_TOPIC,
          confidence: confidence(group.count, 5, 3),
          target: topic,
          action: `Increase video frequency for topic "${topic}"`,
          params: { topic, avgEngagement: group.avgEngagement, avgViews: group.avgViews, suggestedFrequency: 3 },
          createdAt: new Date().toISOString(),
          executed: false,
        });
      }
      if (group.avgEngagement <= 0.15 && group.count >= 3) {
        newDecisions.push({
          id: makeId(),
          type: DecisionType.KILL_TOPIC,
          confidence: confidence(group.count, 5, 3),
          target: topic,
          action: `Stop producing content for topic "${topic}"`,
          params: { topic, avgEngagement: group.avgEngagement, avgViews: group.avgViews },
          createdAt: new Date().toISOString(),
          executed: false,
        });
      }
    }

    // ── Group by hookPattern ─────────────────────────────────
    const byHook = groupBy(performanceData, e => e.hookPattern);
    const hookGroups = new Map<string, { avgEng: number; count: number }>();
    for (const [pattern, entries] of byHook) {
      hookGroups.set(pattern, { avgEng: avg(entries.map(e => e.engagement)), count: entries.length });
    }

    // Find best and worst hook patterns
    let bestHook = { pattern: '', avgEng: -1, count: 0 };
    let worstHook = { pattern: '', avgEng: 2, count: 0 };
    for (const [pattern, g] of hookGroups) {
      if (g.count >= 2 && g.avgEng > bestHook.avgEng) bestHook = { pattern, avgEng: g.avgEng, count: g.count };
      if (g.count >= 2 && g.avgEng < worstHook.avgEng) worstHook = { pattern, avgEng: g.avgEng, count: g.count };
    }
    if (bestHook.pattern && worstHook.pattern && bestHook.pattern !== worstHook.pattern) {
      newDecisions.push({
        id: makeId(),
        type: DecisionType.SHIFT_FORMAT,
        confidence: confidence(bestHook.count, 10, 5),
        target: bestHook.pattern,
        action: `Prioritize "${bestHook.pattern}" hook pattern over "${worstHook.pattern}"`,
        params: {
          bestPattern: bestHook.pattern,
          bestAvgEngagement: bestHook.avgEng,
          worstPattern: worstHook.pattern,
          worstAvgEngagement: worstHook.avgEng,
        },
        createdAt: new Date().toISOString(),
        executed: false,
      });
    }

    // ── Group by platform ────────────────────────────────────
    const byPlatform = groupBy(performanceData, e => e.platform);
    const platformGroups = new Map<string, { avgEng: number; avgViews: number; count: number }>();
    for (const [platform, entries] of byPlatform) {
      platformGroups.set(platform, {
        avgEng: avg(entries.map(e => e.engagement)),
        avgViews: avg(entries.map(e => e.views)),
        count: entries.length,
      });
    }

    // Recommend frequency adjustments per platform
    for (const [platform, g] of platformGroups) {
      if (g.avgEng >= 0.5 && g.count >= 3) {
        newDecisions.push({
          id: makeId(),
          type: DecisionType.ADJUST_FREQUENCY,
          confidence: confidence(g.count, 8, 4),
          target: platform,
          action: `Increase posting frequency on ${platform}`,
          params: { platform, avgEngagement: g.avgEng, avgViews: g.avgViews, suggestedVideosPerWeek: 5 },
          createdAt: new Date().toISOString(),
          executed: false,
        });
      }
    }

    // ── Retention-based timing decisions ────────────────────
    const avgRetention = avg(performanceData.map(e => e.retentionAvg));
    if (avgRetention < 0.4 && performanceData.length >= 5) {
      newDecisions.push({
        id: makeId(),
        type: DecisionType.OPTIMIZE_TIMING,
        confidence: confidence(performanceData.length, 10, 5),
        target: 'global',
        action: 'Shorten average video duration — retention dropping before end',
        params: { avgRetention, dataPoints: performanceData.length, suggestedMaxSeconds: 45 },
        createdAt: new Date().toISOString(),
        executed: false,
      });
    }

    // ── Budget reallocation if platform ROI diverges ────────
    if (platformGroups.size >= 2) {
      const platforms = [...platformGroups.entries()].sort((a, b) => b[1].avgViews - a[1].avgViews);
      const [topPlatform, bottomPlatform] = [platforms[0], platforms[platforms.length - 1]];
      if (topPlatform[1].avgViews > bottomPlatform[1].avgViews * 3) {
        newDecisions.push({
          id: makeId(),
          type: DecisionType.BUDGET_REALLOC,
          confidence: Confidence.MEDIUM,
          target: topPlatform[0],
          action: `Shift budget from ${bottomPlatform[0]} to ${topPlatform[0]} — 3x view differential`,
          params: {
            from: bottomPlatform[0],
            to: topPlatform[0],
            fromAvgViews: bottomPlatform[1].avgViews,
            toAvgViews: topPlatform[1].avgViews,
            suggestedShiftPercent: 20,
          },
          createdAt: new Date().toISOString(),
          executed: false,
        });
      }
    }

    // ── Store patterns and decisions ─────────────────────────
    const patterns: Record<string, unknown> = {
      topicGroups: Object.fromEntries(topicGroups),
      hookGroups: Object.fromEntries(hookGroups),
      platformGroups: Object.fromEntries(platformGroups),
      dataPoints: performanceData.length,
      avgEngagement: avg(performanceData.map(e => e.engagement)),
      avgViews: avg(performanceData.map(e => e.views)),
      analyzedAt: new Date().toISOString(),
    };

    this.patterns = patterns;
    this.decisions.push(...newDecisions);

    log.info('Analysis complete', {
      dataPoints: performanceData.length,
      decisions: newDecisions.length,
      timeMs: Date.now() - startTime,
    });

    return { patterns, decisions: newDecisions };
  }

  // HIGH confidence only — safe to auto-execute
  getAutoExecutable(): Decision[] {
    return this.decisions.filter(d => !d.executed && d.confidence === Confidence.HIGH);
  }

  // MEDIUM + LOW — needs human review
  getPendingReview(): Decision[] {
    return this.decisions.filter(
      d => !d.executed && (d.confidence === Confidence.MEDIUM || d.confidence === Confidence.LOW)
    );
  }

  execute(decisionId: string): Decision | undefined {
    const decision = this.decisions.find(d => d.id === decisionId);
    if (!decision) { log.warn('Decision not found', { decisionId }); return undefined; }
    if (decision.executed) { log.warn('Decision already executed', { decisionId }); return decision; }
    decision.executed = true;
    decision.executedAt = new Date().toISOString();
    this.executedCount++;
    log.info('Decision executed', { id: decisionId, type: decision.type, target: decision.target });
    return decision;
  }

  getStats(): DecisionStats {
    const byType: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    for (const d of this.decisions) {
      byType[d.type] = (byType[d.type] ?? 0) + 1;
      byConfidence[d.confidence] = (byConfidence[d.confidence] ?? 0) + 1;
    }
    return {
      totalDecisions: this.decisions.length,
      executed: this.executedCount,
      pending: this.decisions.filter(d => !d.executed).length,
      byType,
      byConfidence,
    };
  }

  clean(): void {
    this.decisions = [];
    this.executedCount = 0;
    this.patterns = null;
    log.info('DecisionEngine cleared');
  }
}
