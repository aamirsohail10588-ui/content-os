// ============================================================
// MODULE: index.ts
// PURPOSE: CLI entry point — Phase 1–4 system demo
// PHASE: 1–4
// STATUS: ACTIVE
// USAGE: npx ts-node src/index.ts
// ============================================================

import 'dotenv/config';
import { generateVideo } from './pipeline/generateVideo';
import { getRegistryStats } from './registry/contentRegistry';
import { ContentConfig, VideoFormat } from './types';
import { SYSTEM_CONFIG } from './config';
import { createLogger } from './infra/logger';

// Phase 4 engines — singletons from core/engines.ts
import { decisionEngine, evolutionEngine, experimentEngine, portfolioEngine, HOOK_AB_EXPERIMENT } from './core/engines';
import { PerformanceEntry } from './modules/decisionEngine';
import { PerformanceData } from './modules/evolutionEngine';
import { AllocationStrategy } from './modules/portfolioEngine';

const log = createLogger('Main');

// ─── FINANCE TOPICS ─────────────────────────────────────────

const FINANCE_TOPICS = [
  'Why compound interest is the most powerful force in finance',
  'The hidden fees killing your investment returns',
  'How the top 1% think differently about money',
  'Why your savings account is losing you money every day',
  'The one investment strategy that beats 90% of fund managers',
];

// ─── HELPERS ────────────────────────────────────────────────

function sep(char = '─', len = 50) { return char.repeat(len); }
function header(title: string) { console.log(`\n${sep('═', 60)}\n  ${title}\n${sep('═', 60)}`); }
function section(title: string) { console.log(`\n${sep()}  ${title}\n${sep()}`); }

// ─── MAIN ────────────────────────────────────────────────────

async function main(): Promise<void> {
  header(`CONTENT OS — Full System (Phase 1–4)\n  Version: ${SYSTEM_CONFIG.version}  |  Env: ${SYSTEM_CONFIG.environment}  |  Mocks: ${SYSTEM_CONFIG.useMocks ? 'ON' : 'OFF'}`);

  const config: ContentConfig = {
    niche: 'finance',
    subNiche: 'personal_finance',
    tone: 'authoritative_yet_accessible',
    targetDurationSeconds: 60,
    format: VideoFormat.YOUTUBE_SHORT,
    aiProvider: 'claude',
    maxVariants: 3,
  };

  // ══════════════════════════════════════════════════════════
  // PHASE 1–2: GENERATE VIDEOS
  // ══════════════════════════════════════════════════════════

  header('PHASE 1–2: Content Pipeline');
  console.log(`\nGenerating ${FINANCE_TOPICS.length} videos...\n`);

  const pipelineResults = [];
  for (let i = 0; i < FINANCE_TOPICS.length; i++) {
    const topic = FINANCE_TOPICS[i];
    console.log(`\nVideo ${i + 1}/${FINANCE_TOPICS.length}: ${topic}`);
    const result = await generateVideo(topic, config);
    pipelineResults.push({ topic, result });
    if (result.success) {
      console.log(`  ✓ Hook: "${result.hook?.text}"`);
      console.log(`  ✓ Pattern: ${result.hook?.pattern} (score: ${result.hook?.strengthScore})`);
      console.log(`  ✓ Script: ${result.script?.segments.length} segments, ${result.script?.totalDurationSeconds}s, ${result.script?.wordCount} words`);
      console.log(`  ✓ Output: ${result.video?.outputPath}`);
      console.log(`  ✓ Time: ${result.totalTimeMs}ms`);
    } else {
      console.log(`  ✗ FAILED [${result.error?.stage}]: ${result.error?.message}`);
    }
  }

  const successCount = pipelineResults.filter(r => r.result.success).length;
  const registryStats = getRegistryStats();
  section('Pipeline Summary');
  console.log(`  Videos: ${successCount}/${pipelineResults.length} succeeded`);
  console.log(`  Registry: ${registryStats.totalFingerprints} fingerprints, ${registryStats.uniqueTopics} topics, ${registryStats.uniqueHookPatterns} hook patterns`);

  // ══════════════════════════════════════════════════════════
  // PHASE 4A: EXPERIMENT ENGINE (A/B TESTING)
  // ══════════════════════════════════════════════════════════

  header('PHASE 4A: A/B Experiment Engine');

  // The experiment is already wired to real pipeline events via core/engines.ts
  // Just report the current state from the live experiment
  const expResult = HOOK_AB_EXPERIMENT.evaluate();
  const expReport = HOOK_AB_EXPERIMENT.getReport();
  console.log(`\n  Live experiment: "${expReport.name}"`);
  console.log(`  Status: ${expReport.status}`);
  for (const v of expReport.variants) {
    console.log(`  Variant "${v.label}": ${v.engagementRate} eng rate | CI [${v.ci.lower.toFixed(3)}, ${v.ci.upper.toFixed(3)}]`);
  }
  if (expResult.winner) {
    console.log(`\n  ✓ WINNER: "${expResult.winner.label}"`);
    console.log(`  z-stat: ${expResult.test?.zStat} | p-value: ${expResult.test?.pValue} | significant: ${expResult.test?.significant}`);
  } else {
    console.log(`\n  No winner yet: ${expResult.reason ?? expResult.status}`);
  }

  const expStats = experimentEngine.getStats();
  console.log(`\n  Engine stats: ${expStats.total} experiments | ${expStats.running} running | ${expStats.concluded} concluded`);

  // ══════════════════════════════════════════════════════════
  // PHASE 4B: DECISION ENGINE
  // ══════════════════════════════════════════════════════════

  header('PHASE 4B: Decision Engine');

  const mockPlatforms = ['youtube', 'instagram', 'tiktok'];
  const mockPatterns = ['shocking_stat', 'curiosity_gap', 'contrarian', 'bold_claim', 'story_open'];
  const performanceEntries: PerformanceEntry[] = [];

  for (let i = 0; i < 20; i++) {
    const hookPattern = mockPatterns[i % mockPatterns.length];
    const platform = mockPlatforms[i % mockPlatforms.length];
    const engagement = hookPattern === 'shocking_stat' ? 0.65 + Math.random() * 0.2
                     : hookPattern === 'curiosity_gap'  ? 0.55 + Math.random() * 0.2
                     : 0.2 + Math.random() * 0.25;
    performanceEntries.push({
      videoId: `vid_${i}`,
      topic: FINANCE_TOPICS[i % FINANCE_TOPICS.length],
      platform,
      engagement,
      views: Math.round(5000 + Math.random() * 20000),
      hookPattern,
      retentionAvg: 0.35 + Math.random() * 0.3,
    });
  }

  const { decisions } = decisionEngine.analyze(performanceEntries);
  console.log(`\n  Analyzed ${performanceEntries.length} performance entries`);
  console.log(`  Generated ${decisions.length} decisions`);

  const autoExec = decisionEngine.getAutoExecutable();
  const pending = decisionEngine.getPendingReview();
  console.log(`  Auto-executable (HIGH confidence): ${autoExec.length}`);
  console.log(`  Pending review (MEDIUM/LOW): ${pending.length}`);

  if (decisions.length > 0) {
    console.log('\n  Top decisions:');
    for (const d of decisions.slice(0, 4)) {
      console.log(`  [${d.confidence.toUpperCase()}] ${d.type}: ${d.action}`);
    }
  }

  for (const d of autoExec) {
    decisionEngine.execute(d.id);
  }
  const decStats = decisionEngine.getStats();
  console.log(`\n  Executed ${decStats.executed} HIGH-confidence decisions automatically`);

  // ══════════════════════════════════════════════════════════
  // PHASE 4C: EVOLUTION ENGINE
  // ══════════════════════════════════════════════════════════

  header('PHASE 4C: Evolution Engine');

  const evoData: PerformanceData[] = performanceEntries.map(e => ({
    topic: e.topic,
    hookPattern: e.hookPattern,
    platform: e.platform,
    engagement: e.engagement,
    views: e.views,
    retentionAvg: e.retentionAvg,
    duration: 30 + Math.round(Math.random() * 60),
    hasCTA: Math.random() > 0.4,
  }));

  const evoResult = evolutionEngine.evolve(evoData, decisions);

  console.log(`\n  Evolution generation: ${evoResult.generation}`);
  console.log(`  Hook weights learned:`);
  for (const [pattern, weight] of Object.entries(evoResult.hookWeights).sort((a, b) => b[1] - a[1])) {
    const bar = '█'.repeat(Math.round(weight * 30));
    console.log(`    ${pattern.padEnd(20)} ${bar} ${(weight * 100).toFixed(1)}%`);
  }
  console.log(`\n  Platform weights:`);
  for (const [platform, weight] of Object.entries(evoResult.platformWeights).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${platform.padEnd(12)} ${(weight * 100).toFixed(1)}%`);
  }
  console.log(`\n  Top topics:`);
  for (const t of evoResult.topTopics) {
    console.log(`    [${t.trend}] ${t.topic.substring(0, 45).padEnd(46)} score: ${(t.score * 100).toFixed(1)}%`);
  }
  console.log(`\n  Format rules derived: ${evoResult.formatRules.length}`);
  for (const r of evoResult.formatRules) {
    console.log(`    ${r.type}: ${r.value} (confidence: ${(r.confidence * 100).toFixed(0)}%) — ${r.reason}`);
  }

  const recommendedConfig = evolutionEngine.getRecommendedConfig();
  console.log(`\n  Recommended config for next cycle:`);
  console.log(`    Best hook: ${recommendedConfig.preferredHookPatterns[0]?.pattern} (${(recommendedConfig.preferredHookPatterns[0]?.weight * 100).toFixed(1)}%)`);
  console.log(`    Best platform: ${recommendedConfig.preferredPlatforms[0]?.platform}`);
  console.log(`    Topics to avoid: ${recommendedConfig.avoidTopics.length}`);

  const evoStats = evolutionEngine.getStats();
  console.log(`\n  Evolution stats: generation ${evoStats.generation} | ${evoStats.trackedTopics} topics tracked | ${evoStats.evolutionCycles} cycles run`);

  // ══════════════════════════════════════════════════════════
  // PHASE 4D: PORTFOLIO ENGINE
  // ══════════════════════════════════════════════════════════

  header('PHASE 4D: Portfolio Engine');

  portfolioEngine.addAccount('yt_finance', { platform: 'youtube', channelName: 'WealthMind', niche: 'finance', subNiche: 'investing' });
  portfolioEngine.addAccount('ig_finance', { platform: 'instagram', channelName: 'MoneyShorts', niche: 'finance', subNiche: 'personal_finance' });
  portfolioEngine.addAccount('tt_finance', { platform: 'tiktok', channelName: 'FinanceTok', niche: 'finance', subNiche: 'budgeting' });

  console.log('\nSimulating account performance...');

  for (let i = 0; i < 15; i++) {
    portfolioEngine.updateAccountMetrics('yt_finance', { videos: 1, revenue: 45 + Math.random() * 30, cost: 12, views: 8000 + Math.round(Math.random() * 5000), engagement: 0.6 + Math.random() * 0.2 });
  }
  for (let i = 0; i < 10; i++) {
    portfolioEngine.updateAccountMetrics('ig_finance', { videos: 1, revenue: 18 + Math.random() * 12, cost: 10, views: 3000 + Math.round(Math.random() * 2000), engagement: 0.3 + Math.random() * 0.15 });
  }
  for (let i = 0; i < 12; i++) {
    portfolioEngine.updateAccountMetrics('tt_finance', { videos: 1, revenue: 4 + Math.random() * 6, cost: 11, views: 1500 + Math.round(Math.random() * 1000), engagement: 0.1 + Math.random() * 0.1 });
  }

  portfolioEngine.setStrategy(AllocationStrategy.AGGRESSIVE);

  const summary = portfolioEngine.getPortfolioSummary();
  console.log(`\n  Strategy: ${summary.strategy.toUpperCase()}`);
  console.log(`  Accounts: ${summary.accountCount} | Videos: ${summary.totalVideos} | P&L: $${summary.totalProfit.toFixed(2)}`);
  console.log(`  Portfolio ROI: ${(summary.portfolioROI * 100).toFixed(1)}%`);
  console.log(`\n  Account breakdown:`);
  for (const a of summary.accounts) {
    console.log(`  ${a.health === 'thriving' ? '🟢' : a.health === 'stable' ? '🟡' : a.health === 'bleeding' ? '🔴' : '⚪'} ${a.channelName.padEnd(14)} ROI: ${(a.roi * 100).toFixed(1).padStart(6)}%  Eng: ${(a.avgEngagement * 100).toFixed(1).padStart(5)}%  Budget: $${a.budgetAllocation.toFixed(0).padStart(4)}  ${a.videosPerWeek}v/wk  [${a.health}]`);
  }
  console.log(`\n  Health: ${JSON.stringify(summary.healthBreakdown)}`);
  console.log(`\n  Recommendations (${summary.recommendations.length}):`);
  for (const r of summary.recommendations) {
    console.log(`  [${r.type.toUpperCase()}] ${r.action}`);
  }

  // ══════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════════

  header('SYSTEM SUMMARY');
  console.log(`\n  Phase 1–2 Pipeline:  ${successCount}/${pipelineResults.length} videos generated`);
  console.log(`  Registry:            ${registryStats.totalFingerprints} content fingerprints`);
  console.log(`  Experiments:         ${expStats.total} running (${expStats.concluded} concluded)`);
  console.log(`  Decisions:           ${decStats.totalDecisions} generated (${decStats.executed} auto-executed)`);
  console.log(`  Evolution:           Generation ${evoStats.generation} | ${evoStats.formatRules} format rules`);
  console.log(`  Portfolio:           ${summary.accountCount} accounts | ROI ${(summary.portfolioROI * 100).toFixed(1)}%`);
  console.log(`\n  All phases operational.\n`);
}

main().catch(err => {
  log.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});
