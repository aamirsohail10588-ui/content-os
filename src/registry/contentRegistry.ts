// ============================================================
// MODULE: registry/contentRegistry.ts
// PURPOSE: Content fingerprinting + deduplication from day 1
// PHASE: 1
// STATUS: ACTIVE
// DEPENDENCIES: types, config, infra/logger
// NOTE: Phase 1 uses in-memory store + hash-based similarity
//       Phase 3 upgrades to vector DB + embedding-based similarity
// ============================================================

import * as crypto from 'crypto';
import {
  ContentFingerprint,
  HookPattern,
  SimilarityCheckResult,
} from '../types';
import { REGISTRY_CONFIG } from '../config';
import { createLogger } from '../infra/logger';

const log = createLogger('ContentRegistry');

// ─── IN-MEMORY STORE (Phase 1) ──────────────────────────────
// Phase 3: Replace with PostgreSQL + pgvector

interface RegistryStore {
  fingerprints: Map<string, ContentFingerprint>;
  topicHashes: Map<string, string[]>; // topicHash → fingerprintIds
  hookHashes: Map<string, string[]>;  // hookTextHash → fingerprintIds
}

const store: RegistryStore = {
  fingerprints: new Map(),
  topicHashes: new Map(),
  hookHashes: new Map(),
};

// ─── HASHING UTILITIES ──────────────────────────────────────

function hashText(text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(normalized).digest('hex');
}

function hashStructure(text: string): string {
  // Structure hash captures: sentence count, avg sentence length, paragraph breaks
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgLength = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / Math.max(sentences.length, 1);
  const structureSignature = `${sentences.length}:${Math.round(avgLength)}:${text.length}`;
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(structureSignature).digest('hex');
}

function hashTopic(topic: string): string {
  // Normalize topic to catch near-matches
  const normalized = topic.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .sort()
    .join(' ');
  return crypto.createHash(REGISTRY_CONFIG.hashAlgorithm).update(normalized).digest('hex').slice(0, 16);
}

// ─── SIMILARITY CALCULATION (Hash-based Phase 1) ────────────

function calculateHashSimilarity(hash1: string, hash2: string): number {
  // Simple: if hashes match, similarity = 1.0
  // For near-duplicates, we compare at multiple levels
  if (hash1 === hash2) return 1.0;

  // Prefix matching for partial similarity
  let matchingChars = 0;
  const maxLen = Math.min(hash1.length, hash2.length);
  for (let i = 0; i < maxLen; i++) {
    if (hash1[i] === hash2[i]) matchingChars++;
  }
  return matchingChars / maxLen;
}

function calculateContentSimilarity(
  newFingerprint: { topicHash: string; hookTextHash: string; scriptStructureHash: string; fullTextHash: string },
  existing: ContentFingerprint
): number {
  // Weighted similarity across multiple dimensions
  const weights = {
    topic: 0.3,
    hookText: 0.3,
    structure: 0.2,
    fullText: 0.2,
  };

  const topicSim = calculateHashSimilarity(newFingerprint.topicHash, existing.topicHash);
  const hookSim = calculateHashSimilarity(newFingerprint.hookTextHash, existing.hookTextHash);
  const structureSim = calculateHashSimilarity(newFingerprint.scriptStructureHash, existing.scriptStructureHash);
  const textSim = calculateHashSimilarity(newFingerprint.fullTextHash, existing.fullTextHash);

  return (
    topicSim * weights.topic +
    hookSim * weights.hookText +
    structureSim * weights.structure +
    textSim * weights.fullText
  );
}

// ─── CHECK FOR DUPLICATES ───────────────────────────────────

export function checkDuplicate(
  topic: string,
  hookText: string,
  scriptText: string
): SimilarityCheckResult {
  const startTime = Date.now();

  const newFingerprint = {
    topicHash: hashTopic(topic),
    hookTextHash: hashText(hookText),
    scriptStructureHash: hashStructure(scriptText),
    fullTextHash: hashText(scriptText),
  };

  let highestSimilarity = 0;
  let matchedId: string | null = null;

  // Fast path: check exact topic hash matches first
  const topicMatches = store.topicHashes.get(newFingerprint.topicHash) || [];

  // Check topic matches (most likely duplicates)
  for (const fpId of topicMatches) {
    const existing = store.fingerprints.get(fpId);
    if (!existing) continue;

    const similarity = calculateContentSimilarity(newFingerprint, existing);
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      matchedId = fpId;
    }
  }

  // If no topic match found high similarity, scan all (expensive, Phase 3 optimizes with vector index)
  if (highestSimilarity < REGISTRY_CONFIG.similarityThreshold && store.fingerprints.size < 1000) {
    for (const [fpId, existing] of store.fingerprints) {
      if (topicMatches.includes(fpId)) continue; // already checked
      const similarity = calculateContentSimilarity(newFingerprint, existing);
      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        matchedId = fpId;
      }
    }
  }

  const isDuplicate = highestSimilarity >= REGISTRY_CONFIG.similarityThreshold;

  log.info('Duplicate check completed', {
    isDuplicate,
    highestSimilarity: Math.round(highestSimilarity * 100) / 100,
    threshold: REGISTRY_CONFIG.similarityThreshold,
    checkedAgainst: store.fingerprints.size,
    timeMs: Date.now() - startTime,
  });

  return {
    isDuplicate,
    highestSimilarity: Math.round(highestSimilarity * 100) / 100,
    matchedFingerprintId: isDuplicate ? matchedId : null,
    threshold: REGISTRY_CONFIG.similarityThreshold,
    checkedAgainst: store.fingerprints.size,
  };
}

// ─── REGISTER NEW CONTENT ───────────────────────────────────

export function registerContent(
  id: string,
  topic: string,
  hookText: string,
  hookPattern: HookPattern,
  scriptText: string,
  durationSeconds: number,
  niche: string
): ContentFingerprint {
  const fingerprint: ContentFingerprint = {
    id,
    topicHash: hashTopic(topic),
    hookPatternUsed: hookPattern,
    hookTextHash: hashText(hookText),
    scriptStructureHash: hashStructure(scriptText),
    fullTextHash: hashText(scriptText),
    createdAt: new Date(),
    metadata: {
      topic,
      niche,
      durationSeconds,
    },
  };

  // Store fingerprint
  store.fingerprints.set(id, fingerprint);

  // Index by topic hash
  const topicEntries = store.topicHashes.get(fingerprint.topicHash) || [];
  topicEntries.push(id);
  store.topicHashes.set(fingerprint.topicHash, topicEntries);

  // Index by hook hash
  const hookEntries = store.hookHashes.get(fingerprint.hookTextHash) || [];
  hookEntries.push(id);
  store.hookHashes.set(fingerprint.hookTextHash, hookEntries);

  // Enforce max stored fingerprints
  if (store.fingerprints.size > REGISTRY_CONFIG.maxStoredFingerprints) {
    evictOldest();
  }

  log.info('Content registered', {
    id,
    topic,
    hookPattern,
    totalRegistered: store.fingerprints.size,
  });

  return fingerprint;
}

// ─── EVICTION ───────────────────────────────────────────────

function evictOldest(): void {
  const entries = Array.from(store.fingerprints.entries())
    .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());

  const toEvict = entries.slice(0, Math.floor(entries.length * 0.1)); // evict oldest 10%

  for (const [id] of toEvict) {
    store.fingerprints.delete(id);
  }

  log.info('Registry eviction completed', {
    evicted: toEvict.length,
    remaining: store.fingerprints.size,
  });
}

// ─── STATS ──────────────────────────────────────────────────

export function getRegistryStats(): {
  totalFingerprints: number;
  uniqueTopics: number;
  uniqueHookPatterns: number;
} {
  return {
    totalFingerprints: store.fingerprints.size,
    uniqueTopics: store.topicHashes.size,
    uniqueHookPatterns: store.hookHashes.size,
  };
}

// ─── RESET (for testing) ────────────────────────────────────

export function resetRegistry(): void {
  store.fingerprints.clear();
  store.topicHashes.clear();
  store.hookHashes.clear();
  log.info('Registry reset');
}
