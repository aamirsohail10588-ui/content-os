// ============================================================
// MODULE: infra/logger.ts
// PURPOSE: Structured logging for Content OS
// PHASE: 1
// STATUS: ACTIVE
// ============================================================

import { Logger } from '../types';

export function createLogger(module: string): Logger {
  const formatMessage = (level: string, message: string, meta?: Record<string, unknown>): string => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${module}] ${message}${metaStr}`;
  };

  return {
    info(message: string, meta?: Record<string, unknown>): void {
      console.log(formatMessage('info', message, meta));
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      console.warn(formatMessage('warn', message, meta));
    },
    error(message: string, meta?: Record<string, unknown>): void {
      console.error(formatMessage('error', message, meta));
    },
    debug(message: string, meta?: Record<string, unknown>): void {
      if (process.env.DEBUG === 'true') {
        console.debug(formatMessage('debug', message, meta));
      }
    },
  };
}
