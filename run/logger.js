// ============================================================
// MODULE: logger.js
// PURPOSE: Structured logging
// ============================================================

function createLogger(module) {
  const format = (level, message, meta) => {
    const ts = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${ts}] [${level}] [${module}] ${message}${metaStr}`;
  };

  return {
    info: (msg, meta) => console.log(format('INFO', msg, meta)),
    warn: (msg, meta) => console.warn(format('WARN', msg, meta)),
    error: (msg, meta) => console.error(format('ERROR', msg, meta)),
    debug: (msg, meta) => { if (process.env.DEBUG === 'true') console.debug(format('DEBUG', msg, meta)); },
  };
}

module.exports = { createLogger };
