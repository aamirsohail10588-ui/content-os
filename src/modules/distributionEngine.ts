// ============================================================
// MODULE: modules/distributionEngine.ts
// PURPOSE: Multi-platform video publishing — upload, schedule, rate limit
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock mode for all platform APIs. Swap in real OAuth + API calls when keys ready.
// PLATFORMS: YouTube Shorts, Instagram Reels, TikTok
// ============================================================

import * as crypto from 'crypto';
import { Logger, VideoAssemblyResult } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('DistributionEngine');

// ─── ENUMS ──────────────────────────────────────────────────

export enum UploadStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  PUBLISHED = 'published',
  FAILED = 'failed',
}

export type Platform = 'youtube' | 'instagram' | 'tiktok';

// ─── INTERFACES ─────────────────────────────────────────────

export interface PlatformConfig {
  name: string;
  maxTitleLength?: number;
  maxDescriptionLength?: number;
  maxCaptionLength?: number;
  maxTagsCount?: number;
  maxTagLength?: number;
  maxHashtags?: number;
  rateLimitPerHour: number;
  rateLimitPerDay: number;
  optimalPostTimes: string[];
  requiredFields: string[];
}

export interface RateLimitStatus {
  platform: string;
  hourly: { used: number; limit: number; remaining: number };
  daily: { used: number; limit: number; remaining: number };
}

export interface CaptionResult {
  caption: string;
  hashtags: string[];
  cta: string;
  platform: string;
  charCount: number;
  maxAllowed: number;
}

export interface ScheduleSlot {
  scheduledAt: string;
  timeSlot: string;
  dayOffset: number;
  platform: string;
}

export interface PublishResult {
  platformId: string;
  url: string;
  platform: string;
  uploadedAt: string;
  processingStatus: string;
  metadata: {
    title: string;
    views: number;
    likes: number;
    shares: number;
  };
}

export interface PublishOptions {
  topic?: string;
  title?: string;
  caption?: string;
  niche?: string;
  tone?: string;
  platforms?: Platform[];
}

export interface UploadRecord {
  uploadId: string;
  platform: Platform;
  videoResult: VideoAssemblyResult;
  options: PublishOptions;
  caption?: CaptionResult;
  status: UploadStatus;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  publishResult: PublishResult | null;
  error: { message: string; code?: string } | null;
}

export interface UploadStoreStats {
  total: number;
  byPlatform: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface DistributionStats {
  uploads: UploadStoreStats;
  rateLimits: Record<string, RateLimitStatus>;
  platforms: string[];
}

// ─── PLATFORM CONFIG ────────────────────────────────────────

export const PLATFORM_CONFIG: Record<Platform, PlatformConfig> = {
  youtube: {
    name: 'YouTube Shorts',
    maxTitleLength: 100,
    maxDescriptionLength: 5000,
    maxTagsCount: 30,
    maxTagLength: 30,
    rateLimitPerHour: 6,
    rateLimitPerDay: 50,
    optimalPostTimes: ['09:00', '12:00', '15:00', '18:00', '21:00'],
    requiredFields: ['title', 'description', 'videoPath'],
  },
  instagram: {
    name: 'Instagram Reels',
    maxCaptionLength: 2200,
    maxHashtags: 30,
    rateLimitPerHour: 3,
    rateLimitPerDay: 25,
    optimalPostTimes: ['08:00', '11:00', '14:00', '17:00', '20:00'],
    requiredFields: ['caption', 'videoPath'],
  },
  tiktok: {
    name: 'TikTok',
    maxCaptionLength: 4000,
    maxHashtags: 5,
    rateLimitPerHour: 4,
    rateLimitPerDay: 30,
    optimalPostTimes: ['07:00', '10:00', '13:00', '16:00', '19:00', '22:00'],
    requiredFields: ['caption', 'videoPath'],
  },
};

// ─── RATE LIMITER ───────────────────────────────────────────

class RateLimiter {
  private windows: Record<string, { hourly: number[]; daily: number[] }>;

  constructor() {
    this.windows = {};
  }

  private _ensure(platform: string): void {
    if (!this.windows[platform]) {
      this.windows[platform] = { hourly: [], daily: [] };
    }
  }

  canPost(platform: Platform): boolean {
    this._ensure(platform);
    const config = PLATFORM_CONFIG[platform];
    if (!config) return false;

    const now = Date.now();
    this.windows[platform].hourly = this.windows[platform].hourly.filter(t => t > now - 3600000);
    this.windows[platform].daily = this.windows[platform].daily.filter(t => t > now - 86400000);

    return (
      this.windows[platform].hourly.length < config.rateLimitPerHour &&
      this.windows[platform].daily.length < config.rateLimitPerDay
    );
  }

  record(platform: Platform): void {
    this._ensure(platform);
    const now = Date.now();
    this.windows[platform].hourly.push(now);
    this.windows[platform].daily.push(now);
  }

  getStatus(platform: Platform): RateLimitStatus {
    this._ensure(platform);
    const config = PLATFORM_CONFIG[platform];
    const now = Date.now();
    const hourly = this.windows[platform].hourly.filter(t => t > now - 3600000).length;
    const daily = this.windows[platform].daily.filter(t => t > now - 86400000).length;
    return {
      platform,
      hourly: { used: hourly, limit: config.rateLimitPerHour, remaining: config.rateLimitPerHour - hourly },
      daily: { used: daily, limit: config.rateLimitPerDay, remaining: config.rateLimitPerDay - daily },
    };
  }
}

// ─── UPLOAD STORE ───────────────────────────────────────────

class UploadStore {
  private uploads: Map<string, UploadRecord>;
  private schedule: UploadRecord[];

  constructor() {
    this.uploads = new Map();
    this.schedule = [];
  }

  add(record: UploadRecord): UploadRecord {
    this.uploads.set(record.uploadId, record);
    if (record.status === UploadStatus.SCHEDULED) {
      this.schedule.push(record);
      this.schedule.sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
    }
    return record;
  }

  get(uploadId: string): UploadRecord | null {
    return this.uploads.get(uploadId) || null;
  }

  update(uploadId: string, fields: Partial<UploadRecord>): UploadRecord | null {
    const record = this.uploads.get(uploadId);
    if (record) {
      Object.assign(record, fields, { updatedAt: new Date().toISOString() });
    }
    return record || null;
  }

  getByStatus(status: UploadStatus): UploadRecord[] {
    return Array.from(this.uploads.values()).filter(u => u.status === status);
  }

  getDueScheduled(): UploadRecord[] {
    const now = new Date();
    return this.schedule.filter(r =>
      r.status === UploadStatus.SCHEDULED && new Date(r.scheduledAt!) <= now
    );
  }

  getStats(): UploadStoreStats {
    const all = Array.from(this.uploads.values());
    const byPlatform: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const u of all) {
      byPlatform[u.platform] = (byPlatform[u.platform] || 0) + 1;
      byStatus[u.status] = (byStatus[u.status] || 0) + 1;
    }
    return { total: all.length, byPlatform, byStatus };
  }
}

// ─── CAPTION OPTIMIZER ──────────────────────────────────────

export function optimizeCaption(text: string, platform: Platform, options: { niche?: string; tone?: string } = {}): CaptionResult {
  const config = PLATFORM_CONFIG[platform];

  const financeHashtags = [
    '#personalfinance', '#investing', '#money', '#wealth',
    '#financialfreedom', '#stockmarket', '#finance', '#budget',
    '#savings', '#passiveincome', '#millionaire', '#crypto',
    '#realestate', '#sideHustle', '#moneytips',
  ];

  const platformTags: Record<string, string[]> = {
    youtube: ['#shorts', '#youtubeshorts'],
    instagram: ['#reels', '#instareels', '#trending'],
    tiktok: ['#fyp', '#foryou', '#viral'],
  };

  const maxTags = platform === 'tiktok' ? 5 : platform === 'instagram' ? 15 : 10;
  const selectedTags = [
    ...(platformTags[platform] || []).slice(0, 2),
    ...financeHashtags.slice(0, maxTags - 2),
  ].slice(0, maxTags);

  const ctas = [
    'Follow for more money tips!',
    'Save this for later.',
    'Share with someone who needs this.',
    'Comment your thoughts below.',
  ];
  const cta = ctas[Math.floor(Math.random() * ctas.length)];

  const hashtagString = selectedTags.join(' ');
  const maxLen = config.maxCaptionLength || config.maxDescriptionLength || 2000;
  const fullCaption = `${text}\n\n${cta}\n\n${hashtagString}`;
  const finalCaption = fullCaption.length > maxLen ? fullCaption.substring(0, maxLen - 3) + '...' : fullCaption;

  return {
    caption: finalCaption,
    hashtags: selectedTags,
    cta,
    platform,
    charCount: finalCaption.length,
    maxAllowed: maxLen,
  };
}

// ─── SCHEDULING ─────────────────────────────────────────────

export function getNextOptimalSlot(platform: Platform, existingSchedule: UploadRecord[] = []): ScheduleSlot | null {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return null;

  const now = new Date();
  const bookedTimes = new Set(existingSchedule.map(s => s.scheduledAt));

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    for (const timeStr of config.optimalPostTimes) {
      const [hours, minutes] = timeStr.split(':').map(Number);
      const slotDate = new Date(now);
      slotDate.setDate(slotDate.getDate() + dayOffset);
      slotDate.setHours(hours, minutes, 0, 0);
      if (slotDate <= now) continue;
      if (bookedTimes.has(slotDate.toISOString())) continue;
      return { scheduledAt: slotDate.toISOString(), timeSlot: timeStr, dayOffset, platform };
    }
  }

  const fallback = new Date(now.getTime() + 7200000);
  return { scheduledAt: fallback.toISOString(), timeSlot: 'fallback', dayOffset: 0, platform };
}

// ─── MOCK PLATFORM UPLOAD ───────────────────────────────────

async function mockPlatformUpload(platform: Platform, metadata: { title?: string; caption?: string }): Promise<PublishResult> {
  const platformId = `${platform}_${crypto.randomUUID().slice(0, 8)}`;
  const urlMap: Record<string, string> = {
    youtube: `https://youtube.com/shorts/${platformId}`,
    instagram: `https://instagram.com/reel/${platformId}`,
    tiktok: `https://tiktok.com/@user/video/${platformId}`,
  };

  return {
    platformId,
    url: urlMap[platform] || `https://${platform}.com/${platformId}`,
    platform,
    uploadedAt: new Date().toISOString(),
    processingStatus: 'complete',
    metadata: { title: metadata.title || metadata.caption || '', views: 0, likes: 0, shares: 0 },
  };
}

// ─── DISTRIBUTION ENGINE ────────────────────────────────────

export class DistributionEngine {
  private rateLimiter: RateLimiter;
  private store: UploadStore;

  constructor() {
    this.rateLimiter = new RateLimiter();
    this.store = new UploadStore();
    log.info('DistributionEngine initialized', { platforms: Object.keys(PLATFORM_CONFIG) });
  }

  async publish(platform: Platform, videoResult: VideoAssemblyResult, options: PublishOptions = {}): Promise<UploadRecord> {
    const uploadId = crypto.randomUUID();
    log.info('Publishing video', { uploadId, platform, topic: options.topic });

    if (!PLATFORM_CONFIG[platform]) {
      throw { code: 'INVALID_PLATFORM', message: `Unknown platform: ${platform}` };
    }

    if (!this.rateLimiter.canPost(platform)) {
      const slot = getNextOptimalSlot(platform, this.store.getByStatus(UploadStatus.SCHEDULED));
      return this.store.add({
        uploadId, platform, videoResult, options,
        status: UploadStatus.SCHEDULED,
        scheduledAt: slot!.scheduledAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        publishResult: null, error: null,
      });
    }

    const captionData = optimizeCaption(
      options.caption || options.title || options.topic || '',
      platform, { niche: options.niche, tone: options.tone }
    );

    const record = this.store.add({
      uploadId, platform, videoResult, options, caption: captionData,
      status: UploadStatus.UPLOADING,
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishResult: null, error: null,
    });

    try {
      const result = await mockPlatformUpload(platform, { title: options.title, caption: captionData.caption });
      this.rateLimiter.record(platform);
      this.store.update(uploadId, { status: UploadStatus.PUBLISHED, publishResult: result });
      log.info('Video published', { uploadId, platform, url: result.url });
      return this.store.get(uploadId)!;
    } catch (err) {
      this.store.update(uploadId, {
        status: UploadStatus.FAILED,
        error: { message: (err as Error).message || String(err) },
      });
      throw err;
    }
  }

  async publishToAll(videoResult: VideoAssemblyResult, options: PublishOptions = {}): Promise<Record<string, UploadRecord>> {
    const platforms = options.platforms || (['youtube', 'instagram', 'tiktok'] as Platform[]);
    const results: Record<string, UploadRecord> = {};

    for (const platform of platforms) {
      try {
        results[platform] = await this.publish(platform, videoResult, options);
      } catch (err) {
        results[platform] = {
          uploadId: '', platform, videoResult, options,
          status: UploadStatus.FAILED,
          scheduledAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          publishResult: null,
          error: { message: (err as Error).message || String(err) },
        };
      }
    }
    return results;
  }

  schedule(platform: Platform, videoResult: VideoAssemblyResult, scheduledAt: Date | string, options: PublishOptions = {}): UploadRecord {
    const uploadId = crypto.randomUUID();
    const captionData = optimizeCaption(options.caption || options.topic || '', platform, { niche: options.niche });
    return this.store.add({
      uploadId, platform, videoResult, options, caption: captionData,
      status: UploadStatus.SCHEDULED,
      scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishResult: null, error: null,
    });
  }

  getRateLimits(): Record<string, RateLimitStatus> {
    const result: Record<string, RateLimitStatus> = {};
    for (const platform of Object.keys(PLATFORM_CONFIG) as Platform[]) {
      result[platform] = this.rateLimiter.getStatus(platform);
    }
    return result;
  }

  getStats(): DistributionStats {
    return { uploads: this.store.getStats(), rateLimits: this.getRateLimits(), platforms: Object.keys(PLATFORM_CONFIG) };
  }

  clean(): void {
    this.store = new UploadStore();
    this.rateLimiter = new RateLimiter();
    log.info('DistributionEngine cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const distributionEngine = new DistributionEngine();
