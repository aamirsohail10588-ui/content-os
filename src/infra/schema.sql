-- ============================================================
-- FILE: infra/schema.sql
-- PURPOSE: Full PostgreSQL schema for Content OS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  niche TEXT DEFAULT 'finance',
  tone TEXT DEFAULT 'authoritative_yet_accessible',
  voice_language TEXT DEFAULT 'english',
  voice_gender TEXT DEFAULT 'male',
  auto_publish INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  account_id TEXT,
  channel_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, platform)
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS performance_store (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id INTEGER REFERENCES videos(id),
  hook_pattern TEXT NOT NULL,
  hook_score INTEGER,
  topic TEXT,
  platform TEXT,
  views_24h INTEGER,
  views_72h INTEGER,
  watch_percent REAL,
  published_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hook_weights (
  hook_pattern TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 1.0,
  sample_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
