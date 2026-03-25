// ============================================================
// MODULE: distributionEngine.js
// PURPOSE: Multi-platform video publishing — upload, schedule, rate limit
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Mock mode for all platform APIs. Swap in real OAuth + API calls when keys ready.
// PLATFORMS: YouTube Shorts, Instagram Reels, TikTok
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('DistributionEngine');

// ─── PLATFORM CONFIG ────────────────────────────────────────

const PLATFORM_CONFIG = {
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

// ─── UPLOAD STATUS ──────────────────────────────────────────

const UploadStatus = {
  PENDING: 'pending',
  SCHEDULED: 'scheduled',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  PUBLISHED: 'published',
  FAILED: 'failed',
};

// ─── RATE LIMITER (per-platform) ────────────────────────────

class RateLimiter {
  constructor() {
    this.windows = {}; // platform -> { hourly: [], daily: [] }
  }

  _ensure(platform) {
    if (!this.windows[platform]) {
      this.windows[platform] = { hourly: [], daily: [] };
    }
  }

  canPost(platform) {
    this._ensure(platform);
    const config = PLATFORM_CONFIG[platform];
    if (!config) return false;

    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;

    // Clean old entries
    this.windows[platform].hourly = this.windows[platform].hourly.filter(t => t > oneHourAgo);
    this.windows[platform].daily = this.windows[platform].daily.filter(t => t > oneDayAgo);

    const hourlyOk = this.windows[platform].hourly.length < config.rateLimitPerHour;
    const dailyOk = this.windows[platform].daily.length < config.rateLimitPerDay;

    return hourlyOk && dailyOk;
  }

  record(platform) {
    this._ensure(platform);
    const now = Date.now();
    this.windows[platform].hourly.push(now);
    this.windows[platform].daily.push(now);
  }

  getStatus(platform) {
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

// ─── UPLOAD RECORD STORE ────────────────────────────────────

class UploadStore {
  constructor() {
    this.uploads = new Map();
    this.schedule = []; // sorted by scheduledAt
  }

  add(record) {
    this.uploads.set(record.uploadId, record);
    if (record.status === UploadStatus.SCHEDULED) {
      this.schedule.push(record);
      this.schedule.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    }
    return record;
  }

  get(uploadId) {
    return this.uploads.get(uploadId) || null;
  }

  update(uploadId, fields) {
    const record = this.uploads.get(uploadId);
    if (record) {
      Object.assign(record, fields, { updatedAt: new Date().toISOString() });
    }
    return record;
  }

  getByPlatform(platform) {
    return Array.from(this.uploads.values()).filter(u => u.platform === platform);
  }

  getByStatus(status) {
    return Array.from(this.uploads.values()).filter(u => u.status === status);
  }

  getDueScheduled() {
    const now = new Date();
    return this.schedule.filter(r =>
      r.status === UploadStatus.SCHEDULED && new Date(r.scheduledAt) <= now
    );
  }

  getStats() {
    const all = Array.from(this.uploads.values());
    const byPlatform = {};
    const byStatus = {};
    for (const u of all) {
      byPlatform[u.platform] = (byPlatform[u.platform] || 0) + 1;
      byStatus[u.status] = (byStatus[u.status] || 0) + 1;
    }
    return { total: all.length, byPlatform, byStatus };
  }
}

// ─── CAPTION OPTIMIZER ──────────────────────────────────────

function optimizeCaption(text, platform, options = {}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return { caption: text, hashtags: [] };

  const niche = options.niche || 'finance';
  const tone = options.tone || 'authoritative';

  // Finance-specific hashtags
  const financeHashtags = [
    '#personalfinance', '#investing', '#money', '#wealth',
    '#financialfreedom', '#stockmarket', '#finance', '#budget',
    '#savings', '#passiveincome', '#millionaire', '#crypto',
    '#realestate', '#sideHustle', '#moneytips',
  ];

  // Platform-specific hashtags
  const platformTags = {
    youtube: ['#shorts', '#youtubeshorts'],
    instagram: ['#reels', '#instareels', '#trending'],
    tiktok: ['#fyp', '#foryou', '#viral'],
  };

  // Select hashtags
  const maxTags = platform === 'tiktok' ? 5 : platform === 'instagram' ? 15 : 10;
  const selectedTags = [
    ...(platformTags[platform] || []).slice(0, 2),
    ...financeHashtags.slice(0, maxTags - 2),
  ].slice(0, maxTags);

  // Build caption
  let caption = text;
  const maxLen = config.maxCaptionLength || config.maxDescriptionLength || 2000;

  // Add CTA
  const ctas = [
    'Follow for more money tips!',
    'Save this for later.',
    'Share with someone who needs this.',
    'Comment your thoughts below.',
  ];
  const cta = ctas[Math.floor(Math.random() * ctas.length)];

  const hashtagString = selectedTags.join(' ');
  const fullCaption = `${caption}\n\n${cta}\n\n${hashtagString}`;

  // Truncate if needed
  const finalCaption = fullCaption.length > maxLen
    ? fullCaption.substring(0, maxLen - 3) + '...'
    : fullCaption;

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

function getNextOptimalSlot(platform, existingSchedule = []) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return null;

  const now = new Date();
  const bookedTimes = new Set(existingSchedule.map(s => s.scheduledAt));

  // Try today's remaining slots, then tomorrow's
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    for (const timeStr of config.optimalPostTimes) {
      const [hours, minutes] = timeStr.split(':').map(Number);
      const slotDate = new Date(now);
      slotDate.setDate(slotDate.getDate() + dayOffset);
      slotDate.setHours(hours, minutes, 0, 0);

      if (slotDate <= now) continue;
      const isoStr = slotDate.toISOString();
      if (bookedTimes.has(isoStr)) continue;

      return {
        scheduledAt: isoStr,
        timeSlot: timeStr,
        dayOffset,
        platform,
      };
    }
  }

  // Fallback: 2 hours from now
  const fallback = new Date(now.getTime() + 7200000);
  return { scheduledAt: fallback.toISOString(), timeSlot: 'fallback', dayOffset: 0, platform };
}

// ─── MOCK PLATFORM UPLOAD ───────────────────────────────────

async function mockPlatformUpload(platform, metadata) {
  // Simulate upload latency
  // In production: real OAuth + API calls per platform
  const platformId = `${platform}_${crypto.randomUUID().slice(0, 8)}`;
  const url = {
    youtube: `https://youtube.com/shorts/${platformId}`,
    instagram: `https://instagram.com/reel/${platformId}`,
    tiktok: `https://tiktok.com/@user/video/${platformId}`,
  }[platform] || `https://${platform}.com/${platformId}`;

  return {
    platformId,
    url,
    platform,
    uploadedAt: new Date().toISOString(),
    processingStatus: 'complete',
    metadata: {
      title: metadata.title || metadata.caption,
      views: 0,
      likes: 0,
      shares: 0,
    },
  };
}

// ─── DISTRIBUTION ENGINE ────────────────────────────────────

class DistributionEngine {
  constructor() {
    this.rateLimiter = new RateLimiter();
    this.store = new UploadStore();
    this.platformCredentials = {}; // platform -> { accessToken, refreshToken }

    log.info('DistributionEngine initialized', {
      platforms: Object.keys(PLATFORM_CONFIG),
    });
  }

  // ─── PUBLISH TO SINGLE PLATFORM ────────────────────────

  async publish(platform, videoResult, options = {}) {
    const uploadId = crypto.randomUUID();

    log.info('Publishing video', { uploadId, platform, topic: options.topic });

    // Validate platform
    if (!PLATFORM_CONFIG[platform]) {
      throw { code: 'INVALID_PLATFORM', message: `Unknown platform: ${platform}` };
    }

    // Rate limit check
    if (!this.rateLimiter.canPost(platform)) {
      const status = this.rateLimiter.getStatus(platform);
      log.warn('Rate limited', { platform, ...status });

      // Auto-schedule instead
      const slot = getNextOptimalSlot(platform, this.store.getByStatus(UploadStatus.SCHEDULED));
      const record = this.store.add({
        uploadId,
        platform,
        videoResult,
        options,
        status: UploadStatus.SCHEDULED,
        scheduledAt: slot.scheduledAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        publishResult: null,
        error: null,
      });

      log.info('Auto-scheduled due to rate limit', { uploadId, scheduledAt: slot.scheduledAt });
      return record;
    }

    // Optimize caption
    const captionData = optimizeCaption(
      options.caption || options.title || options.topic || 'Check this out!',
      platform,
      { niche: options.niche, tone: options.tone }
    );

    // Create upload record
    const record = this.store.add({
      uploadId,
      platform,
      videoResult,
      options,
      caption: captionData,
      status: UploadStatus.UPLOADING,
      scheduledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishResult: null,
      error: null,
    });

    try {
      // Mock upload (replace with real API in production)
      const result = await mockPlatformUpload(platform, {
        title: options.title || options.topic,
        caption: captionData.caption,
        videoPath: videoResult.outputPath,
        hashtags: captionData.hashtags,
      });

      // Record rate limit hit
      this.rateLimiter.record(platform);

      // Update record
      this.store.update(uploadId, {
        status: UploadStatus.PUBLISHED,
        publishResult: result,
      });

      log.info('Video published', {
        uploadId,
        platform,
        url: result.url,
        platformId: result.platformId,
      });

      return this.store.get(uploadId);

    } catch (err) {
      this.store.update(uploadId, {
        status: UploadStatus.FAILED,
        error: { message: err.message || String(err), code: err.code },
      });

      log.error('Publish failed', { uploadId, platform, error: err.message });
      throw err;
    }
  }

  // ─── MULTI-PLATFORM PUBLISH ────────────────────────────

  async publishToAll(videoResult, options = {}) {
    const platforms = options.platforms || ['youtube', 'instagram', 'tiktok'];
    const results = {};

    for (const platform of platforms) {
      try {
        results[platform] = await this.publish(platform, videoResult, options);
      } catch (err) {
        results[platform] = {
          platform,
          status: UploadStatus.FAILED,
          error: err.message || String(err),
        };
      }
    }

    log.info('Multi-platform publish complete', {
      platforms: platforms.length,
      succeeded: Object.values(results).filter(r => r.status === UploadStatus.PUBLISHED).length,
      failed: Object.values(results).filter(r => r.status === UploadStatus.FAILED).length,
      scheduled: Object.values(results).filter(r => r.status === UploadStatus.SCHEDULED).length,
    });

    return results;
  }

  // ─── SCHEDULE FOR LATER ────────────────────────────────

  schedule(platform, videoResult, scheduledAt, options = {}) {
    const uploadId = crypto.randomUUID();

    const captionData = optimizeCaption(
      options.caption || options.topic || '',
      platform,
      { niche: options.niche }
    );

    const record = this.store.add({
      uploadId,
      platform,
      videoResult,
      options,
      caption: captionData,
      status: UploadStatus.SCHEDULED,
      scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishResult: null,
      error: null,
    });

    log.info('Video scheduled', { uploadId, platform, scheduledAt: record.scheduledAt });
    return record;
  }

  // ─── PROCESS SCHEDULED ─────────────────────────────────

  async processScheduled() {
    const due = this.store.getDueScheduled();
    if (due.length === 0) return [];

    log.info('Processing scheduled uploads', { count: due.length });

    const results = [];
    for (const record of due) {
      try {
        // Re-attempt publish
        const result = await this.publish(record.platform, record.videoResult, record.options);
        results.push(result);
      } catch (err) {
        log.error('Scheduled publish failed', { uploadId: record.uploadId, error: err.message });
        results.push(record);
      }
    }
    return results;
  }

  // ─── STATUS / STATS ────────────────────────────────────

  getUploadStatus(uploadId) {
    return this.store.get(uploadId);
  }

  getRateLimits() {
    const result = {};
    for (const platform of Object.keys(PLATFORM_CONFIG)) {
      result[platform] = this.rateLimiter.getStatus(platform);
    }
    return result;
  }

  getStats() {
    return {
      uploads: this.store.getStats(),
      rateLimits: this.getRateLimits(),
      platforms: Object.keys(PLATFORM_CONFIG),
    };
  }

  // ─── CLEAN ─────────────────────────────────────────────

  clean() {
    this.store = new UploadStore();
    this.rateLimiter = new RateLimiter();
    log.info('DistributionEngine cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const distributionEngine = new DistributionEngine();

module.exports = {
  DistributionEngine,
  distributionEngine,
  PLATFORM_CONFIG,
  UploadStatus,
  optimizeCaption,
  getNextOptimalSlot,
};
