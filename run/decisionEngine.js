// ============================================================
// MODULE: decisionEngine.js
// PURPOSE: Convert analytics data into actionable content strategy decisions
// PHASE: 4
// STATUS: ACTIVE
// FLOW: performanceTracker data → analyze patterns → generate decisions →
//       feed into orchestrator for next batch
// ============================================================

const { createLogger } = require('./logger');

const log = createLogger('DecisionEngine');

// ─── DECISION TYPES ─────────────────────────────────────────

const DecisionType = {
  SCALE_TOPIC: 'scale_topic',         // Topic performing well → make more
  KILL_TOPIC: 'kill_topic',           // Topic underperforming → stop
  SHIFT_FORMAT: 'shift_format',       // Change hook pattern / structure
  ADJUST_FREQUENCY: 'adjust_frequency', // Post more/less on platform
  ROTATE_NICHE: 'rotate_niche',       // Switch sub-niche focus
  OPTIMIZE_TIMING: 'optimize_timing', // Change posting schedule
  BUDGET_REALLOC: 'budget_realloc',   // Shift budget between platforms
};

const Confidence = {
  HIGH: 'high',       // >80% certainty, auto-execute
  MEDIUM: 'medium',   // 50-80%, suggest to user
  LOW: 'low',         // <50%, flag for review
};

// ─── PATTERN DETECTOR ───────────────────────────────────────

function detectPatterns(performanceData) {
  // performanceData = array of { videoId, topic, platform, engagement, views, hookPattern, retentionAvg }
  const patterns = {
    topTopics: [],
    deadTopics: [],
    bestHookPatterns: {},
    platformStrength: {},
    retentionInsights: [],
  };

  if (!performanceData || performanceData.length === 0) return patterns;

  // Group by topic
  const byTopic = {};
  for (const entry of performanceData) {
    const key = entry.topic || 'unknown';
    if (!byTopic[key]) byTopic[key] = [];
    byTopic[key].push(entry);
  }

  // Identify top/dead topics
  for (const [topic, entries] of Object.entries(byTopic)) {
    const avgEngagement = entries.reduce((s, e) => s + (e.engagement || 0), 0) / entries.length;
    const avgViews = entries.reduce((s, e) => s + (e.views || 0), 0) / entries.length;

    if (avgEngagement >= 60 && avgViews >= 5000) {
      patterns.topTopics.push({ topic, avgEngagement, avgViews, count: entries.length });
    } else if (avgEngagement < 25 && entries.length >= 2) {
      patterns.deadTopics.push({ topic, avgEngagement, avgViews, count: entries.length });
    }
  }

  // Best hook patterns
  const byHook = {};
  for (const entry of performanceData) {
    const hook = entry.hookPattern || 'unknown';
    if (!byHook[hook]) byHook[hook] = [];
    byHook[hook].push(entry.engagement || 0);
  }
  for (const [pattern, scores] of Object.entries(byHook)) {
    patterns.bestHookPatterns[pattern] = {
      avgEngagement: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
      count: scores.length,
    };
  }

  // Platform strength
  const byPlatform = {};
  for (const entry of performanceData) {
    const p = entry.platform || 'unknown';
    if (!byPlatform[p]) byPlatform[p] = [];
    byPlatform[p].push(entry);
  }
  for (const [platform, entries] of Object.entries(byPlatform)) {
    const avgEng = entries.reduce((s, e) => s + (e.engagement || 0), 0) / entries.length;
    const avgViews = entries.reduce((s, e) => s + (e.views || 0), 0) / entries.length;
    patterns.platformStrength[platform] = {
      avgEngagement: Math.round(avgEng * 10) / 10,
      avgViews: Math.round(avgViews),
      count: entries.length,
    };
  }

  // Retention insights
  const lowRetention = performanceData.filter(e => (e.retentionAvg || 50) < 35);
  if (lowRetention.length > 0) {
    patterns.retentionInsights.push({
      issue: 'low_retention',
      count: lowRetention.length,
      avgRetention: Math.round(lowRetention.reduce((s, e) => s + (e.retentionAvg || 0), 0) / lowRetention.length),
      recommendation: 'Hooks are not holding. Test curiosity_gap and shocking_stat patterns.',
    });
  }

  return patterns;
}

// ─── DECISION GENERATOR ─────────────────────────────────────

function generateDecisions(patterns, currentStrategy = {}) {
  const decisions = [];

  // Scale winning topics
  for (const topic of patterns.topTopics) {
    decisions.push({
      id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: DecisionType.SCALE_TOPIC,
      confidence: topic.avgEngagement >= 70 ? Confidence.HIGH : Confidence.MEDIUM,
      target: topic.topic,
      action: `Increase variant count for "${topic.topic}" — avg engagement ${topic.avgEngagement}`,
      params: {
        topic: topic.topic,
        currentVariants: currentStrategy.maxVariants || 3,
        recommendedVariants: Math.min(5, (currentStrategy.maxVariants || 3) + 2),
        reason: `${topic.count} videos, ${topic.avgEngagement} avg engagement, ${topic.avgViews} avg views`,
      },
      createdAt: new Date().toISOString(),
      executed: false,
    });
  }

  // Kill underperforming topics
  for (const topic of patterns.deadTopics) {
    decisions.push({
      id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: DecisionType.KILL_TOPIC,
      confidence: topic.count >= 3 ? Confidence.HIGH : Confidence.MEDIUM,
      target: topic.topic,
      action: `Stop producing "${topic.topic}" — avg engagement ${topic.avgEngagement}`,
      params: {
        topic: topic.topic,
        reason: `${topic.count} videos produced, only ${topic.avgEngagement} avg engagement`,
      },
      createdAt: new Date().toISOString(),
      executed: false,
    });
  }

  // Hook pattern optimization
  const hookEntries = Object.entries(patterns.bestHookPatterns);
  if (hookEntries.length >= 2) {
    const sorted = hookEntries.sort(([, a], [, b]) => b.avgEngagement - a.avgEngagement);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    if (best[1].avgEngagement - worst[1].avgEngagement > 15) {
      decisions.push({
        id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: DecisionType.SHIFT_FORMAT,
        confidence: Confidence.MEDIUM,
        target: 'hook_pattern',
        action: `Favor "${best[0]}" hooks (${best[1].avgEngagement} avg) over "${worst[0]}" (${worst[1].avgEngagement} avg)`,
        params: {
          bestPattern: best[0],
          bestEngagement: best[1].avgEngagement,
          worstPattern: worst[0],
          worstEngagement: worst[1].avgEngagement,
        },
        createdAt: new Date().toISOString(),
        executed: false,
      });
    }
  }

  // Platform budget reallocation
  const platEntries = Object.entries(patterns.platformStrength);
  if (platEntries.length >= 2) {
    const sorted = platEntries.sort(([, a], [, b]) => b.avgEngagement - a.avgEngagement);
    const bestPlat = sorted[0];
    const worstPlat = sorted[sorted.length - 1];

    if (bestPlat[1].avgEngagement - worstPlat[1].avgEngagement > 20) {
      decisions.push({
        id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: DecisionType.BUDGET_REALLOC,
        confidence: Confidence.MEDIUM,
        target: 'platform_budget',
        action: `Shift resources to ${bestPlat[0]} (${bestPlat[1].avgEngagement} eng) from ${worstPlat[0]} (${worstPlat[1].avgEngagement} eng)`,
        params: {
          scalePlatform: bestPlat[0],
          reducePlatform: worstPlat[0],
        },
        createdAt: new Date().toISOString(),
        executed: false,
      });
    }
  }

  // Retention fix
  for (const insight of patterns.retentionInsights) {
    decisions.push({
      id: `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: DecisionType.SHIFT_FORMAT,
      confidence: Confidence.LOW,
      target: 'retention',
      action: insight.recommendation,
      params: { avgRetention: insight.avgRetention, affectedCount: insight.count },
      createdAt: new Date().toISOString(),
      executed: false,
    });
  }

  return decisions;
}

// ─── DECISION ENGINE ────────────────────────────────────────

class DecisionEngine {
  constructor() {
    this.decisions = [];
    this.executedCount = 0;
    this.patterns = null;
  }

  // Analyze performance data and generate decisions
  analyze(performanceData, currentStrategy = {}) {
    this.patterns = detectPatterns(performanceData);
    const newDecisions = generateDecisions(this.patterns, currentStrategy);
    this.decisions.push(...newDecisions);

    log.info('Analysis complete', {
      dataPoints: performanceData.length,
      topTopics: this.patterns.topTopics.length,
      deadTopics: this.patterns.deadTopics.length,
      decisionsGenerated: newDecisions.length,
    });

    return {
      patterns: this.patterns,
      decisions: newDecisions,
    };
  }

  // Get high-confidence decisions (auto-executable)
  getAutoExecutable() {
    return this.decisions.filter(d => d.confidence === Confidence.HIGH && !d.executed);
  }

  // Get decisions needing review
  getPendingReview() {
    return this.decisions.filter(d => d.confidence !== Confidence.HIGH && !d.executed);
  }

  // Mark decision as executed
  execute(decisionId) {
    const d = this.decisions.find(x => x.id === decisionId);
    if (d) {
      d.executed = true;
      d.executedAt = new Date().toISOString();
      this.executedCount++;
      log.info('Decision executed', { id: decisionId, type: d.type, target: d.target });
    }
    return d;
  }

  getStats() {
    return {
      totalDecisions: this.decisions.length,
      executed: this.executedCount,
      pending: this.decisions.filter(d => !d.executed).length,
      byType: this.decisions.reduce((acc, d) => { acc[d.type] = (acc[d.type] || 0) + 1; return acc; }, {}),
      byConfidence: this.decisions.reduce((acc, d) => { acc[d.confidence] = (acc[d.confidence] || 0) + 1; return acc; }, {}),
    };
  }

  clean() {
    this.decisions = [];
    this.executedCount = 0;
    this.patterns = null;
    log.info('DecisionEngine cleaned');
  }
}

const decisionEngine = new DecisionEngine();

module.exports = { DecisionEngine, decisionEngine, DecisionType, Confidence, detectPatterns, generateDecisions };
