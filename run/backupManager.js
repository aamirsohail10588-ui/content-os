// ============================================================
// MODULE: backupManager.js
// PURPOSE: Content/config backup & restore — crash recovery, state export
// PHASE: 5
// STATUS: ACTIVE
// NOTE: File-based backups. Production: S3/GCS with versioning
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('BackupManager');

const BACKUP_DIR = '/tmp/content-os/backups';

// ─── BACKUP MANAGER ─────────────────────────────────────────

class BackupManager {
  constructor() {
    this.backups = new Map();
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
  }

  // ─── CREATE BACKUP ──────────────────────────────────────

  createBackup(label, data, options = {}) {
    const backupId = `backup_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const filename = `${backupId}.json`;
    const filePath = path.join(BACKUP_DIR, filename);

    const backup = {
      id: backupId,
      label,
      version: options.version || '1.0',
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      checksum: '',
      modules: Object.keys(data),
      filePath,
    };

    // Serialize data
    const serialized = JSON.stringify(data, null, 2);
    backup.sizeBytes = Buffer.byteLength(serialized, 'utf-8');
    backup.checksum = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);

    // Write to disk
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
      log.error('Backup failed', { error: err.message });
      throw err;
    }
  }

  // ─── RESTORE BACKUP ─────────────────────────────────────

  restoreBackup(backupId) {
    const meta = this.backups.get(backupId);
    if (!meta) {
      // Try to find on disk
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(backupId));
      if (files.length === 0) {
        log.error('Backup not found', { backupId });
        return null;
      }
      meta = { filePath: path.join(BACKUP_DIR, files[0]) };
    }

    try {
      const raw = fs.readFileSync(meta.filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Verify checksum
      const checksum = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
      if (meta.checksum && checksum !== meta.checksum) {
        log.warn('Checksum mismatch — backup may be corrupted', { expected: meta.checksum, actual: checksum });
      }

      log.info('Backup restored', { id: backupId, modules: Object.keys(data).length });
      return data;
    } catch (err) {
      log.error('Restore failed', { backupId, error: err.message });
      return null;
    }
  }

  // ─── LIST BACKUPS ───────────────────────────────────────

  listBackups() {
    // From memory
    const list = Array.from(this.backups.values());

    // Also scan disk for any we don't have in memory
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace('.json', '');
        if (!this.backups.has(id)) {
          const filePath = path.join(BACKUP_DIR, file);
          const stat = fs.statSync(filePath);
          list.push({
            id,
            label: 'disk-only',
            createdAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            filePath,
          });
        }
      }
    } catch (e) { /* ignore */ }

    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // ─── DELETE BACKUP ──────────────────────────────────────

  deleteBackup(backupId) {
    const meta = this.backups.get(backupId);
    if (meta && meta.filePath) {
      try { fs.unlinkSync(meta.filePath); } catch (e) { /* ignore */ }
    }
    this.backups.delete(backupId);
    log.info('Backup deleted', { backupId });
  }

  // ─── SNAPSHOT ALL STATE ─────────────────────────────────

  snapshotSystem(modules) {
    // modules = { moduleName: module.getState() or serializable data }
    return this.createBackup('system_snapshot', modules, { version: '1.0' });
  }

  // ─── RETENTION POLICY ───────────────────────────────────

  enforceRetention(maxBackups = 10) {
    const all = this.listBackups();
    if (all.length <= maxBackups) return 0;

    const toDelete = all.slice(maxBackups);
    for (const backup of toDelete) {
      this.deleteBackup(backup.id);
    }
    log.info('Retention enforced', { deleted: toDelete.length, remaining: maxBackups });
    return toDelete.length;
  }

  getStats() {
    const backups = this.listBackups();
    const totalSize = backups.reduce((s, b) => s + (b.sizeBytes || 0), 0);
    return {
      totalBackups: backups.length,
      totalSizeBytes: totalSize,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      oldest: backups.length > 0 ? backups[backups.length - 1].createdAt : null,
      newest: backups.length > 0 ? backups[0].createdAt : null,
    };
  }

  clean() {
    for (const [id] of this.backups) {
      this.deleteBackup(id);
    }
    this.backups.clear();
    log.info('BackupManager cleaned');
  }
}

const backupManager = new BackupManager();

module.exports = { BackupManager, backupManager };
