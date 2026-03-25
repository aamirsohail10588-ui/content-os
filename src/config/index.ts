// ============================================================
// MODULE: config/index.ts
// PURPOSE: Centralized configuration for Content OS
// PHASE: 1
// STATUS: ACTIVE
// ============================================================

import * as os from 'os';
import * as path from 'path';
import { ContentConfig, VideoFormat } from '../types';

// ─── SYSTEM CONFIG ──────────────────────────────────────────

export const SYSTEM_CONFIG = {
  version: '0.1.0',
  phase: 1,
  environment: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
  useMocks: process.env.USE_MOCKS !== 'false',         // false = real Claude + ElevenLabs
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
} as const;

// ─── AI PROVIDER CONFIG ─────────────────────────────────────

export const AI_CONFIG = {
  provider: 'claude' as const,
  claude: {
    apiKey: process.env.CLAUDE_API_KEY || 'mock-key',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    temperature: 0.8,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || 'mock-key',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.8,
  },
} as const;

// ─── DEFAULT CONTENT CONFIG ─────────────────────────────────

export const DEFAULT_CONTENT_CONFIG: ContentConfig = {
  niche: 'finance',
  subNiche: 'personal_finance',
  tone: 'authoritative_yet_accessible',
  targetDurationSeconds: 60,
  format: VideoFormat.YOUTUBE_SHORT,
  aiProvider: 'claude',
  maxVariants: 3,
};

// ─── HOOK ENGINE CONFIG ─────────────────────────────────────

export const HOOK_CONFIG = {
  maxHooksPerGeneration: 5,
  minStrengthScore: 40,
  maxDurationSeconds: 5,
  financePatterns: {
    curiosityGapTemplates: [
      'Most people lose money because of this one mistake...',
      'The #1 thing millionaires do that broke people don\'t...',
      'Nobody talks about this investment strategy...',
    ],
    shockingStatTemplates: [
      '90% of people will never build real wealth. Here\'s why.',
      'The average person wastes $X per year on this alone.',
      'Only 3% of people know this tax loophole exists.',
    ],
    directQuestionTemplates: [
      'Want to know how the rich actually think about money?',
      'Why is nobody talking about this market signal?',
      'How much money are you leaving on the table?',
    ],
    contrarian: [
      'Saving money is actually making you poorer.',
      'Index funds are not the best strategy. Here\'s proof.',
      'Stop budgeting. Do this instead.',
    ],
  },
} as const;

// ─── SCRIPT GENERATOR CONFIG ────────────────────────────────

export const SCRIPT_CONFIG = {
  wordsPerSecond: 2.5, // average speaking rate
  minSegments: 3,
  maxSegments: 8,
  structureTemplate: {
    hook: { maxDurationSeconds: 5, position: 'start' },
    body: { minSegments: 2, maxSegments: 5 },
    callToAction: { maxDurationSeconds: 5, position: 'end' },
  },
  durationPresets: {
    short: 30,
    medium: 60,
    long: 90,
  },
} as const;

// ─── VIDEO ASSEMBLY CONFIG ──────────────────────────────────

export const VIDEO_CONFIG = {
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
  tempDir: path.join(os.tmpdir(), 'content-os', 'assembly'),
  outputDir: path.join(os.tmpdir(), 'content-os', 'output'),
} as const;

// ─── CONTENT REGISTRY CONFIG ────────────────────────────────

export const REGISTRY_CONFIG = {
  similarityThreshold: 0.85, // above this = duplicate
  maxStoredFingerprints: 10000,
  hashAlgorithm: 'sha256' as const,
  enableEmbeddings: false, // Phase 3 — requires vector DB
} as const;

// ─── PIPELINE CONFIG ────────────────────────────────────────

export const PIPELINE_CONFIG = {
  maxAttempts: 3,
  stageTimeoutMs: 60000,         // 60s for most stages (hook gen, script gen, dedup)
  videoAssemblyTimeoutMs: 300000, // 5 min for video assembly (ElevenLabs + FFmpeg)
  totalTimeoutMs: 600000,         // 10 min total
  checkpointsEnabled: true,
} as const;
