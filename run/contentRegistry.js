// ============================================================
// MODULE: contentRegistry.js
// PURPOSE: Content fingerprinting + deduplication
// PHASE: 1
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { REGISTRY_CONFIG } = require('./config');

const log = createLogger('ContentRegistry');

// In-memory store (Phase 3: PostgreSQL + pgvector)
const store = {
  fingerprints: new Map(),
  topicHashes: new Map(),
  hookHashes: new Map(),
};

function hashText(text) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(normalized).digest('hex');
}

function hashStructure(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgLength = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / Math.max(sentences.length, 1);
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(`${sentences.length}:${Math.round(avgLength)}:${text.length}`).digest('hex');
}

function hashTopic(topic) {
  const normalized = topic.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').sort().join(' ');
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(normalized).digest('hex').slice(0, 16);
}

function calculateHashSimilarity(h1, h2) {
  if (h1 === h2) return 1.0;
  let match = 0;
  const len = Math.min(h1.length, h2.length);
  for (let i = 0; i < len; i++) { if (h1[i] === h2[i]) match++; }
  return match / len;
}

function calculateContentSimilarity(newFp, existing) {
  const w = { topic: 0.3, hook: 0.3, structure: 0.2, text: 0.2 };
  return (
    calculateHashSimilarity(newFp.topicHash, existing.topicHash) * w.topic +
    calculateHashSimilarity(newFp.hookTextHash, existing.hookTextHash) * w.hook +
    calculateHashSimilarity(newFp.scriptStructureHash, existing.scriptStructureHash) * w.structure +
    calculateHashSimilarity(newFp.fullTextHash, existing.fullTextHash) * w.text
  );
}

function checkDuplicate(topic, hookText, scriptText) {
  const startTime = Date.now();
  const newFp = {
    topicHash: hashTopic(topic),
    hookTextHash: hashText(hookText || ''),
    scriptStructureHash: hashStructure(scriptText || ''),
    fullTextHash: hashText(scriptText || ''),
  };

  let highest = 0;
  let matchedId = null;

  const topicMatches = store.topicHashes.get(newFp.topicHash) || [];
  for (const fpId of topicMatches) {
    const existing = store.fingerprints.get(fpId);
    if (!existing) continue;
    const sim = calculateContentSimilarity(newFp, existing);
    if (sim > highest) { highest = sim; matchedId = fpId; }
  }

  if (highest < REGISTRY_CONFIG.similarityThreshold && store.fingerprints.size < 1000) {
    for (const [fpId, existing] of store.fingerprints) {
      if (topicMatches.includes(fpId)) continue;
      const sim = calculateContentSimilarity(newFp, existing);
      if (sim > highest) { highest = sim; matchedId = fpId; }
    }
  }

  const isDuplicate = highest >= REGISTRY_CONFIG.similarityThreshold;
  log.info('Duplicate check', { isDuplicate, similarity: Math.round(highest * 100) / 100, checked: store.fingerprints.size, timeMs: Date.now() - startTime });

  return { isDuplicate, highestSimilarity: Math.round(highest * 100) / 100, matchedFingerprintId: isDuplicate ? matchedId : null, threshold: REGISTRY_CONFIG.similarityThreshold, checkedAgainst: store.fingerprints.size };
}

function registerContent(id, topic, hookText, hookPattern, scriptText, durationSeconds, niche) {
  const fp = {
    id,
    topicHash: hashTopic(topic),
    hookPatternUsed: hookPattern,
    hookTextHash: hashText(hookText),
    scriptStructureHash: hashStructure(scriptText),
    fullTextHash: hashText(scriptText),
    createdAt: new Date(),
    metadata: { topic, niche, durationSeconds },
  };

  store.fingerprints.set(id, fp);

  const topicEntries = store.topicHashes.get(fp.topicHash) || [];
  topicEntries.push(id);
  store.topicHashes.set(fp.topicHash, topicEntries);

  const hookEntries = store.hookHashes.get(fp.hookTextHash) || [];
  hookEntries.push(id);
  store.hookHashes.set(fp.hookTextHash, hookEntries);

  log.info('Content registered', { id, topic, hookPattern, total: store.fingerprints.size });
  return fp;
}

function getRegistryStats() {
  return {
    totalFingerprints: store.fingerprints.size,
    uniqueTopics: store.topicHashes.size,
    uniqueHookPatterns: store.hookHashes.size,
  };
}

function resetRegistry() {
  store.fingerprints.clear();
  store.topicHashes.clear();
  store.hookHashes.clear();
}

module.exports = { checkDuplicate, registerContent, getRegistryStats, resetRegistry };
