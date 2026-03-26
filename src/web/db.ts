// ============================================================
// MODULE: web/db.ts
// PURPOSE: PostgreSQL database helpers for users, tokens, videos
// ============================================================

import { pool } from '../infra/db';
import { QueryResult, QueryResultRow } from 'pg';

// Re-export the pool so server.ts can use it directly if needed
export default pool;

// ─── TYPED ROW HELPERS ───────────────────────────────────────

export interface UserRow {
  id: number;
  name: string;
  email: string;
  password: string;
  niche: string;
  tone: string;
  voice_language: string;
  voice_gender: string;
  auto_publish: number;
  created_at: string;
}

export interface TokenRow {
  id: number;
  user_id: number;
  platform: string;
  access_token: string | null;
  refresh_token: string | null;
  account_id: string | null;
  channel_name: string | null;
  updated_at: string;
}

export interface VideoRow {
  id: number;
  user_id: number;
  topic: string;
  hook: string | null;
  hook_score: number | null;
  duration: number | null;
  output_path: string | null;
  youtube_url: string | null;
  instagram_url: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

// ─── QUERY WRAPPERS ──────────────────────────────────────────

/** Run a parameterized query and return the first row or undefined */
export async function queryOne<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result: QueryResult<T> = await pool.query<T>(sql, params);
  return result.rows[0];
}

/** Run a parameterized query and return all rows */
export async function queryAll<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result: QueryResult<T> = await pool.query<T>(sql, params);
  return result.rows;
}

/** Run a parameterized query and return the QueryResult (for INSERT etc.) */
export async function queryRun(sql: string, params: unknown[] = []): Promise<QueryResult> {
  return pool.query(sql, params);
}
