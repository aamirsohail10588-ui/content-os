// ============================================================
// MODULE: modules/topicGenerator.ts
// PURPOSE: Generate and score topics from trend/manual inputs
// STATUS: ACTIVE
// ============================================================

import { createLogger } from '../infra/logger';
import { GeneratedTopic, Trend } from '../types';

const log = createLogger('TopicGenerator');

export interface TopicGenerationInput {
  trends?: Trend[];
  manualTopics?: string[];
  minScore?: number;
}

export interface TopicScoreBreakdown {
  topic: string;
  source: 'trend' | 'manual';
  trendVelocity: number;
  engagementPotential: number;
  novelty: number;
  score: number;
  accepted: boolean;
  rejectedReason?: 'LOW_SCORE' | 'LOW_TREND_LOW_SCORE' | 'HIGH_TREND_LOW_QUALITY';
}

export interface TopicGenerationResult {
  topics: GeneratedTopic[];
  scored: TopicScoreBreakdown[];
}

const DEFAULT_MIN_SCORE = 0.55;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function estimateEngagementPotential(topic: string): number {
  const text = topic.toLowerCase();
  const highIntent = ['crash', 'panic', 'secret', 'mistake', 'truth', 'warning', 'explained'];
  const hits = highIntent.filter(k => text.includes(k)).length;
  return clamp01(0.35 + hits * 0.12);
}

function estimateNovelty(topic: string): number {
  const text = topic.toLowerCase();
  const noveltyHints = ['2026', 'new', 'latest', 'vs', 'unexpected', 'hidden'];
  const hits = noveltyHints.filter(k => text.includes(k)).length;
  return clamp01(0.3 + hits * 0.14);
}

function scoreTopic(topic: string, source: 'trend' | 'manual', trendVelocity: number, minScore: number): TopicScoreBreakdown {
  const engagementPotential = estimateEngagementPotential(topic);
  const novelty = estimateNovelty(topic);
  const velocity = clamp01(trendVelocity);
  const score = Math.round((velocity + engagementPotential + novelty) / 3 * 100) / 100;

  let accepted = score >= minScore;
  let rejectedReason: TopicScoreBreakdown['rejectedReason'];

  if (!accepted && velocity < 0.4) {
    rejectedReason = 'LOW_TREND_LOW_SCORE';
  } else if (velocity >= 0.75 && (engagementPotential < 0.4 || novelty < 0.35)) {
    accepted = false;
    rejectedReason = 'HIGH_TREND_LOW_QUALITY';
  } else if (!accepted) {
    rejectedReason = 'LOW_SCORE';
  }

  return {
    topic,
    source,
    trendVelocity: velocity,
    engagementPotential,
    novelty,
    score,
    accepted,
    rejectedReason,
  };
}

export function generateTopics(input: TopicGenerationInput = {}): TopicGenerationResult {
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const trendTopics = (input.trends ?? []).map(t => ({
    topic: t.topic,
    source: 'trend' as const,
    trendVelocity: t.velocity,
  }));
  const manualTopics = (input.manualTopics ?? []).map(topic => ({
    topic,
    source: 'manual' as const,
    trendVelocity: 0.5,
  }));

  const seen = new Set<string>();
  const scored: TopicScoreBreakdown[] = [];

  for (const candidate of [...trendTopics, ...manualTopics]) {
    const key = candidate.topic.trim().toLowerCase();
    if (!candidate.topic.trim() || seen.has(key)) continue;
    seen.add(key);

    scored.push(scoreTopic(candidate.topic, candidate.source, candidate.trendVelocity, minScore));
  }

  const topics: GeneratedTopic[] = scored
    .filter(t => t.accepted)
    .sort((a, b) => b.score - a.score)
    .map(t => ({ topic: t.topic, source: t.source, score: t.score }));

  log.info('Topic generation complete', {
    candidates: scored.length,
    accepted: topics.length,
    rejected: scored.length - topics.length,
  });

  return { topics, scored };
}
