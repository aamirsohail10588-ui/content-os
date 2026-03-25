// ============================================================
// MODULE: modules/migrationTool.ts
// PURPOSE: Cross-platform content migration — repurpose videos across platforms
// PHASE: 5
// STATUS: ACTIVE
// FLOW: Take content from one platform → adapt format/caption/hashtags →
//       publish to target platform
// ============================================================

import * as crypto from 'crypto';
import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('MigrationTool');

// ─── ENUMS & TYPES ──────────────────────────────────────────

export enum MigrationStatus {
  PENDING = 'pending',
  ADAPTING = 'adapting',
  READY = 'ready',
  PUBLISHED = 'published',
  FAILED = 'failed',
}

export type Platform = 'youtube' | 'instagram' | 'tiktok';

// ─── INTERFACES ─────────────────────────────────────────────

export interface Resolution {
  width: number;
  height: number;
}

export interface PlatformSpec {
  resolution: Resolution;
  maxDuration: number;
  captionField: string;
  hashtagStyle: 'inline' | 'comment';
  maxHashtags: number;
}

export interface MigratableContent {
  [key: string]: unknown;
  caption?: string;
  description?: string;
  durationSeconds?: number;
  _warning?: string;
}

export interface AdaptResult {
  adapted: MigratableContent;
  changes: string[];
  sourcePlatform: Platform;
  targetPlatform: Platform;
}

export interface MigrationRecord {
  migrationId: string;
  contentId: string;
  sourcePlatform: Platform;
  targetPlatform: Platform;
  status: MigrationStatus;
  originalContent: MigratableContent;
  adaptedContent: MigratableContent;
  changes: string[];
  createdAt: string;
}

export interface MigrationTemplate {
  name: string;
  sourcePlatform: Platform;
  targetPlatform: Platform;
  customRules: Record<string, unknown>;
  createdAt: string;
}

export interface BatchMigrationItem {
  id: string;
  content: MigratableContent;
}

export interface BatchMigrationResult {
  contentId: string;
  migrations: Record<string, MigrationRecord>;
}

export interface MigrationStats {
  totalMigrations: number;
  byStatus: Record<string, number>;
  byRoute: Record<string, number>;
  templates: number;
}

// ─── PLATFORM SPECS ─────────────────────────────────────────

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  youtube: {
    resolution: { width: 1080, height: 1920 },
    maxDuration: 60,
    captionField: 'description',
    hashtagStyle: 'inline',
    maxHashtags: 15,
  },
  instagram: {
    resolution: { width: 1080, height: 1920 },
    maxDuration: 90,
    captionField: 'caption',
    hashtagStyle: 'comment',
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

// ─── CONTENT ADAPTER ────────────────────────────────────────

export function adaptContent(
  content: MigratableContent,
  sourcePlatform: Platform,
  targetPlatform: Platform
): AdaptResult {
  const sourceSpec: PlatformSpec | undefined = PLATFORM_SPECS[sourcePlatform];
  const targetSpec: PlatformSpec | undefined = PLATFORM_SPECS[targetPlatform];

  if (!sourceSpec || !targetSpec) {
    return { adapted: content, changes: ['Unknown platform'], sourcePlatform, targetPlatform };
  }

  const adapted: MigratableContent = { ...content };
  const changes: string[] = [];

  const sourceText: string =
    (content[sourceSpec.captionField] as string) ||
    content.caption ||
    content.description ||
    '';

  // Strip source-platform-specific hashtags
  let cleanText: string = sourceText
    .replace(/#shorts/gi, '')
    .replace(/#youtubeshorts/gi, '')
    .replace(/#reels/gi, '')
    .replace(/#instareels/gi, '')
    .replace(/#fyp/gi, '')
    .replace(/#foryou/gi, '')
    .trim();

  // Add target-platform hashtags
  const targetTags: Record<Platform, string[]> = {
    youtube: ['#shorts', '#youtubeshorts'],
    instagram: ['#reels', '#trending'],
    tiktok: ['#fyp', '#foryou'],
  };

  const existingTags: string[] = cleanText.match(/#\w+/g) || [];
  const newTags: string[] = (targetTags[targetPlatform] || []).filter(
    (t: string) => !existingTags.includes(t)
  );

  const totalTags: number = existingTags.length + newTags.length;
  const tagsToAdd: string[] =
    totalTags > targetSpec.maxHashtags
      ? newTags.slice(0, Math.max(0, targetSpec.maxHashtags - existingTags.length))
      : newTags;

  if (tagsToAdd.length > 0) {
    cleanText += '\n' + tagsToAdd.join(' ');
    changes.push(`Added ${targetPlatform} hashtags`);
  }

  adapted[targetSpec.captionField] = cleanText;
  changes.push(`Mapped caption to ${targetSpec.captionField}`);

  if (content.durationSeconds && content.durationSeconds > targetSpec.maxDuration) {
    adapted._warning = `Video ${content.durationSeconds}s exceeds ${targetPlatform} max ${targetSpec.maxDuration}s — needs trimming`;
    changes.push('Duration exceeds limit — flagged');
  }

  return { adapted, changes, sourcePlatform, targetPlatform };
}

// ─── MIGRATION TOOL CLASS ───────────────────────────────────

export class MigrationTool {
  private migrations: Map<string, MigrationRecord>;
  private templates: Map<string, MigrationTemplate>;

  constructor() {
    this.migrations = new Map();
    this.templates = new Map();
  }

  migrate(
    contentId: string,
    content: MigratableContent,
    sourcePlatform: Platform,
    targetPlatforms: Platform[]
  ): Record<string, MigrationRecord> {
    const results: Record<string, MigrationRecord> = {};

    for (const target of targetPlatforms) {
      if (target === sourcePlatform) continue;

      const migrationId: string = crypto.randomUUID();
      const { adapted, changes } = adaptContent(content, sourcePlatform, target);

      const record: MigrationRecord = {
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

  batchMigrate(
    contents: BatchMigrationItem[],
    sourcePlatform: Platform,
    targetPlatforms: Platform[]
  ): BatchMigrationResult[] {
    const results: BatchMigrationResult[] = [];

    for (const item of contents) {
      const migrated: Record<string, MigrationRecord> = this.migrate(
        item.id,
        item.content,
        sourcePlatform,
        targetPlatforms
      );
      results.push({ contentId: item.id, migrations: migrated });
    }

    log.info('Batch migration complete', {
      contents: contents.length,
      targets: targetPlatforms.length,
      totalMigrations: results.reduce(
        (s: number, r: BatchMigrationResult) => s + Object.keys(r.migrations).length,
        0
      ),
    });

    return results;
  }

  saveTemplate(
    name: string,
    sourcePlatform: Platform,
    targetPlatform: Platform,
    customRules: Record<string, unknown> = {}
  ): void {
    this.templates.set(name, {
      name,
      sourcePlatform,
      targetPlatform,
      customRules,
      createdAt: new Date().toISOString(),
    });
    log.info('Template saved', { name });
  }

  getMigration(migrationId: string): MigrationRecord | null {
    return this.migrations.get(migrationId) || null;
  }

  getStats(): MigrationStats {
    const all: MigrationRecord[] = Array.from(this.migrations.values());
    return {
      totalMigrations: all.length,
      byStatus: all.reduce<Record<string, number>>((acc, m) => {
        acc[m.status] = (acc[m.status] || 0) + 1;
        return acc;
      }, {}),
      byRoute: all.reduce<Record<string, number>>((acc, m) => {
        const route: string = `${m.sourcePlatform}->${m.targetPlatform}`;
        acc[route] = (acc[route] || 0) + 1;
        return acc;
      }, {}),
      templates: this.templates.size,
    };
  }

  clean(): void {
    this.migrations.clear();
    this.templates.clear();
    log.info('MigrationTool cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const migrationTool: MigrationTool = new MigrationTool();
