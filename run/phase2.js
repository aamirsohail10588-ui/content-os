// ============================================================
// CONTENT OS — Phase 2 Test Runner
// USAGE: node run/phase2.js
// TESTS: Queue, workers, multi-variant, cost tracking, DLQ
// ============================================================

const { Orchestrator } = require('./orchestrator');
const { costController } = require('./costController');
const { dlq } = require('./deadLetterQueue');
const { checkpointManager } = require('./checkpointManager');
const { getRegistryStats } = require('./contentRegistry');

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  CONTENT OS — Phase 2 Test Suite');
  console.log('  Queue + Workers + Multi-Variant + Cost + DLQ');
  console.log('='.repeat(60) + '\n');

  // ─── TEST 1: Multi-Variant Generation ─────────────────────

  console.log('─'.repeat(50));
  console.log('TEST 1: Multi-Variant Generation (3 topics, 3 variants each)');
  console.log('─'.repeat(50));

  const orchestrator = new Orchestrator({ concurrency: 2, mode: 'variant' });

  const config = {
    niche: 'finance',
    subNiche: 'personal_finance',
    tone: 'authoritative_yet_accessible',
    targetDurationSeconds: 60,
    format: 'youtube_short',
    aiProvider: 'claude',
    maxVariants: 3,
  };

  const topics = [
    'Why compound interest is the most powerful force in finance',
    'The hidden fees killing your investment returns',
    'How the top 1% think differently about money',
  ];

  const batchResult = await orchestrator.runBatch(topics, config);

  console.log('\n  BATCH RESULTS:');
  console.log(`  Attempted: ${batchResult.stats.attempted}`);
  console.log(`  Succeeded: ${batchResult.stats.succeeded}`);
  console.log(`  Failed: ${batchResult.stats.failed}`);
  console.log(`  Total Time: ${batchResult.stats.totalTimeMs}ms`);
  console.log(`  Avg Per Topic: ${batchResult.stats.avgTimeMs}ms`);

  for (const r of batchResult.results) {
    if (r.success && r.best) {
      console.log(`\n  Topic: "${r.topic}"`);
      console.log(`    Best Score: ${r.best.qualityScore.overall}/100`);
      console.log(`    Hook: "${r.best.hook.text}"`);
      console.log(`    Pattern: ${r.best.hook.pattern}`);
      console.log(`    Variants: ${r.stats.valid}/${r.stats.attempted} valid`);
      console.log(`    Score Range: ${r.stats.scoreRange.min}-${r.stats.scoreRange.max}`);
    }
  }

  // ─── TEST 2: Cost Tracking ────────────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 2: Cost Tracking');
  console.log('─'.repeat(50));

  const costStats = costController.getStats();
  console.log(`  Total Cost: $${costStats.totalCostUSD}`);
  console.log(`  Total Videos: ${costStats.totalVideos}`);
  console.log(`  Avg Cost/Video: $${costStats.avgCostPerVideoUSD}`);
  console.log(`  By Service:`);
  for (const [service, cost] of Object.entries(costStats.byService)) {
    console.log(`    ${service}: $${Math.round(cost * 10000) / 10000}`);
  }
  console.log(`  Budget Status:`);
  console.log(`    Daily: ${costStats.budget.daily.percentUsed}% used ($${costStats.budget.daily.spent}/$${costStats.budget.daily.cap})`);
  console.log(`    Throttle: ${costStats.budget.throttleLevel}`);

  // Cost estimation
  const estimate = costController.estimateVideoCost(config);
  console.log(`  Cost Estimate Per Video: $${estimate.perVariant.total}`);
  console.log(`  Cost Estimate 3 Variants: $${estimate.allVariants.total}`);

  // ─── TEST 3: Quality Scoring Comparison ───────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 3: Quality Scoring Across Variants');
  console.log('─'.repeat(50));

  for (const r of batchResult.results) {
    if (r.success && r.variants) {
      console.log(`\n  Topic: "${r.topic}"`);
      for (const v of r.variants) {
        console.log(`    Variant ${v.variantIndex}: overall=${v.qualityScore.overall} hook=${v.qualityScore.hookStrength} pacing=${v.qualityScore.pacingConsistency} coherence=${v.qualityScore.scriptCoherence}`);
      }
    }
  }

  // ─── TEST 4: Checkpoint System ────────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 4: Checkpoint System');
  console.log('─'.repeat(50));

  const cpStats = checkpointManager.getStats();
  console.log(`  In Memory: ${cpStats.inMemory}`);
  console.log(`  On Disk: ${cpStats.onDisk}`);
  console.log(`  Active: ${checkpointManager.listActive().length}`);

  // Simulate checkpoint save + resume
  checkpointManager.save('test-job-1', 'script_generation', { hook: { text: 'test hook' }, script: { text: 'test script' } });
  const resume = checkpointManager.getResumePoint('test-job-1');
  console.log(`  Resume Test: resumeFrom=${resume.resumeFrom}, isResume=${resume.isResume}, skipped=${resume.skippedStages?.length || 0} stages`);
  checkpointManager.clear('test-job-1');

  // ─── TEST 5: DLQ Status ──────────────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 5: Dead Letter Queue');
  console.log('─'.repeat(50));

  const dlqStats = dlq.getStats();
  console.log(`  Total: ${dlqStats.total}`);
  console.log(`  Unresolved: ${dlqStats.unresolved}`);
  console.log(`  Auto-Retryable: ${dlqStats.autoRetryable}`);
  if (dlqStats.total > 0) {
    console.log(`  Categories:`, JSON.stringify(dlqStats.categoryBreakdown));
  }

  // ─── TEST 6: Registry Integrity ───────────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 6: Content Registry');
  console.log('─'.repeat(50));

  const regStats = getRegistryStats();
  console.log(`  Fingerprints: ${regStats.totalFingerprints}`);
  console.log(`  Unique Topics: ${regStats.uniqueTopics}`);
  console.log(`  Unique Hooks: ${regStats.uniqueHookPatterns}`);

  // ─── TEST 7: Queue-Based Processing ───────────────────────

  console.log('\n' + '─'.repeat(50));
  console.log('TEST 7: Queue-Based Single Processing');
  console.log('─'.repeat(50));

  const queueOrchestrator = new Orchestrator({ concurrency: 2, mode: 'single' });

  const queueTopics = [
    'Why most people fail at investing',
    'The 3 rules of building wealth',
  ];

  const queueResult = await queueOrchestrator.runBatch(queueTopics, config);
  console.log(`  Queue Mode: ${queueResult.stats.succeeded}/${queueResult.stats.attempted} succeeded`);
  console.log(`  Time: ${queueResult.stats.totalTimeMs}ms`);
  console.log(`  Queue Stats:`, JSON.stringify(queueResult.stats.cost.budget.daily));

  // ─── SUMMARY ──────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 2 SUMMARY');
  console.log('='.repeat(60));

  const finalCost = costController.getStats();
  const finalReg = getRegistryStats();
  const finalDlq = dlq.getStats();

  console.log(`  Total Videos Generated: ${finalCost.totalVideos}`);
  console.log(`  Total Cost: $${finalCost.totalCostUSD}`);
  console.log(`  Avg Cost/Video: $${finalCost.avgCostPerVideoUSD}`);
  console.log(`  Registry Fingerprints: ${finalReg.totalFingerprints}`);
  console.log(`  DLQ Entries: ${finalDlq.total}`);
  console.log(`  Budget Status: ${finalCost.budget.throttleLevel}`);
  console.log('='.repeat(60) + '\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
