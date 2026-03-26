// ============================================================
// MODULE: infra/redis.ts
// PURPOSE: ioredis client
// ============================================================

import Redis from 'ioredis';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env var is required. Set it before starting the server.');
}

export const redis = new Redis(process.env.REDIS_URL);
