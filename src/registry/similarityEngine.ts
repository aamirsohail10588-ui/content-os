// ============================================================
// MODULE: registry/similarityEngine.ts
// PURPOSE: Embedding-based semantic dedup — cosine similarity, TF-IDF vectors
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Uses local TF-IDF vectors as mock. Production: OpenAI embeddings + pgvector.
// WHY: Hash-based dedup (Phase 1) catches exact matches only.
//      This catches "same idea, different words" — prevents content recycling.
// ============================================================

import { Logger } from '../types';
import { createLogger } from '../infra/logger';

const log: Logger = createLogger('SimilarityEngine');

// ─── CONFIG ─────────────────────────────────────────────────

export interface SimilarityConfig {
  duplicateThreshold: number;
  warningThreshold: number;
  embeddingDimensions: number;
  maxStoredEmbeddings: number;
  vocabSize: number;
}

export const SIMILARITY_CONFIG: Readonly<SimilarityConfig> = {
  duplicateThreshold: 0.85,
  warningThreshold: 0.70,
  embeddingDimensions: 128,
  maxStoredEmbeddings: 10000,
  vocabSize: 500,
};

// ─── INTERFACES ─────────────────────────────────────────────

export interface SimilarMatch {
  id: string;
  similarity: number;
  textPreview: string;
  metadata: Record<string, unknown>;
}

export interface MutationSuggestion {
  type: string;
  description: string;
  example: string;
}

export type SimilarityVerdict = 'REJECT' | 'WARN' | 'PASS';

export interface SimilarityCheckResult {
  isDuplicate: boolean;
  isWarning: boolean;
  highestSimilarity: number;
  threshold: number;
  warningThreshold: number;
  matches: SimilarMatch[];
  checkedAgainst: number;
  verdict: SimilarityVerdict;
  mutationSuggestions?: MutationSuggestion[];
}

export interface BatchCheckResult extends SimilarityCheckResult {
  index: number;
  textPreview: string;
}

export interface VectorStoreStats {
  storedVectors: number;
  vocabularySize: number;
  docCount: number;
  dimensions: number;
}

export interface SimilarityStats {
  vectorStore: VectorStoreStats;
  checksPerformed: number;
  recentChecks: CheckHistoryEntry[];
  config: SimilarityConfig;
}

interface CheckHistoryEntry {
  timestamp: string;
  textPreview: string;
  verdict: SimilarityVerdict;
  highestSimilarity: number;
}

interface StoredVector {
  vector: Float32Array;
  text: string;
  metadata: Record<string, unknown>;
  storedAt: string;
}

interface VocabEntry {
  docFreq: number;
  index: number;
}

// ─── TF-IDF TOKENIZER ──────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function computeTF(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  const total = tokens.length;
  for (const key of Object.keys(tf)) {
    tf[key] = tf[key] / total;
  }
  return tf;
}

// ─── VECTOR STORE ───────────────────────────────────────────

class VectorStore {
  vectors: Map<string, StoredVector>;
  private vocabulary: Map<string, VocabEntry>;
  private docCount: number;

  constructor() {
    this.vectors = new Map();
    this.vocabulary = new Map();
    this.docCount = 0;
  }

  textToVector(text: string): Float32Array {
    const tokens = tokenize(text);
    const tf = computeTF(tokens);

    const seenInDoc = new Set(tokens);
    for (const word of seenInDoc) {
      if (!this.vocabulary.has(word)) {
        if (this.vocabulary.size >= SIMILARITY_CONFIG.vocabSize) continue;
        this.vocabulary.set(word, { docFreq: 0, index: this.vocabulary.size });
      }
      this.vocabulary.get(word)!.docFreq++;
    }

    const vector = new Float32Array(SIMILARITY_CONFIG.embeddingDimensions).fill(0);

    for (const [word, freq] of Object.entries(tf)) {
      const vocabEntry = this.vocabulary.get(word);
      if (!vocabEntry) continue;

      const idf = Math.log((this.docCount + 1) / (vocabEntry.docFreq + 1)) + 1;
      const tfidf = freq * idf;
      const dimIndex = vocabEntry.index % SIMILARITY_CONFIG.embeddingDimensions;
      vector[dimIndex] += tfidf;
    }

    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }

    return vector;
  }

  store(id: string, text: string, metadata: Record<string, unknown> = {}): { id: string; dimensions: number } {
    this.docCount++;
    const vector = this.textToVector(text);

    this.vectors.set(id, {
      vector,
      text: text.substring(0, 200),
      metadata,
      storedAt: new Date().toISOString(),
    });

    if (this.vectors.size > SIMILARITY_CONFIG.maxStoredEmbeddings) {
      const oldest = this.vectors.keys().next().value;
      if (oldest) this.vectors.delete(oldest);
    }

    return { id, dimensions: vector.length };
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  findSimilar(text: string, topK: number = 5): SimilarMatch[] {
    const queryVector = this.textToVector(text);
    const results: SimilarMatch[] = [];

    for (const [id, entry] of this.vectors) {
      const similarity = this.cosineSimilarity(queryVector, entry.vector);
      results.push({
        id,
        similarity: Math.round(similarity * 10000) / 10000,
        textPreview: entry.text,
        metadata: entry.metadata,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  getStats(): VectorStoreStats {
    return {
      storedVectors: this.vectors.size,
      vocabularySize: this.vocabulary.size,
      docCount: this.docCount,
      dimensions: SIMILARITY_CONFIG.embeddingDimensions,
    };
  }
}

// ─── SIMILARITY ENGINE ──────────────────────────────────────

export class SimilarityEngine {
  private vectorStore: VectorStore;
  private checkHistory: CheckHistoryEntry[];

  constructor() {
    this.vectorStore = new VectorStore();
    this.checkHistory = [];
    log.info('SimilarityEngine initialized', {
      duplicateThreshold: SIMILARITY_CONFIG.duplicateThreshold,
      warningThreshold: SIMILARITY_CONFIG.warningThreshold,
      dimensions: SIMILARITY_CONFIG.embeddingDimensions,
    });
  }

  check(text: string, options: { threshold?: number; topK?: number } = {}): SimilarityCheckResult {
    const threshold = options.threshold || SIMILARITY_CONFIG.duplicateThreshold;
    const topK = options.topK || 5;

    const similar = this.vectorStore.findSimilar(text, topK);
    const highestSimilarity = similar.length > 0 ? similar[0].similarity : 0;

    const isDuplicate = highestSimilarity >= threshold;
    const isWarning = !isDuplicate && highestSimilarity >= SIMILARITY_CONFIG.warningThreshold;

    const verdict: SimilarityVerdict = isDuplicate ? 'REJECT' : isWarning ? 'WARN' : 'PASS';

    const result: SimilarityCheckResult = {
      isDuplicate,
      isWarning,
      highestSimilarity,
      threshold,
      warningThreshold: SIMILARITY_CONFIG.warningThreshold,
      matches: similar.filter(s => s.similarity >= SIMILARITY_CONFIG.warningThreshold),
      checkedAgainst: this.vectorStore.vectors.size,
      verdict,
    };

    if (isDuplicate || isWarning) {
      result.mutationSuggestions = this._suggestMutations(text, similar[0]);
    }

    this.checkHistory.push({
      timestamp: new Date().toISOString(),
      textPreview: text.substring(0, 100),
      verdict,
      highestSimilarity,
    });

    log.info('Similarity check', { verdict, highestSimilarity, matchCount: result.matches.length });
    return result;
  }

  register(id: string, text: string, metadata: Record<string, unknown> = {}): { id: string; dimensions: number } {
    const stored = this.vectorStore.store(id, text, metadata);
    log.info('Content registered in similarity engine', { id, dimensions: stored.dimensions, totalStored: this.vectorStore.vectors.size });
    return stored;
  }

  private _suggestMutations(_text: string, matchedEntry?: SimilarMatch): MutationSuggestion[] {
    const suggestions: MutationSuggestion[] = [];

    if (matchedEntry && matchedEntry.similarity > 0.9) {
      suggestions.push({
        type: 'topic_change',
        description: 'Content is too close — consider a different sub-topic entirely',
        example: `Original covered "${matchedEntry.textPreview.substring(0, 50)}..." — pick a new angle`,
      });
    }

    suggestions.push(
      { type: 'angle_shift', description: 'Change the perspective or angle of approach', example: 'Instead of "how to save money", try "why most people fail at saving"' },
      { type: 'audience_shift', description: 'Target a different audience segment', example: 'Instead of general advice, target "college students" or "retirees"' },
      { type: 'format_shift', description: 'Change the content format or structure', example: 'Switch from listicle to story-driven or myth-busting format' },
      { type: 'data_update', description: 'Use more recent data or different statistics', example: 'Update with latest year data, different study, or regional focus' },
    );

    return suggestions;
  }

  batchCheck(texts: string[]): BatchCheckResult[] {
    return texts.map((text, i) => ({
      index: i,
      textPreview: text.substring(0, 80),
      ...this.check(text),
    }));
  }

  getStats(): SimilarityStats {
    return {
      vectorStore: this.vectorStore.getStats(),
      checksPerformed: this.checkHistory.length,
      recentChecks: this.checkHistory.slice(-10),
      config: SIMILARITY_CONFIG,
    };
  }

  clean(): void {
    this.vectorStore = new VectorStore();
    this.checkHistory = [];
    log.info('SimilarityEngine cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

export const similarityEngine = new SimilarityEngine();
