// ============================================================
// MODULE: evolutionEngine.js
// PURPOSE: Self-improving content strategy — learn from results, evolve templates
// PHASE: 4
// STATUS: ACTIVE
// FLOW: decisions + performance → update weights → evolve hook/script templates →
//       store learned patterns → apply to next generation cycle
// ============================================================

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('EvolutionEngine');

const MEMORY_PATH = '/tmp/content-os/pattern-memory.json';

// ─── PATTERN MEMORY ─────────────────────────────────────────

class PatternMemory {
  constructor() {
    this.hookWeights = {};      // hookPattern -> weight (0-1)
    this.topicScores = {};      // topic -> { score, count, trend }
    this.platformWeights = {};  // platform -> weight
    this.timingWeights = {};    // hour -> weight
    this.formatRules = [];      // learned formatting rules
    this.generation = 0;        // evolution generation counter
    this.lastEvolved = null;

    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(MEMORY_PATH)) {
        const data = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
        Object.assign(this, data);
        log.info('Pattern memory loaded', { generation: this.generation, topics: Object.keys(this.topicScores).length });
      }
    } catch (e) {
      log.warn('Could not load pattern memory, starting fresh');
    }
  }

  save() {
    try {
      const dir = path.dirname(MEMORY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MEMORY_PATH, JSON.stringify({
        hookWeights: this.hookWeights,
        topicScores: this.topicScores,
        platformWeights: this.platformWeights,
        timingWeights: this.timingWeights,
        formatRules: this.formatRules,
        generation: this.generation,
        lastEvolved: this.lastEvolved,
      }, null, 2));
    } catch (e) {
      log.warn('Could not save pattern memory', { error: e.message });
    }
  }
}

// ─── WEIGHT EVOLVER ─────────────────────────────────────────

function evolveWeights(currentWeights, performanceMap, learningRate = 0.1) {
  // performanceMap = { key: score (0-100) }
  // Adjusts weights toward high-performing keys using exponential smoothing
  const evolved = { ...currentWeights };

  for (const [key, score] of Object.entries(performanceMap)) {
    const normalizedScore = score / 100; // 0-1
    const currentWeight = evolved[key] || 0.5; // default neutral
    evolved[key] = currentWeight + learningRate * (normalizedScore - currentWeight);
    evolved[key] = Math.max(0.05, Math.min(0.95, evolved[key])); // clamp
  }

  return evolved;
}

// ─── TOPIC SCORE TRACKER ────────────────────────────────────

function updateTopicScores(existing, newData) {
  // newData = [{ topic, engagement, views }]
  const updated = { ...existing };

  for (const entry of newData) {
    const topic = entry.topic;
    if (!updated[topic]) {
      updated[topic] = { score: 0, count: 0, trend: 'new', history: [] };
    }

    const t = updated[topic];
    const newScore = (entry.engagement || 0) * 0.6 + Math.min(100, (entry.views || 0) / 500) * 0.4;

    t.history.push(newScore);
    if (t.history.length > 10) t.history.shift(); // keep last 10

    t.count++;
    // Exponential moving average
    t.score = t.score === 0 ? newScore : t.score * 0.7 + newScore * 0.3;
    t.score = Math.round(t.score * 10) / 10;

    // Trend detection
    if (t.history.length >= 3) {
      const recent = t.history.slice(-3);
      const isGrowing = recent[2] > recent[1] && recent[1] > recent[0];
      const isDeclining = recent[2] < recent[1] && recent[1] < recent[0];
      t.trend = isGrowing ? 'growing' : isDeclining ? 'declining' : 'stable';
    }
  }

  return updated;
}

// ─── TEMPLATE EVOLVER ───────────────────────────────────────

function evolveFormatRules(existingRules, performanceData) {
  const rules = [...existingRules];

  // Detect optimal video duration
  const durationBuckets = {};
  for (const entry of performanceData) {
    const bucket = Math.round((entry.duration || 60) / 15) * 15; // 15s buckets
    if (!durationBuckets[bucket]) durationBuckets[bucket] = [];
    durationBuckets[bucket].push(entry.engagement || 0);
  }

  let bestDuration = 60;
  let bestDurationScore = 0;
  for (const [duration, scores] of Object.entries(durationBuckets)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestDurationScore) {
      bestDurationScore = avg;
      bestDuration = parseInt(duration);
    }
  }

  // Only add rule if we have enough data and it's different from default
  if (Object.keys(durationBuckets).length >= 2 && bestDuration !== 60) {
    const existingDurationRule = rules.findIndex(r => r.type === 'optimal_duration');
    const rule = {
      type: 'optimal_duration',
      value: bestDuration,
      confidence: Math.min(performanceData.length / 20, 1), // higher with more data
      learnedAt: new Date().toISOString(),
      reason: `${bestDuration}s videos averaged ${Math.round(bestDurationScore)} engagement`,
    };
    if (existingDurationRule >= 0) {
      rules[existingDurationRule] = rule;
    } else {
      rules.push(rule);
    }
  }

  // Detect CTA effectiveness
  const withCTA = performanceData.filter(e => e.hasCTA);
  const withoutCTA = performanceData.filter(e => !e.hasCTA);
  if (withCTA.length >= 3 && withoutCTA.length >= 3) {
    const ctaAvg = withCTA.reduce((s, e) => s + (e.engagement || 0), 0) / withCTA.length;
    const noCTAAvg = withoutCTA.reduce((s, e) => s + (e.engagement || 0), 0) / withoutCTA.length;
    const existingCTARule = rules.findIndex(r => r.type === 'cta_strategy');
    const rule = {
      type: 'cta_strategy',
      value: ctaAvg > noCTAAvg ? 'always_include' : 'optional',
      confidence: Math.abs(ctaAvg - noCTAAvg) / 50,
      learnedAt: new Date().toISOString(),
      reason: `CTA avg: ${Math.round(ctaAvg)}, No CTA avg: ${Math.round(noCTAAvg)}`,
    };
    if (existingCTARule >= 0) rules[existingCTARule] = rule;
    else rules.push(rule);
  }

  return rules;
}

// ─── EVOLUTION ENGINE ───────────────────────────────────────

class EvolutionEngine {
  constructor() {
    this.memory = new PatternMemory();
    this.evolutionLog = [];
  }

  // Run one evolution cycle
  evolve(performanceData, decisions = []) {
    const startTime = Date.now();
    this.memory.generation++;

    log.info('Evolution cycle starting', {
      generation: this.memory.generation,
      dataPoints: performanceData.length,
      decisions: decisions.length,
    });

    // 1. Evolve hook weights
    const hookPerformance = {};
    for (const entry of performanceData) {
      const hook = entry.hookPattern || 'unknown';
      if (!hookPerformance[hook]) hookPerformance[hook] = [];
      hookPerformance[hook].push(entry.engagement || 0);
    }
    const hookAvgs = {};
    for (const [hook, scores] of Object.entries(hookPerformance)) {
      hookAvgs[hook] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    this.memory.hookWeights = evolveWeights(this.memory.hookWeights, hookAvgs);

    // 2. Evolve platform weights
    const platPerformance = {};
    for (const entry of performanceData) {
      const p = entry.platform || 'unknown';
      if (!platPerformance[p]) platPerformance[p] = [];
      platPerformance[p].push(entry.engagement || 0);
    }
    const platAvgs = {};
    for (const [p, scores] of Object.entries(platPerformance)) {
      platAvgs[p] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    this.memory.platformWeights = evolveWeights(this.memory.platformWeights, platAvgs);

    // 3. Update topic scores
    this.memory.topicScores = updateTopicScores(this.memory.topicScores, performanceData);

    // 4. Evolve format rules
    this.memory.formatRules = evolveFormatRules(this.memory.formatRules, performanceData);

    // 5. Apply decisions
    for (const decision of decisions.filter(d => d.executed)) {
      if (decision.type === 'kill_topic' && decision.params?.topic) {
        const topic = this.memory.topicScores[decision.params.topic];
        if (topic) topic.trend = 'killed';
      }
    }

    this.memory.lastEvolved = new Date().toISOString();
    this.memory.save();

    const elapsed = Date.now() - startTime;

    const result = {
      generation: this.memory.generation,
      hookWeights: this.memory.hookWeights,
      platformWeights: this.memory.platformWeights,
      topTopics: Object.entries(this.memory.topicScores)
        .filter(([, v]) => v.trend !== 'killed')
        .sort(([, a], [, b]) => b.score - a.score)
        .slice(0, 5)
        .map(([topic, data]) => ({ topic, score: data.score, trend: data.trend })),
      formatRules: this.memory.formatRules,
      elapsed,
    };

    this.evolutionLog.push({
      generation: this.memory.generation,
      timestamp: this.memory.lastEvolved,
      dataPoints: performanceData.length,
      elapsed,
    });

    log.info('Evolution cycle complete', {
      generation: this.memory.generation,
      hookPatterns: Object.keys(this.memory.hookWeights).length,
      trackedTopics: Object.keys(this.memory.topicScores).length,
      rules: this.memory.formatRules.length,
      elapsed,
    });

    return result;
  }

  // Get recommended config for next generation
  getRecommendedConfig() {
    const config = {
      preferredHookPatterns: Object.entries(this.memory.hookWeights)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([pattern, weight]) => ({ pattern, weight: Math.round(weight * 100) / 100 })),
      avoidTopics: Object.entries(this.memory.topicScores)
        .filter(([, v]) => v.trend === 'killed' || v.trend === 'declining')
        .map(([topic]) => topic),
      preferredPlatforms: Object.entries(this.memory.platformWeights)
        .sort(([, a], [, b]) => b - a)
        .map(([platform, weight]) => ({ platform, weight: Math.round(weight * 100) / 100 })),
      formatRules: this.memory.formatRules,
      generation: this.memory.generation,
    };

    return config;
  }

  getStats() {
    return {
      generation: this.memory.generation,
      lastEvolved: this.memory.lastEvolved,
      hookPatterns: Object.keys(this.memory.hookWeights).length,
      trackedTopics: Object.keys(this.memory.topicScores).length,
      platformsTracked: Object.keys(this.memory.platformWeights).length,
      formatRules: this.memory.formatRules.length,
      evolutionCycles: this.evolutionLog.length,
    };
  }

  clean() {
    this.memory = new PatternMemory();
    this.evolutionLog = [];
    log.info('EvolutionEngine cleaned');
  }
}

const evolutionEngine = new EvolutionEngine();

module.exports = { EvolutionEngine, evolutionEngine, evolveWeights, updateTopicScores };
