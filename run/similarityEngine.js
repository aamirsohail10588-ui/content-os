// ============================================================
// MODULE: similarityEngine.js
// PURPOSE: Embedding-based semantic dedup — cosine similarity, TF-IDF vectors
// PHASE: 3
// STATUS: ACTIVE
// NOTE: Uses local TF-IDF vectors as mock. Production: OpenAI embeddings + pgvector.
// WHY: Hash-based dedup (Phase 1) catches exact matches only.
//      This catches "same idea, different words" — prevents content recycling.
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('SimilarityEngine');

// ─── CONFIG ─────────────────────────────────────────────────

const SIMILARITY_CONFIG = {
  duplicateThreshold: 0.85,     // above this = reject as duplicate
  warningThreshold: 0.70,       // above this = warn, allow with caution
  embeddingDimensions: 128,     // mock vector size (production: 1536 for ada-002)
  maxStoredEmbeddings: 10000,
  vocabSize: 500,               // TF-IDF vocabulary cap
};

// ─── TF-IDF TOKENIZER ──────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function computeTF(tokens) {
  const tf = {};
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
  constructor() {
    this.vectors = new Map();   // id -> { vector, metadata }
    this.vocabulary = new Map(); // word -> { docFreq, index }
    this.docCount = 0;
  }

  // Build TF-IDF vector from text
  textToVector(text) {
    const tokens = tokenize(text);
    const tf = computeTF(tokens);

    // Update vocabulary with new terms
    const seenInDoc = new Set(tokens);
    for (const word of seenInDoc) {
      if (!this.vocabulary.has(word)) {
        if (this.vocabulary.size >= SIMILARITY_CONFIG.vocabSize) continue;
        this.vocabulary.set(word, { docFreq: 0, index: this.vocabulary.size });
      }
      this.vocabulary.get(word).docFreq++;
    }

    // Build sparse vector
    const vector = new Float32Array(SIMILARITY_CONFIG.embeddingDimensions).fill(0);

    for (const [word, freq] of Object.entries(tf)) {
      const vocabEntry = this.vocabulary.get(word);
      if (!vocabEntry) continue;

      const idf = Math.log((this.docCount + 1) / (vocabEntry.docFreq + 1)) + 1;
      const tfidf = freq * idf;

      // Hash word to vector dimension (feature hashing)
      const dimIndex = vocabEntry.index % SIMILARITY_CONFIG.embeddingDimensions;
      vector[dimIndex] += tfidf;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }

    return vector;
  }

  // Store embedding
  store(id, text, metadata = {}) {
    this.docCount++;
    const vector = this.textToVector(text);

    this.vectors.set(id, {
      vector,
      text: text.substring(0, 200), // store truncated for reference
      metadata,
      storedAt: new Date().toISOString(),
    });

    // Evict oldest if over limit
    if (this.vectors.size > SIMILARITY_CONFIG.maxStoredEmbeddings) {
      const oldest = this.vectors.keys().next().value;
      this.vectors.delete(oldest);
    }

    return { id, dimensions: vector.length };
  }

  // Cosine similarity between two vectors
  cosineSimilarity(a, b) {
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

  // Find most similar stored vectors
  findSimilar(text, topK = 5) {
    const queryVector = this.textToVector(text);
    const results = [];

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

  getStats() {
    return {
      storedVectors: this.vectors.size,
      vocabularySize: this.vocabulary.size,
      docCount: this.docCount,
      dimensions: SIMILARITY_CONFIG.embeddingDimensions,
    };
  }
}

// ─── SIMILARITY ENGINE ──────────────────────────────────────

class SimilarityEngine {
  constructor() {
    this.vectorStore = new VectorStore();
    this.checkHistory = [];

    log.info('SimilarityEngine initialized', {
      duplicateThreshold: SIMILARITY_CONFIG.duplicateThreshold,
      warningThreshold: SIMILARITY_CONFIG.warningThreshold,
      dimensions: SIMILARITY_CONFIG.embeddingDimensions,
    });
  }

  // ─── CHECK SIMILARITY (semantic dedup) ─────────────────

  check(text, options = {}) {
    const threshold = options.threshold || SIMILARITY_CONFIG.duplicateThreshold;
    const topK = options.topK || 5;

    const similar = this.vectorStore.findSimilar(text, topK);
    const highestSimilarity = similar.length > 0 ? similar[0].similarity : 0;

    const isDuplicate = highestSimilarity >= threshold;
    const isWarning = !isDuplicate && highestSimilarity >= SIMILARITY_CONFIG.warningThreshold;

    const result = {
      isDuplicate,
      isWarning,
      highestSimilarity,
      threshold,
      warningThreshold: SIMILARITY_CONFIG.warningThreshold,
      matches: similar.filter(s => s.similarity >= SIMILARITY_CONFIG.warningThreshold),
      checkedAgainst: this.vectorStore.vectors.size,
      verdict: isDuplicate ? 'REJECT' : isWarning ? 'WARN' : 'PASS',
    };

    // If duplicate, generate mutation suggestions
    if (isDuplicate || isWarning) {
      result.mutationSuggestions = this._suggestMutations(text, similar[0]);
    }

    this.checkHistory.push({
      timestamp: new Date().toISOString(),
      textPreview: text.substring(0, 100),
      verdict: result.verdict,
      highestSimilarity,
    });

    log.info('Similarity check', {
      verdict: result.verdict,
      highestSimilarity,
      matchCount: result.matches.length,
      storedVectors: this.vectorStore.vectors.size,
    });

    return result;
  }

  // ─── REGISTER CONTENT (store embedding) ────────────────

  register(id, text, metadata = {}) {
    const stored = this.vectorStore.store(id, text, metadata);
    log.info('Content registered in similarity engine', {
      id,
      dimensions: stored.dimensions,
      totalStored: this.vectorStore.vectors.size,
    });
    return stored;
  }

  // ─── MUTATION SUGGESTIONS ──────────────────────────────

  _suggestMutations(text, matchedEntry) {
    // Suggest ways to make content sufficiently different
    const suggestions = [
      {
        type: 'angle_shift',
        description: 'Change the perspective or angle of approach',
        example: 'Instead of "how to save money", try "why most people fail at saving"',
      },
      {
        type: 'audience_shift',
        description: 'Target a different audience segment',
        example: 'Instead of general advice, target "college students" or "retirees"',
      },
      {
        type: 'format_shift',
        description: 'Change the content format or structure',
        example: 'Switch from listicle to story-driven or myth-busting format',
      },
      {
        type: 'data_update',
        description: 'Use more recent data or different statistics',
        example: 'Update with latest year data, different study, or regional focus',
      },
    ];

    // Contextual suggestion based on match
    if (matchedEntry && matchedEntry.similarity > 0.9) {
      suggestions.unshift({
        type: 'topic_change',
        description: 'Content is too close — consider a different sub-topic entirely',
        example: `Original covered "${matchedEntry.textPreview.substring(0, 50)}..." — pick a new angle`,
      });
    }

    return suggestions;
  }

  // ─── BATCH CHECK ───────────────────────────────────────

  batchCheck(texts) {
    return texts.map((text, i) => ({
      index: i,
      textPreview: text.substring(0, 80),
      ...this.check(text),
    }));
  }

  // ─── STATS ─────────────────────────────────────────────

  getStats() {
    return {
      vectorStore: this.vectorStore.getStats(),
      checksPerformed: this.checkHistory.length,
      recentChecks: this.checkHistory.slice(-10),
      config: SIMILARITY_CONFIG,
    };
  }

  // ─── CLEAN ─────────────────────────────────────────────

  clean() {
    this.vectorStore = new VectorStore();
    this.checkHistory = [];
    log.info('SimilarityEngine cleaned');
  }
}

// ─── SINGLETON ──────────────────────────────────────────────

const similarityEngine = new SimilarityEngine();

module.exports = {
  SimilarityEngine,
  similarityEngine,
  SIMILARITY_CONFIG,
};
