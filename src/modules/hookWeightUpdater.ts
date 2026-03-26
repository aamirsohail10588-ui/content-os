// ============================================================
// MODULE: modules/hookWeightUpdater.ts
// PURPOSE: Compute and persist hook pattern weights from performance data
// ============================================================

import { pool } from '../infra/db';
import { createLogger } from '../infra/logger';

const log = createLogger('HookWeightUpdater');

interface PatternAggregate {
  hook_pattern: string;
  mean_views: number;
  sample_count: number;
}

/**
 * Query performance_store, compute mean views_24h per hook pattern,
 * normalize into weights, and upsert into hook_weights table.
 */
export async function runWeightUpdate(): Promise<void> {
  log.info('Starting hook weight update');

  // 1. Query performance_store grouped by hook_pattern where views_24h > 0
  const aggResult = await pool.query<PatternAggregate>(
    `SELECT hook_pattern,
            AVG(views_24h)::FLOAT AS mean_views,
            COUNT(*)::INTEGER AS sample_count
     FROM performance_store
     WHERE views_24h > 0
     GROUP BY hook_pattern`
  );

  if (aggResult.rows.length === 0) {
    log.info('No performance data with views_24h > 0 — skipping weight update');
    return;
  }

  // 2. Compute global mean across all patterns
  const globalMean =
    aggResult.rows.reduce((sum, row) => sum + row.mean_views, 0) / aggResult.rows.length;

  if (globalMean === 0) {
    log.warn('Global mean views_24h is 0 — skipping weight update');
    return;
  }

  // 3. Normalize: weight = pattern_mean / global_mean
  const weights = aggResult.rows.map(row => ({
    hook_pattern: row.hook_pattern,
    weight: row.mean_views / globalMean,
    sample_count: row.sample_count,
  }));

  // 4. Upsert into hook_weights
  for (const w of weights) {
    await pool.query(
      `INSERT INTO hook_weights (hook_pattern, weight, sample_count, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (hook_pattern) DO UPDATE
         SET weight = EXCLUDED.weight,
             sample_count = EXCLUDED.sample_count,
             updated_at = now()`,
      [w.hook_pattern, w.weight, w.sample_count]
    );
  }

  // 5. Log results
  log.info('Hook weight update complete', { patterns: weights.length, globalMean });
  for (const w of weights.sort((a, b) => b.weight - a.weight)) {
    log.info(`  ${w.hook_pattern.padEnd(20)} weight=${w.weight.toFixed(3)}  samples=${w.sample_count}`);
    console.log(`  ${w.hook_pattern.padEnd(20)} weight=${w.weight.toFixed(3)}  samples=${w.sample_count}`);
  }
}

/**
 * Returns weight map from hook_weights table.
 * Falls back to all-1.0 weights if the table is empty.
 */
export async function getHookWeights(): Promise<Record<string, number>> {
  const result = await pool.query<{ hook_pattern: string; weight: number }>(
    'SELECT hook_pattern, weight FROM hook_weights'
  );

  if (result.rows.length === 0) {
    log.debug('hook_weights table is empty — using default weight 1.0 for all patterns');
    return {};
  }

  const weights: Record<string, number> = {};
  for (const row of result.rows) {
    weights[row.hook_pattern] = row.weight;
  }
  return weights;
}
