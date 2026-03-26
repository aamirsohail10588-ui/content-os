// ============================================================
// MODULE: infra/db.ts
// PURPOSE: PostgreSQL connection pool
// ============================================================

import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL env var is required. Set it before starting the server.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
