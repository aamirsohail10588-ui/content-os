// ============================================================
// MODULE: modules/trendScanner.ts
// PURPOSE: Trend Intelligence layer — detect and prioritize demand signals
// STATUS: ACTIVE (mock-first, API-ready)
// ============================================================

import { createLogger } from '../infra/logger';
import { Trend } from '../types';

const log = createLogger('TrendScanner');

export interface TrendScanInput {
  platformPriority?: Array<'youtube' | 'instagram'>;
  manualTopics?: string[];
}

export interface TrendScanResult {
  scannedAt: string;
  trends: Trend[];
  sourceBreakdown: {
    youtube: number;
    instagram: number;
    manual: number;
  };
}

const MOCK_TRENDS: Trend[] = [
  {
    topic: 'bitcoin crash panic india investors',
    platform: 'youtube',
    velocity: 0.87,
    category: 'finance',
  },
  {
    topic: 'nvidia ai chips shortage explained',
    platform: 'youtube',
    velocity: 0.81,
    category: 'tech',
  },
  {
    topic: 'reels viral audio salary day trend',
    platform: 'instagram',
    velocity: 0.76,
    category: 'business',
  },
  {
    topic: 'oil prices impact middle class 2026',
    platform: 'youtube',
    velocity: 0.72,
    category: 'economy',
  },
  {
    topic: 'ai layoffs vs new jobs debate',
    platform: 'instagram',
    velocity: 0.68,
    category: 'jobs',
  },
];

function normalizeVelocity(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function toTrend(topic: string): Trend {
  return {
    topic,
    platform: 'youtube',
    velocity: 0.45,
    category: 'general',
  };
}

function uniqueByTopic(trends: Trend[]): Trend[] {
  const seen = new Set<string>();
  const unique: Trend[] = [];

  for (const t of trends) {
    const key = t.topic.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...t, velocity: normalizeVelocity(t.velocity) });
  }

  return unique;
}

export async function scanTrends(input: TrendScanInput = {}): Promise<TrendScanResult> {
  const priority = input.platformPriority ?? ['youtube', 'instagram'];
  const manual = (input.manualTopics ?? []).map(toTrend);

  const prioritized = uniqueByTopic([...MOCK_TRENDS, ...manual])
    .filter(t => priority.includes(t.platform))
    .sort((a, b) => b.velocity - a.velocity);

  const result: TrendScanResult = {
    scannedAt: new Date().toISOString(),
    trends: prioritized,
    sourceBreakdown: {
      youtube: prioritized.filter(t => t.platform === 'youtube').length,
      instagram: prioritized.filter(t => t.platform === 'instagram').length,
      manual: manual.length,
    },
  };

  log.info('Trend scan complete', {
    scanned: result.trends.length,
    youtube: result.sourceBreakdown.youtube,
    instagram: result.sourceBreakdown.instagram,
    manual: result.sourceBreakdown.manual,
  });

  return result;
}
