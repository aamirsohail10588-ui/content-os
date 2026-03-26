// ============================================================
// MODULE: types/index.ts
// PURPOSE: Shared type definitions for entire Content OS system
// PHASE: 1
// STATUS: ACTIVE
// ============================================================

// ─── ENUMS ──────────────────────────────────────────────────

export enum HookPattern {
  CURIOSITY_GAP = 'curiosity_gap',
  SHOCKING_STAT = 'shocking_stat',
  DIRECT_QUESTION = 'direct_question',
  PATTERN_INTERRUPT = 'pattern_interrupt',
  BOLD_CLAIM = 'bold_claim',
  STORY_OPEN = 'story_open',
  CONTRARIAN = 'contrarian',
}

export enum VideoFormat {
  YOUTUBE_SHORT = 'youtube_short',
  INSTAGRAM_REEL = 'instagram_reel',
  TIKTOK = 'tiktok',
}

export enum PipelineStage {
  DEDUP_CHECK = 'dedup_check',
  TOPIC_RESEARCH = 'topic_research',
  HOOK_GENERATION = 'hook_generation',
  SCRIPT_GENERATION = 'script_generation',
  VISUAL_MAPPING = 'visual_mapping',
  VOICE_GENERATION = 'voice_generation',
  VIDEO_ASSEMBLY = 'video_assembly',
  QUALITY_SCORING = 'quality_scoring',
  REGISTRY_STORE = 'registry_store',
  COMPLETE = 'complete',
}

export enum JobStatus {
  QUEUED = 'queued',
  IN_PROGRESS = 'in_progress',
  CHECKPOINT = 'checkpoint',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DEAD_LETTER = 'dead_letter',
}

// ─── CORE TYPES ─────────────────────────────────────────────

export interface ContentConfig {
  niche: string;
  subNiche: string;
  tone: string;
  targetDurationSeconds: number;
  format: VideoFormat;
  aiProvider: 'claude' | 'openai';
  maxVariants: number;
}

export interface AccountIdentity {
  accountId: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  channelName: string;
  niche: string;
  tone: string;
  audienceProfile: string;
}

// ─── HOOK TYPES ─────────────────────────────────────────────

export interface Hook {
  id: string;
  text: string;
  pattern: HookPattern;
  estimatedDurationSeconds: number;
  strengthScore: number; // 0-100
  topic: string;
  fingerprint: string;
}

export interface HookGenerationRequest {
  topic: string;
  niche: string;
  tone: string;
  targetDurationSeconds: number;
  variantCount: number;
  excludePatterns?: HookPattern[];
  voiceLanguage?: string;
  researchBrief?: string;
}

export interface HookGenerationResult {
  hooks: Hook[];
  generationTimeMs: number;
  tokensUsed: number;
  provider: string;
}

// ─── SCRIPT TYPES ───────────────────────────────────────────

export interface ScriptSegment {
  index: number;
  text: string;
  estimatedDurationSeconds: number;
  visualCue: string;
  emotionalBeat: string;
  visual_query?: string;
  visual_type?: 'video' | 'image';
  emotion?: string;
}

export interface Script {
  id: string;
  hook: Hook;
  segments: ScriptSegment[];
  fullText: string;
  totalDurationSeconds: number;
  wordCount: number;
  topic: string;
  fingerprint: string;
}

export interface ScriptGenerationRequest {
  hook: Hook;
  topic: string;
  niche: string;
  tone: string;
  targetDurationSeconds: number;
  keyPoints?: string[];
  voiceLanguage?: string;
  researchBrief?: string;
}

export interface ScriptGenerationResult {
  script: Script;
  generationTimeMs: number;
  tokensUsed: number;
  provider: string;
}

// ─── VIDEO ASSEMBLY TYPES ───────────────────────────────────

export interface VisualInstruction {
  segmentIndex: number;
  description: string;
  assetType: 'stock_video' | 'stock_image' | 'text_overlay' | 'transition';
  startTimeSeconds: number;
  durationSeconds: number;
}

export interface AudioTrack {
  filePath: string;
  durationSeconds: number;
  format: string;
  sampleRate: number;
}

export interface CaptionEntry {
  text: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  style: 'highlight' | 'fade' | 'pop';
}

export interface VideoAssemblyRequest {
  script: Script;
  audioTrack: AudioTrack;
  visuals: VisualInstruction[];
  captions: CaptionEntry[];
  outputFormat: VideoFormat;
  resolution: { width: number; height: number };
}

export interface VideoAssemblyResult {
  outputPath: string;
  durationSeconds: number;
  fileSizeBytes: number;
  resolution: { width: number; height: number };
  assemblyTimeMs: number;
}

// ─── CONTENT REGISTRY TYPES ────────────────────────────────

export interface ContentFingerprint {
  id: string;
  topicHash: string;
  hookPatternUsed: HookPattern;
  hookTextHash: string;
  scriptStructureHash: string;
  fullTextHash: string;
  embedding?: number[];
  createdAt: Date;
  metadata: {
    topic: string;
    niche: string;
    durationSeconds: number;
  };
}

export interface SimilarityCheckResult {
  isDuplicate: boolean;
  highestSimilarity: number;
  matchedFingerprintId: string | null;
  threshold: number;
  checkedAgainst: number;
}

// ─── PIPELINE TYPES ─────────────────────────────────────────

export interface PipelineJob {
  jobId: string;
  config: ContentConfig;
  topic: string;
  currentStage: PipelineStage;
  status: JobStatus;
  checkpoint: PipelineCheckpoint | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineCheckpoint {
  stage: PipelineStage;
  data: {
    hook?: Hook;
    script?: Script;
    audioTrack?: AudioTrack;
    visuals?: VisualInstruction[];
    captions?: CaptionEntry[];
    assemblyResult?: VideoAssemblyResult;
    researchBrief?: string;
  };
  timestamp: Date;
}

export interface PipelineResult {
  jobId: string;
  success: boolean;
  video?: VideoAssemblyResult;
  script?: Script;
  hook?: Hook;
  fingerprint?: ContentFingerprint;
  totalTimeMs: number;
  stagesCompleted: PipelineStage[];
  error?: PipelineError;
}

// ─── ERROR TYPES ────────────────────────────────────────────

export interface PipelineError {
  stage: PipelineStage;
  code: string;
  message: string;
  retryable: boolean;
  timestamp: Date;
  details?: Record<string, unknown>;
}

// ─── QUALITY TYPES ──────────────────────────────────────────

export interface QualityScore {
  overall: number; // 0-100
  hookStrength: number;
  pacingConsistency: number;
  scriptCoherence: number;
  estimatedRetention: number;
  breakdown: Record<string, number>;
}

// ─── LOGGER INTERFACE ───────────────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}
