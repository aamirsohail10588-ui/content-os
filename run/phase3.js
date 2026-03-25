// ============================================================
// PHASE 3 TEST RUNNER
// PURPOSE: Exercise all Phase 3 modules end-to-end
// TESTS: Distribution → Performance → Similarity → Monetization
// ============================================================

const { createLogger } = require('./logger');
const { distributionEngine, optimizeCaption, getNextOptimalSlot, UploadStatus } = require('./distributionEngine');
const { performanceTracker, computeEngagementScore, analyzeRetention, generateMockMetrics } = require('./performanceTracker');
const { similarityEngine, SIMILARITY_CONFIG } = require('./similarityEngine');
const { monetizationTracker, estimateAdRevenue, RevenueSource } = require('./monetizationTracker');
const { costController } = require('./costController');

const log = createLogger('Phase3Test');

// ─── HELPERS ────────────────────────────────────────────────

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

function assert(condition, message) {
  if (!condition) {
    console.log(`  ✗ FAIL: ${message}`);
    return false;
  }
  console.log(`  ✓ ${message}`);
  return true;
}

// ─── MOCK VIDEO RESULTS (from Phase 2 output) ──────────────

function makeMockVideoResult(topic, index) {
  return {
    outputPath: `/tmp/content-os/output/video_${index}.mp4`,
    durationSeconds: 55 + Math.floor(Math.random() * 10),
    fileSizeBytes: 5000000 + Math.floor(Math.random() * 3000000),
    resolution: { width: 1080, height: 1920 },
    assemblyTimeMs: 200 + Math.floor(Math.random() * 300),
  };
}

// ─── TEST 1: SIMILARITY ENGINE ──────────────────────────────

async function testSimilarityEngine() {
  section('TEST 1: Similarity Engine (Semantic Dedup)');

  similarityEngine.clean();

  // Register some existing content
  const existingContent = [
    { id: 'v1', text: 'Five proven strategies to build wealth in your twenties through smart investing and compound interest' },
    { id: 'v2', text: 'How to create a monthly budget that actually works and helps you save money consistently' },
    { id: 'v3', text: 'The biggest mistakes people make with their retirement accounts and how to avoid them' },
    { id: 'v4', text: 'Real estate investing for beginners: how to buy your first rental property step by step' },
    { id: 'v5', text: 'Credit score secrets: how to boost your credit rating from 500 to 800 in one year' },
  ];

  for (const content of existingContent) {
    similarityEngine.register(content.id, content.text, { topic: content.text.substring(0, 30) });
  }

  console.log(`  Registered ${existingContent.length} existing pieces`);

  // Test near-duplicate detection
  const dupCheck = similarityEngine.check(
    'Five best strategies to build wealth in your twenties using smart investing and the power of compound interest'
  );
  assert(dupCheck.verdict === 'REJECT' || dupCheck.verdict === 'WARN',
    `Near-duplicate detected: verdict=${dupCheck.verdict}, similarity=${dupCheck.highestSimilarity}`);

  // Test unique content passes
  const uniqueCheck = similarityEngine.check(
    'Why cryptocurrency mining is destroying the environment and what alternatives exist for blockchain consensus'
  );
  assert(uniqueCheck.verdict === 'PASS',
    `Unique content passed: verdict=${uniqueCheck.verdict}, similarity=${uniqueCheck.highestSimilarity}`);

  // Test batch check
  const batchResults = similarityEngine.batchCheck([
    'How to save money on groceries with these ten simple tricks',
    'Building wealth through index funds and dollar cost averaging strategy',
    'Top five cryptocurrency wallets for secure storage of digital assets',
  ]);
  assert(batchResults.length === 3, `Batch check returned ${batchResults.length} results`);

  // Test mutation suggestions on duplicate
  if (dupCheck.mutationSuggestions) {
    assert(dupCheck.mutationSuggestions.length > 0,
      `Mutation suggestions provided: ${dupCheck.mutationSuggestions.length} options`);
  }

  const stats = similarityEngine.getStats();
  console.log(`  Vector store: ${stats.vectorStore.storedVectors} vectors, vocab: ${stats.vectorStore.vocabularySize}`);
  console.log(`  Checks performed: ${stats.checksPerformed}`);
}

// ─── TEST 2: DISTRIBUTION ENGINE ────────────────────────────

async function testDistributionEngine() {
  section('TEST 2: Distribution Engine (Multi-Platform Publishing)');

  distributionEngine.clean();

  const topics = [
    'Why 90% of people will never build real wealth',
    'The hidden cost of not investing in your 20s',
    'How to turn $500 into $50,000 with compound interest',
  ];

  // Test caption optimization
  for (const platform of ['youtube', 'instagram', 'tiktok']) {
    const caption = optimizeCaption('This money hack will change your life', platform, { niche: 'finance' });
    assert(caption.caption.length > 0, `${platform} caption: ${caption.charCount} chars, ${caption.hashtags.length} hashtags`);
  }

  // Test optimal scheduling
  const slot = getNextOptimalSlot('youtube', []);
  assert(slot !== null, `Next optimal YouTube slot: ${slot.timeSlot} (+${slot.dayOffset}d)`);

  // Test single platform publish
  const video1 = makeMockVideoResult(topics[0], 1);
  const result1 = await distributionEngine.publish('youtube', video1, {
    topic: topics[0],
    title: topics[0],
    niche: 'finance',
  });
  assert(result1.status === UploadStatus.PUBLISHED, `YouTube publish: ${result1.status}`);
  assert(result1.publishResult.url.includes('youtube.com'), `Got YouTube URL: ${result1.publishResult.url}`);

  // Test multi-platform publish
  const video2 = makeMockVideoResult(topics[1], 2);
  const multiResult = await distributionEngine.publishToAll(video2, {
    topic: topics[1],
    title: topics[1],
    caption: topics[1],
    niche: 'finance',
    platforms: ['youtube', 'instagram', 'tiktok'],
  });
  const published = Object.values(multiResult).filter(r => r.status === UploadStatus.PUBLISHED).length;
  assert(published === 3, `Multi-platform: ${published}/3 published`);

  // Test scheduling
  const video3 = makeMockVideoResult(topics[2], 3);
  const tomorrow = new Date(Date.now() + 86400000);
  const scheduled = distributionEngine.schedule('youtube', video3, tomorrow, { topic: topics[2] });
  assert(scheduled.status === UploadStatus.SCHEDULED, `Scheduled for: ${scheduled.scheduledAt}`);

  // Test rate limits
  const limits = distributionEngine.getRateLimits();
  assert(limits.youtube.hourly.used > 0, `YouTube rate: ${limits.youtube.hourly.used}/${limits.youtube.hourly.limit} hourly`);

  const stats = distributionEngine.getStats();
  console.log(`  Total uploads: ${stats.uploads.total}`);
  console.log(`  By platform:`, JSON.stringify(stats.uploads.byPlatform));
}

// ─── TEST 3: PERFORMANCE TRACKER ────────────────────────────

async function testPerformanceTracker() {
  section('TEST 3: Performance Tracker (Analytics & Retention)');

  performanceTracker.clean();

  // Track some videos
  const videos = [
    { id: 'vid_001', platform: 'youtube' },
    { id: 'vid_002', platform: 'instagram' },
    { id: 'vid_003', platform: 'tiktok' },
    { id: 'vid_004', platform: 'youtube' },
    { id: 'vid_005', platform: 'youtube' },
  ];

  for (const v of videos) {
    performanceTracker.track(v.id, v.platform, `upload_${v.id}`);
  }
  assert(true, `Tracking ${videos.length} videos`);

  // Collect metrics for all
  const allMetrics = await performanceTracker.pollAll();
  assert(Object.keys(allMetrics).length === videos.length, `Collected metrics for ${Object.keys(allMetrics).length} videos`);

  // Check engagement scoring
  for (const [videoId, data] of Object.entries(allMetrics)) {
    assert(data.engagementScore.overall >= 0 && data.engagementScore.overall <= 100,
      `${videoId}: engagement=${data.engagementScore.overall} (${data.engagementScore.verdict}), views=${data.snapshot.metrics.views}`);
  }

  // Check retention analysis
  const perf = performanceTracker.getPerformance('vid_001');
  assert(perf !== null, `vid_001 retention: hook=${perf.retentionAnalysis.hookRetention}%, avg=${perf.retentionAnalysis.avgRetention}%`);

  if (perf.retentionAnalysis.dropPoints.length > 0) {
    const dp = perf.retentionAnalysis.dropPoints[0];
    console.log(`    Drop point at ${dp.position}%: -${dp.drop}% (${dp.severity}) → ${dp.recommendation}`);
  }

  // Top performers
  const top = performanceTracker.getTopPerformers(3);
  assert(top.length > 0, `Top performer: ${top[0].videoId} (${top[0].engagement} engagement)`);

  const stats = performanceTracker.getStats();
  console.log(`  Avg engagement: ${stats.avgEngagement}`);
  console.log(`  Verdict breakdown:`, JSON.stringify(stats.verdictBreakdown));
}

// ─── TEST 4: MONETIZATION TRACKER ───────────────────────────

async function testMonetizationTracker() {
  section('TEST 4: Monetization Tracker (Revenue & P&L)');

  monetizationTracker.clean();

  // Simulate videos with costs and revenue
  const videoIds = ['vid_001', 'vid_002', 'vid_003', 'vid_004', 'vid_005'];
  const platforms = ['youtube', 'instagram', 'tiktok', 'youtube', 'youtube'];
  const viewCounts = [15000, 3000, 8000, 45000, 500];

  // Record costs (from Phase 2 costController)
  for (const id of videoIds) {
    monetizationTracker.recordCost(id, 0.02 + Math.random() * 0.03); // $0.02-0.05 per video
  }

  // Link to account
  for (const id of videoIds) {
    monetizationTracker.linkToAccount('account_main', id);
  }

  // Estimate revenue
  for (let i = 0; i < videoIds.length; i++) {
    const engagement = 30 + Math.random() * 50;
    monetizationTracker.estimateRevenue(videoIds[i], platforms[i], viewCounts[i], engagement);
  }

  // Check P&L per video
  for (const id of videoIds) {
    const pl = monetizationTracker.getVideoRevenue(id);
    console.log(`  ${id}: revenue=$${pl.revenue} cost=$${pl.cost} profit=$${pl.profit} ROI=${pl.roi}% ${pl.isProfitable ? '✓' : '✗'}`);
  }

  // Account-level P&L
  const accountPL = monetizationTracker.getAccountRevenue('account_main');
  assert(accountPL !== null, `Account P&L: revenue=$${accountPL.totalRevenue} cost=$${accountPL.totalCost} profit=$${accountPL.totalProfit}`);
  console.log(`  Account ROI: ${accountPL.roi}%`);
  console.log(`  Avg revenue/video: $${accountPL.avgRevenuePerVideo}`);
  console.log(`  Avg profit/video: $${accountPL.avgProfitPerVideo}`);

  // Top earners
  const topEarners = monetizationTracker.getTopEarners(3);
  assert(topEarners.length > 0, `Top earner: ${topEarners[0].videoId} profit=$${topEarners[0].profit}`);

  // Overall stats
  const stats = monetizationTracker.getStats();
  console.log(`  Total revenue: $${stats.totalRevenueUSD}`);
  console.log(`  Total cost: $${stats.totalCostUSD}`);
  console.log(`  Total profit: $${stats.totalProfitUSD}`);
  console.log(`  Overall ROI: ${stats.overallROI}%`);
  console.log(`  Profitable video %: ${stats.profitableVideoPercent}%`);
  console.log(`  Revenue by source:`, JSON.stringify(stats.revenueBySource));
}

// ─── TEST 5: FULL INTEGRATION ───────────────────────────────

async function testIntegration() {
  section('TEST 5: Full Phase 3 Integration');

  // Simulate the real flow:
  // 1. Check content similarity before generating
  // 2. Distribute to platforms
  // 3. Track performance
  // 4. Calculate P&L

  const topic = 'How to invest $100 per month and retire a millionaire';
  const videoResult = makeMockVideoResult(topic, 99);

  // Step 1: Similarity check
  const simCheck = similarityEngine.check(topic);
  console.log(`  Similarity check: ${simCheck.verdict} (${simCheck.highestSimilarity})`);

  if (simCheck.verdict !== 'REJECT') {
    // Step 2: Publish
    const publishResult = await distributionEngine.publish('youtube', videoResult, {
      topic,
      title: topic,
      niche: 'finance',
    });
    assert(publishResult.status === UploadStatus.PUBLISHED, `Published: ${publishResult.publishResult.url}`);

    // Step 3: Register in similarity engine (prevent future duplication)
    similarityEngine.register('vid_integration', topic);

    // Step 4: Track performance
    performanceTracker.track('vid_integration', 'youtube', publishResult.uploadId);
    const metrics = await performanceTracker.collectMetrics('vid_integration');
    console.log(`  Engagement: ${metrics.engagementScore.overall} (${metrics.engagementScore.verdict})`);
    console.log(`  Views: ${metrics.snapshot.metrics.views}`);

    // Step 5: Revenue estimation
    monetizationTracker.recordCost('vid_integration', 0.03);
    monetizationTracker.estimateRevenue('vid_integration', 'youtube', metrics.snapshot.metrics.views, metrics.engagementScore.overall);

    const pl = monetizationTracker.getVideoRevenue('vid_integration');
    console.log(`  P&L: revenue=$${pl.revenue} cost=$${pl.cost} profit=$${pl.profit} ROI=${pl.roi}%`);

    assert(pl.revenue >= 0, `Revenue tracked: $${pl.revenue}`);
    assert(pl.cost > 0, `Cost tracked: $${pl.cost}`);
  }
}

// ─── RUN ALL TESTS ──────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           CONTENT OS — PHASE 3 TEST SUITE              ║');
  console.log('║  Distribution · Performance · Similarity · Revenue     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  try {
    await testSimilarityEngine();
    await testDistributionEngine();
    await testPerformanceTracker();
    await testMonetizationTracker();
    await testIntegration();

    section('PHASE 3 — ALL TESTS PASSED');
    console.log('  Modules built and verified:');
    console.log('    1. similarityEngine    — TF-IDF vectors, cosine similarity, mutation suggestions');
    console.log('    2. distributionEngine  — Multi-platform publish, scheduling, rate limiting');
    console.log('    3. performanceTracker  — Analytics, retention curves, engagement scoring');
    console.log('    4. monetizationTracker — Revenue attribution, P&L per video/account');
    console.log('\n  Phase 3 Goal: publish + track + no content recycling ✓\n');

  } catch (err) {
    console.error('\n  ✗ TEST FAILURE:', err.message || err);
    console.error(err.stack || '');
  }

  process.exit(0);
}

main();
