// ============================================================
// MODULE: config.js
// PURPOSE: Centralized configuration
// ============================================================

const os = require('os');

const SYSTEM_CONFIG = {
  version: '0.1.0',
  phase: 1,
  environment: process.env.NODE_ENV || 'development',
  useMocks: process.env.USE_MOCKS !== 'false',
};

const HOOK_CONFIG = {
  maxHooksPerGeneration: 5,
  minStrengthScore: 60,
  maxDurationSeconds: 5,
};

const SCRIPT_CONFIG = {
  wordsPerSecond: 2.5,
  minSegments: 3,
  maxSegments: 8,
};

const VIDEO_CONFIG = {
  resolution: {
    youtube_short: { width: 1080, height: 1920 },
    instagram_reel: { width: 1080, height: 1920 },
    tiktok: { width: 1080, height: 1920 },
  },
  fps: 30,
  codec: 'libx264',
  audioBitrate: '192k',
  videoBitrate: '4000k',
  outputFormat: 'mp4',
  tempDir: require('path').join(os.tmpdir(), 'content-os', 'assembly'),
  outputDir: require('path').join(os.tmpdir(), 'content-os', 'output'),
};

const REGISTRY_CONFIG = {
  similarityThreshold: 0.85,
  maxStoredFingerprints: 10000,
  hashAlgorithm: 'sha256',
};

const PIPELINE_CONFIG = {
  maxAttempts: 3,
  stageTimeoutMs: 120000,   // 2 min per stage (voice gen + ffmpeg each need time)
  totalTimeoutMs: 600000,   // 10 min total
  checkpointsEnabled: true,
};

module.exports = {
  SYSTEM_CONFIG,
  HOOK_CONFIG,
  SCRIPT_CONFIG,
  VIDEO_CONFIG,
  REGISTRY_CONFIG,
  PIPELINE_CONFIG,
};
