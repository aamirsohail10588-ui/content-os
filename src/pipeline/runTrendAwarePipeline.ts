// ============================================================
// MODULE: pipeline/runTrendAwarePipeline.ts
// PURPOSE: Trend-aware entrypoint for Content-OS end-to-end loop
// STATUS: ACTIVE
// ============================================================

import { ContentConfig, GeneratedTopic, PerformanceSignal, PipelineResult } from '../types';
import { createLogger } from '../infra/logger';
import { scanTrends } from '../modules/trendScanner';
import { generateTopics } from '../modules/topicGenerator';
import { generateVideo } from './generateVideo';

const log = createLogger('TrendAwarePipeline');

export interface TrendAwareInput {
  manualTopics?: string[];
  topicLimit?: number;
  minTopicScore?: number;
}

export interface TopicRunResult {
  generatedTopic: GeneratedTopic;
  pipelineResult: PipelineResult;
  performance: PerformanceSignal;
}

export interface TrendAwareRunResult {
  scannedAt: string;
  selectedTopics: GeneratedTopic[];
  rejectedTopics: number;
  results: TopicRunResult[];
  failurePatterns: string[];
  adjustments: string[];
}

function mockPerformance(success: boolean): PerformanceSignal {
  if (!success) {
    return { retention: 0.24, avgWatchTime: 12.4, trendMatchScore: 0.18 };
  }

  return {
    retention: Math.round((0.42 + Math.random() * 0.35) * 100) / 100,
    avgWatchTime: Math.round((26 + Math.random() * 21) * 10) / 10,
    trendMatchScore: Math.round((0.55 + Math.random() * 0.4) * 100) / 100,
  };
}

function analyzeFailures(results: TopicRunResult[]): string[] {
  return results
    .filter(r => !r.pipelineResult.success)
    .map(r => `${r.generatedTopic.topic}: ${r.pipelineResult.error?.code ?? 'UNKNOWN_ERROR'}`);
}

function recommendAdjustments(results: TopicRunResult[]): string[] {
  if (results.length === 0) {
    return ['No topics generated. Lower minTopicScore or add manual topics.'];
  }

  const lowTrendMatch = results.filter(r => r.performance.trendMatchScore < 0.4).length;
  const lowRetention = results.filter(r => r.performance.retention < 0.35).length;

  const adjustments: string[] = [];

  if (lowTrendMatch > 0) {
    adjustments.push('Increase trend-weight in hook selection and script framing.');
  }
  if (lowRetention > 0) {
    adjustments.push('Tighten first 3 seconds and reduce script verbosity.');
  }
  if (adjustments.length === 0) {
    adjustments.push('Current strategy healthy. Scale top scoring topics.');
  }

  return adjustments;
}

export async function runTrendAwarePipeline(
  config: ContentConfig,
  input: TrendAwareInput = {}
): Promise<TrendAwareRunResult> {
  const trendScan = await scanTrends({ manualTopics: input.manualTopics });
  const generated = generateTopics({
    trends: trendScan.trends,
    manualTopics: input.manualTopics,
    minScore: input.minTopicScore,
  });

  const topicLimit = input.topicLimit ?? 3;
  const selectedTopics = generated.topics.slice(0, topicLimit);
  const results: TopicRunResult[] = [];

  for (const generatedTopic of selectedTopics) {
    log.info('Running full pipeline for generated topic', {
      topic: generatedTopic.topic,
      score: generatedTopic.score,
      source: generatedTopic.source,
    });

    const pipelineResult = await generateVideo(generatedTopic.topic, config);
    const performance = mockPerformance(pipelineResult.success);

    results.push({ generatedTopic, pipelineResult, performance });
  }

  const failurePatterns = analyzeFailures(results);
  const adjustments = recommendAdjustments(results);

  log.info('Trend-aware run completed', {
    selected: selectedTopics.length,
    failed: failurePatterns.length,
    adjustments: adjustments.length,
  });

  return {
    scannedAt: trendScan.scannedAt,
    selectedTopics,
    rejectedTopics: generated.scored.filter(t => !t.accepted).length,
    results,
    failurePatterns,
    adjustments,
  };
}
