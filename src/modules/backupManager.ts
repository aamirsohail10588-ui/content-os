// ============================================================
// MODULE: modules/backupManager.ts
// PURPOSE: Content/config backup & restore — crash recovery, state export
// PHASE: 5
// STATUS: ACTIVE
// NOTE: File-based backups. Production: S3/GCS with versioning
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('BackupManager');

const BACKUP_DIR: string = '/tmp/content-os/backups';

// ─── INTERFACES ─────────────────────────────────────────────

export interface BackupMetadata {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  sizeBytes: number;
  checksum: string;
  modules: string[];
  filePath: string;
}

export interface BackupOptions {
  version?: string;
}

export interface BackupStats {
  totalBackups: number;
  totalSizeBytes: number;
  totalSizeMB: number;
  oldest: string | null;
  newest: string | null;
}

// ─── BACKUP MANAGER CLASS ───────────────────────────────────

export class BackupManager {
  private backups: Map<string, BackupMetadata>;

  constructor() {
    this.backups = new Map();
    this._ensureDir();
  }

  private _ensureDir(): void {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
  }

  createBackup(
    label: string,
    data: Record<string, unknown>,
    options: BackupOptions = {}
  ): BackupMetadata {
    const backupId: string = `backup_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const filename: string = `${backupId}.json`;
    const filePath: string = path.join(BACKUP_DIR, filename);

    const backup: BackupMetadata = {
      id: backupId,
      label,
      version: options.version || '1.0',
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      checksum: '',
      modules: Object.keys(data),
      filePath,
    };

    const serialized: string = JSON.stringify(data, null, 2);
    backup.sizeBytes = Buffer.byteLength(serialized, 'utf-8');
    backup.checksum = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);

    try {
      fs.writeFileSync(filePath, serialized);
      this.backups.set(backupId, backup);

      log.info('Backup created', {
        id: backupId,
        label,
        modules: backup.modules.length,
        sizeBytes: backup.sizeBytes,
      });

      return backup;
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      log.error('Backup failed', { error: message });
      throw err;
    }
  }

  restoreBackup(backupId: string): Record<string, unknown> | null {
    let meta: BackupMetadata | undefined = this.backups.get(backupId);

    if (!meta) {
      try {
        const files: string[] = fs.readdirSync(BACKUP_DIR).filter(
          (f: string) => f.startsWith(backupId)
        );
        if (files.length === 0) {
          log.error('Backup not found', { backupId });
          return null;
        }
        meta = {
          id: backupId,
          label: 'disk-only',
          version: '1.0',
          createdAt: '',
          sizeBytes: 0,
          checksum: '',
          modules: [],
          filePath: path.join(BACKUP_DIR, files[0]),
        };
      } catch {
        log.error('Backup not found', { backupId });
        return null;
      }
    }

    try {
      const raw: string = fs.readFileSync(meta.filePath, 'utf-8');
      const data: Record<string, unknown> = JSON.parse(raw) as Record<string, unknown>;

      const checksum: string = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
      if (meta.checksum && checksum !== meta.checksum) {
        log.warn('Checksum mismatch — backup may be corrupted', {
          expected: meta.checksum,
          actual: checksum,
        });
      }

      log.info('Backup restored', { id: backupId, modules: Object.keys(data).length });
      return data;
    } catch (err) {
      const message: string = err instanceof Error ? err.message : String(err);
      log.error('Restore failed', { backupId, error: message });
      return null;
    }
  }

  listBackups(): BackupMetadata[] {
    const list: BackupMetadata[] = Array.from(this.backups.values());

    try {
      const files: string[] = fs.readdirSync(BACKUP_DIR).filter(
        (f: string) => f.endsWith('.json')
      );
      for (const file of files) {
        const id: string = file.replace('.json', '');
        if (!this.backups.has(id)) {
          const filePath: string = path.join(BACKUP_DIR, file);
          const stat: fs.Stats = fs.statSync(filePath);
          list.push({
            id,
            label: 'disk-only',
            version: '1.0',
            createdAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            checksum: '',
            modules: [],
            filePath,
          });
        }
      }
    } catch {
      /* ignore disk scan errors */
    }

    return list.sort(
      (a: BackupMetadata, b: BackupMetadata) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  deleteBackup(backupId: string): void {
    const meta: BackupMetadata | undefined = this.backups.get(backupId);
    if (meta && meta.filePath) {
      try {
        fs.unlinkSync(meta.filePath);
      } catch {
        /* ignore */
      }
    }
    this.backups.delete(backupId);
    log.info('Backup deleted', { backupId });
  }

  snapshotSystem(modules: Record<string, unknown>): BackupMetadata {
    return this.createBackup('system_snapshot', modules, { version: '1.0' });
  }

  enforceRetention(maxBackups: number = 10): number {
    const all: BackupMetadata[] = this.listBackups();
    if (all.length <= maxBackups) return 0;

    const toDelete: BackupMetadata[] = all.slice(maxBackups);
    for (const backup of toDelete) {
      this.deleteBackup(backup.id);
    }
    log.info('Retention enforced', { deleted: toDelete.length, remaining: maxBackups });
    return toDelete.length;
  }

  getStats(): BackupStats {
    const backups: BackupMetadata[] = this.listBackups();
    const totalSize: number = backups.reduce(
      (s: number, b: BackupMetadata) => s + (b.sizeBytes || 0),
      0
    );
    return {
      totalBackups: backups.length,
      totalSizeBytes: totalSize,
      totalSizeMB: Math.round((totalSize / 1024 / 1024) * 100) / 100,
      oldest: backups.length > 0 ? backups[backups.length - 1].createdAt : null,
      newest: backups.length > 0 ? backups[0].createdAt : null,
    };
  }

  clean(): void {
    for (const [id] of this.backups) {
      this.deleteBackup(id);
    }
    this.backups.clear();
    log.info('BackupManager cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const backupManager: BackupManager = new BackupManager();
