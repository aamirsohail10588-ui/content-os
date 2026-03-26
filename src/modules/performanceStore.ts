// ============================================================
// MODULE: modules/performanceStore.ts
// PURPOSE: Record and update video performance metrics
// ============================================================

import { pool } from '../infra/db';
import { createLogger } from '../infra/logger';

const log = createLogger('PerformanceStore');

export interface RecordPublishedVideoParams {
  videoId: number;
  hookPattern: string;
  hookScore: number;
  topic: string;
  platform: string;
  publishedAt: Date;
}

/**
 * Insert a new row into performance_store after a video is successfully published.
 * views_24h and views_72h start at 0; watch_percent is null.
 * TODO Phase B: poll platform APIs to fill views_24h, views_72h
 */
export async function recordPublishedVideo(params: RecordPublishedVideoParams): Promise<void> {
  const { videoId, hookPattern, hookScore, topic, platform, publishedAt } = params;
  try {
    await pool.query(
      `INSERT INTO performance_store
         (video_id, hook_pattern, hook_score, topic, platform, views_24h, views_72h, watch_percent, published_at)
       VALUES ($1, $2, $3, $4, $5, 0, 0, NULL, $6)`,
      [videoId, hookPattern, hookScore, topic, platform, publishedAt]
    );
    log.info('Performance record created', { videoId, hookPattern, platform });
  } catch (err) {
    log.error('Failed to record published video', { videoId, error: (err as Error).message });
  }
}

/**
 * Update metrics for an existing performance_store row by videoId.
 * TODO Phase B: poll platform APIs to fill views_24h, views_72h
 */
export async function updateVideoMetrics(
  videoId: number,
  metrics: { views_24h?: number; views_72h?: number; watch_percent?: number }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (metrics.views_24h !== undefined) { sets.push(`views_24h = $${idx++}`); values.push(metrics.views_24h); }
  if (metrics.views_72h !== undefined) { sets.push(`views_72h = $${idx++}`); values.push(metrics.views_72h); }
  if (metrics.watch_percent !== undefined) { sets.push(`watch_percent = $${idx++}`); values.push(metrics.watch_percent); }

  if (sets.length === 0) return;

  values.push(videoId);
  try {
    await pool.query(
      `UPDATE performance_store SET ${sets.join(', ')} WHERE video_id = $${idx}`,
      values
    );
    log.info('Performance metrics updated', { videoId, metrics });
  } catch (err) {
    log.error('Failed to update video metrics', { videoId, error: (err as Error).message });
  }
}
