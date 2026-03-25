// ============================================================
// MODULE: web/db.ts
// PURPOSE: SQLite database for users, tokens, videos
// ============================================================

import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const dbDir = path.join(os.homedir(), '.content-os');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db: DatabaseType = new Database(path.join(dbDir, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    niche TEXT DEFAULT 'finance',
    tone TEXT DEFAULT 'authoritative_yet_accessible',
    voice_language TEXT DEFAULT 'english',
    voice_gender TEXT DEFAULT 'male',
    auto_publish INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    account_id TEXT,
    channel_name TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, platform)
  );

  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    topic TEXT NOT NULL,
    hook TEXT,
    hook_score INTEGER,
    duration REAL,
    output_path TEXT,
    youtube_url TEXT,
    instagram_url TEXT,
    status TEXT DEFAULT 'generated',
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Add error_message column if it doesn't exist (for existing DBs)
  CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY);

`);

// Migrations for existing databases
try { db.exec(`ALTER TABLE videos ADD COLUMN error_message TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN auto_publish INTEGER DEFAULT 0`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN voice_language TEXT DEFAULT 'english'`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN voice_gender TEXT DEFAULT 'male'`); } catch { /* exists */ }

export default db;
