// ============================================================
// MODULE: migrationTool.js
// PURPOSE: Cross-platform content migration — repurpose videos across platforms
// PHASE: 5
// STATUS: ACTIVE
// FLOW: Take content from one platform → adapt format/caption/hashtags →
//       publish to target platform
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('MigrationTool');

// ─── PLATFORM SPECS ─────────────────────────────────────────

const PLATFORM_SPECS = {
  youtube: {
    resolution: { width: 1080, height: 1920 },
    maxDuration: 60,
    captionField: 'description',
    hashtagStyle: 'inline',   // hashtags in description
    maxHashtags: 15,
  },
  instagram: {
    resolution: { width: 1080, height: 1920 },
    maxDuration: 90,
    captionField: 'caption',
    hashtagStyle: 'comment',  // hashtags in first comment
    maxHashtags: 30,
  },
  tiktok: {
    resolution: { width: 1080, height: 1920 },
    maxDuration: 180,
    captionField: 'caption',
    hashtagStyle: 'inline',
    maxHashtags: 5,
  },
};

// ─── MIGRATION RESULT ───────────────────────────────────────

const MigrationStatus = {
  PENDING: 'pending',
  ADAPTING: 'adapting',
  READY: 'ready',
  PUBLISHED: 'published',
  FAILED: 'failed',
};

// ─── CONTENT ADAPTER ────────────────────────────────────────

function adaptContent(content, sourcePlatform, targetPlatform) {
  const sourceSpec = PLATFORM_SPECS[sourcePlatform];
  const targetSpec = PLATFORM_SPECS[targetPlatform];

  if (!sourceSpec || !targetSpec) {
    return { adapted: content, changes: ['Unknown platform'] };
  }

  const adapted = { ...content };
  const changes = [];

  // Adapt caption/description
  const sourceText = content[sourceSpec.captionField] || content.caption || content.description || '';

  // Strip source-platform-specific hashtags
  let cleanText = sourceText
    .replace(/#shorts/gi, '')
    .replace(/#youtubeshorts/gi, '')
    .replace(/#reels/gi, '')
    .replace(/#instareels/gi, '')
    .replace(/#fyp/gi, '')
    .replace(/#foryou/gi, '')
    .trim();

  // Add target-platform hashtags
  const targetTags = {
    youtube: ['#shorts', '#youtubeshorts'],
    instagram: ['#reels', '#trending'],
    tiktok: ['#fyp', '#foryou'],
  };

  const existingTags = (cleanText.match(/#\w+/g) || []);
  const newTags = (targetTags[targetPlatform] || []).filter(t => !existingTags.includes(t));

  // Respect max hashtags
  const totalTags = existingTags.length + newTags.length;
  const tagsToAdd = totalTags > targetSpec.maxHashtags
    ? newTags.slice(0, Math.max(0, targetSpec.maxHashtags - existingTags.length))
    : newTags;

  if (tagsToAdd.length > 0) {
    cleanText += '\n' + tagsToAdd.join(' ');
    changes.push(`Added ${targetPlatform} hashtags`);
  }

  // Set to correct field
  adapted[targetSpec.captionField] = cleanText;
  changes.push(`Mapped caption to ${targetSpec.captionField}`);

  // Note duration limit
  if (content.durationSeconds && content.durationSeconds > targetSpec.maxDuration) {
    adapted._warning = `Video ${content.durationSeconds}s exceeds ${targetPlatform} max ${targetSpec.maxDuration}s — needs trimming`;
    changes.push('Duration exceeds limit — flagged');
  }

  return { adapted, changes, sourcePlatform, targetPlatform };
}

// ─── MIGRATION TOOL ─────────────────────────────────────────

class MigrationTool {
  constructor() {
    this.migrations = new Map();
    this.templates = new Map(); // reusable migration templates
  }

  // ─── MIGRATE SINGLE CONTENT ─────────────────────────────

  migrate(contentId, content, sourcePlatform, targetPlatforms) {
    const results = {};

    for (const target of targetPlatforms) {
      if (target === sourcePlatform) continue;

      const migrationId = crypto.randomUUID();
      const { adapted, changes } = adaptContent(content, sourcePlatform, target);

      const record = {
        migrationId,
        contentId,
        sourcePlatform,
        targetPlatform: target,
        status: MigrationStatus.READY,
        originalContent: content,
        adaptedContent: adapted,
        changes,
        createdAt: new Date().toISOString(),
      };

      this.migrations.set(migrationId, record);
      results[target] = record;

      log.info('Content migrated', {
        migrationId,
        contentId,
        from: sourcePlatform,
        to: target,
        changes: changes.length,
      });
    }

    return results;
  }

  // ─── BATCH MIGRATE ──────────────────────────────────────

  batchMigrate(contents, sourcePlatform, targetPlatforms) {
    // contents = [{ id, content }]
    const results = [];

    for (const item of contents) {
      const migrated = this.migrate(item.id, item.content, sourcePlatform, targetPlatforms);
      results.push({ contentId: item.id, migrations: migrated });
    }

    log.info('Batch migration complete', {
      contents: contents.length,
      targets: targetPlatforms.length,
      totalMigrations: results.reduce((s, r) => s + Object.keys(r.migrations).length, 0),
    });

    return results;
  }

  // ─── SAVE TEMPLATE ──────────────────────────────────────

  saveTemplate(name, sourcePlatform, targetPlatform, customRules = {}) {
    this.templates.set(name, {
      name,
      sourcePlatform,
      targetPlatform,
      customRules,
      createdAt: new Date().toISOString(),
    });
    log.info('Template saved', { name });
  }

  getMigration(migrationId) {
    return this.migrations.get(migrationId) || null;
  }

  getStats() {
    const all = Array.from(this.migrations.values());
    return {
      totalMigrations: all.length,
      byStatus: all.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {}),
      byRoute: all.reduce((acc, m) => {
        const route = `${m.sourcePlatform}->${m.targetPlatform}`;
        acc[route] = (acc[route] || 0) + 1;
        return acc;
      }, {}),
      templates: this.templates.size,
    };
  }

  clean() {
    this.migrations.clear();
    this.templates.clear();
    log.info('MigrationTool cleaned');
  }
}

const migrationTool = new MigrationTool();

module.exports = { MigrationTool, migrationTool, adaptContent, PLATFORM_SPECS, MigrationStatus };
