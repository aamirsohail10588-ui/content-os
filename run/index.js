// ============================================================
// CONTENT OS — Phase 1 Pipeline Runner
// USAGE: node run/index.js
// ============================================================

const { generateVideo } = require('./pipeline');
const { getRegistryStats } = require('./contentRegistry');
const { SYSTEM_CONFIG } = require('./config');

const FINANCE_TOPICS = [
  'Why compound interest is the most powerful force in finance',
  'The hidden fees killing your investment returns',
  'How the top 1% think differently about money',
  'Why your savings account is losing you money every day',
  'The one investment strategy that beats 90% of fund managers',
  'How to build wealth on a middle-class salary',
  'The psychology behind why most people stay broke',
  'Index funds vs individual stocks — the data is clear',
  'Why paying off debt fast might be the wrong move',
  'The tax strategies the wealthy use that you probably don\'t',
];

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  CONTENT OS — Phase 1 Pipeline');
  console.log('  Version:', SYSTEM_CONFIG.version);
  console.log('  Environment:', SYSTEM_CONFIG.environment);
  console.log('  Mocks:', SYSTEM_CONFIG.useMocks ? 'ENABLED' : 'DISABLED');
  console.log('='.repeat(60) + '\n');

  const config = {
    niche: 'finance',
    subNiche: 'personal_finance',
    tone: 'authoritative_yet_accessible',
    targetDurationSeconds: 60,
    format: 'youtube_short',
    aiProvider: 'claude',
    maxVariants: 3,
  };

  const topicsToGenerate = FINANCE_TOPICS.slice(0, 3);
  console.log(`Generating ${topicsToGenerate.length} videos...\n`);

  const results = [];

  for (let i = 0; i < topicsToGenerate.length; i++) {
    const topic = topicsToGenerate[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Video ${i + 1}/${topicsToGenerate.length}: ${topic}`);
    console.log('─'.repeat(50));

    const result = await generateVideo(topic, config);
    results.push(result);

    if (result.success) {
      console.log(`\n  ✅ SUCCESS`);
      console.log(`  Hook: "${result.hook?.text}"`);
      console.log(`  Pattern: ${result.hook?.pattern}`);
      console.log(`  Hook Score: ${result.hook?.strengthScore}/100`);
      console.log(`  Script Duration: ${result.script?.totalDurationSeconds}s`);
      console.log(`  Script Segments: ${result.script?.segments.length}`);
      console.log(`  Script Words: ${result.script?.wordCount}`);
      console.log(`  Output: ${result.video?.outputPath}`);
      console.log(`  Pipeline Time: ${result.totalTimeMs}ms`);
    } else {
      console.log(`\n  ❌ FAILED`);
      console.log(`  Stage: ${result.error?.stage}`);
      console.log(`  Error: ${result.error?.message}`);
      console.log(`  Retryable: ${result.error?.retryable}`);
    }
  }

  // Summary
  const stats = getRegistryStats();
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const avgTime = Math.round(results.reduce((sum, r) => sum + r.totalTimeMs, 0) / results.length);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  PIPELINE SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Total Videos: ${results.length}`);
  console.log(`  Successful: ${successCount}`);
  console.log(`  Failed: ${failCount}`);
  console.log(`  Avg Pipeline Time: ${avgTime}ms`);
  console.log(`  Registry — Fingerprints: ${stats.totalFingerprints}`);
  console.log(`  Registry — Unique Topics: ${stats.uniqueTopics}`);
  console.log(`  Registry — Unique Hooks: ${stats.uniqueHookPatterns}`);
  console.log('='.repeat(60) + '\n');

  // Dedup test
  if (successCount > 0) {
    console.log('─'.repeat(50));
    console.log('DEDUP TEST: Re-running first topic to verify registry...');
    console.log('─'.repeat(50));

    const dupResult = await generateVideo(topicsToGenerate[0], config);
    if (dupResult.success) {
      console.log('  Result: Generated (mock variance — no exact duplicate)');
    } else if (dupResult.error?.code === 'DUPLICATE_CONTENT') {
      console.log('  Result: ✅ BLOCKED as duplicate — registry working');
    } else {
      console.log(`  Result: Failed — ${dupResult.error?.message}`);
    }
  }

  // Duration test
  console.log('\n─'.repeat(25));
  console.log('DURATION TEST: Generating at different durations...');
  console.log('─'.repeat(50));

  for (const duration of [30, 60, 90]) {
    const testConfig = { ...config, targetDurationSeconds: duration };
    const result = await generateVideo('How to start investing with just $100', testConfig);
    if (result.success) {
      console.log(`  ${duration}s target → ${result.script?.totalDurationSeconds}s actual | ${result.script?.segments.length} segments | ${result.script?.wordCount} words`);
    }
  }

  console.log('\nPhase 1 pipeline test complete.\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
