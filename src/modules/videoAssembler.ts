// ============================================================
// MODULE: modules/videoAssembler.ts
// PURPOSE: FFmpeg-based video assembly pipeline
// PHASE: 1
// STATUS: ACTIVE
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import {
  Script,
  VideoAssemblyResult,
  VideoFormat,
  VisualInstruction,
  CaptionEntry,
} from '../types';
import { VIDEO_CONFIG, SYSTEM_CONFIG } from '../config';
import { createLogger } from '../infra/logger';
import { generateVoice } from './voiceGenerator';
import { fetchStockClips } from '../infra/stockFetcher';

const log = createLogger('VideoAssembler');

// ─── FONT NAMES (fontconfig — spaces OK in filter_complex, no colon issue) ──

const FONT_BOLD   = 'Arial Bold';
const FONT_NORMAL = 'Arial';

// ─── BEAT ACCENT COLORS (used for panels, bars, highlights) ──

const BEAT_ACCENTS: Record<string, string> = {
  hook:        'ff2233',  // hot red
  context:     'ff8800',  // orange
  explanation: '00aaff',  // blue
  impact:      'ffcc00',  // gold
  cta:         '00cc66',  // green
  tension:     'ff2233',
  revelation:  '00aaff',
  proof:       'ffffff',
  application: '00cc66',
  urgency:     'ffcc00',
};

// ─── BEAT DISPLAY LABELS ─────────────────────────────────────

const BEAT_LABELS: Record<string, string> = {
  hook:        'BREAKING',
  context:     'STORY',
  explanation: 'BREAKDOWN',
  impact:      'IMPACT',
  cta:         'ACTION',
  tension:     'TENSION',
  revelation:  'REVEAL',
  proof:       'FACT',
  application: 'HOW TO',
  urgency:     'URGENT',
};

// ─── TEXT HELPERS ────────────────────────────────────────────

// Make text safe for FFmpeg drawtext (no shell quoting — we pass via args array)
function sanitize(text: string, maxLen = 48): string {
  return text
    .replace(/\u2014|\u2013|\u2012/g, '-')  // em dash, en dash → hyphen
    .replace(/\u2018|\u2019|\u201A/g, "'")  // curly single quotes → straight
    .replace(/\u201C|\u201D|\u201E/g, '"')  // curly double quotes → straight
    .replace(/[^\x00-\x7F]/g, ' ')          // strip all non-ASCII (Devanagari, etc.)
    .replace(/'/g, '\u2019')                // now safe: re-apply smart apostrophe
    .replace(/[\\:,\[\];{}%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

function wrapText(text: string, maxChars = 28): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current.length > 0) {
      lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines.slice(0, 3); // max 3 lines
}

// ─── CAPTION GROUP BUILDER ───────────────────────────────────

interface CaptionGroup {
  text: string;
  startT: number;
  endT: number;
}

function buildCaptionGroups(text: string, durationSeconds: number): CaptionGroup[] {
  const safeText = text
    .replace(/\u2014|\u2013|\u2012/g, '-')
    .replace(/\u2018|\u2019|\u201A/g, "'")
    .replace(/\u201C|\u201D|\u201E/g, '"')
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/[\\:,\[\];{}%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = safeText.split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const WORDS_PER_GROUP = 3;
  const groups: CaptionGroup[] = [];
  const totalGroups = Math.ceil(words.length / WORDS_PER_GROUP);
  const timePerGroup = durationSeconds / totalGroups;

  for (let i = 0; i < totalGroups; i++) {
    const chunk = words.slice(i * WORDS_PER_GROUP, (i + 1) * WORDS_PER_GROUP);
    const groupText = chunk.join(' ').substring(0, 36); // cap length for screen width
    groups.push({
      text: groupText,
      startT: i * timePerGroup,
      endT: (i + 1) * timePerGroup,
    });
  }

  return groups;
}

// ─── VISUAL INSTRUCTION BUILDER ──────────────────────────────

export function buildVisualInstructions(script: Script): VisualInstruction[] {
  const instructions: VisualInstruction[] = [];
  let currentTime = 0;
  for (const segment of script.segments) {
    instructions.push({
      segmentIndex: segment.index,
      description: segment.visualCue,
      assetType: segment.visualCue.startsWith('text_overlay') ? 'text_overlay' : 'stock_video',
      startTimeSeconds: currentTime,
      durationSeconds: segment.estimatedDurationSeconds,
    });
    currentTime += segment.estimatedDurationSeconds;
  }
  return instructions;
}

// ─── CAPTION BUILDER ─────────────────────────────────────────

export function buildCaptions(script: Script): CaptionEntry[] {
  const captions: CaptionEntry[] = [];
  let currentTime = 0;
  for (const segment of script.segments) {
    const words = segment.text.split(/\s+/);
    const wordsPerCaption = 4;
    const captionDuration = segment.estimatedDurationSeconds / Math.ceil(words.length / wordsPerCaption);
    for (let i = 0; i < words.length; i += wordsPerCaption) {
      const captionText = words.slice(i, i + wordsPerCaption).join(' ');
      const style = segment.emotionalBeat === 'hook' ? 'pop' as const
        : segment.emotionalBeat === 'cta' ? 'highlight' as const
        : 'fade' as const;
      captions.push({
        text: captionText,
        startTimeSeconds: Math.round(currentTime * 100) / 100,
        endTimeSeconds: Math.round((currentTime + captionDuration) * 100) / 100,
        style,
      });
      currentTime += captionDuration;
    }
  }
  return captions;
}


// ─── REAL FFMPEG ASSEMBLY ────────────────────────────────────

function runRealFfmpeg(
  script: Script,
  resolution: { width: number; height: number },
  outputPath: string,
  audioPath?: string,
  stockClips: (string | null)[] = []
): void {
  const { width: W, height: H } = resolution;
  const segments = script.segments;

  // Build inputs: stock clips where available, lavfi color fallback otherwise
  const inputs: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = Math.max(0.5, seg.estimatedDurationSeconds);
    const clip = stockClips[i];
    if (clip && fs.existsSync(clip)) {
      // Loop clip in case it's shorter than segment duration
      inputs.push('-stream_loop', '-1', '-t', String(dur), '-i', clip);
    } else {
      inputs.push('-f', 'lavfi', '-i', `color=c=0x060912:size=${W}x${H}:duration=${dur}:rate=30`);
    }
  }

  const filterParts: string[] = [];
  const topicSafe = sanitize(script.topic, 36);
  const totalSegs = segments.length;

  for (let i = 0; i < totalSegs; i++) {
    const seg = segments[i];
    const clip = stockClips[i];
    const hasStockClip = !!(clip && fs.existsSync(clip));
    const accent = BEAT_ACCENTS[seg.emotionalBeat] ?? 'ff2233';
    const beatLabel = BEAT_LABELS[seg.emotionalBeat] ?? seg.emotionalBeat.toUpperCase();
    const isHook = seg.emotionalBeat === 'hook';
    const isCta = seg.emotionalBeat === 'cta';

    // Progress bar width (bottom)
    const progressW = Math.round(((i + 1) / totalSegs) * W);

    let f = `[${i}:v]`;

    // ── 1. BASE LAYER — stock footage or dark background ──────
    if (hasStockClip) {
      // Scale to portrait, force yuv420p for consistent color space, then light scrim
      f += `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p,setpts=PTS-STARTPTS`;
      // Very light scrim — just enough to make white text readable, keeps footage colors vivid
      f += `,drawbox=x=0:y=0:w=${W}:h=${H}:color=0x000000@0.28:t=fill`;
    } else {
      // Fallback: deep dark background with subtle gradient overlays
      f += `drawbox=x=0:y=0:w=${W}:h=${Math.round(H * 0.5)}:color=0x0a0f1e@0.35:t=fill`;
      f += `,drawbox=x=0:y=${Math.round(H * 0.5)}:w=${W}:h=${Math.round(H * 0.5)}:color=0x03060e@0.35:t=fill`;
    }

    // ── 2. TOP HEADER BAR ──────────────────────────────────────
    f += `,drawbox=x=0:y=0:w=${W}:h=108:color=0x0a0d1a@1:t=fill`;
    // accent line under header
    f += `,drawbox=x=0:y=106:w=${W}:h=4:color=0x${accent}@1:t=fill`;
    // beat badge (left)
    f += `,drawbox=x=32:y=30:w=200:h=48:color=0x${accent}@0.18:t=fill`;
    f += `,drawbox=x=32:y=30:w=4:h=48:color=0x${accent}@1:t=fill`;
    f += `,drawtext=font=${FONT_BOLD}:text='${sanitize(beatLabel, 14)}':fontcolor=0x${accent}:fontsize=22:x=46:y=46`;
    // topic (right)
    f += `,drawtext=font=${FONT_NORMAL}:text='${topicSafe}':fontcolor=white@0.4:fontsize=18:x=(w-text_w-36):y=44`;

    // ── 3. LOWER-THIRD CAPTION (static for full segment duration) ──
    // No enable= expression needed — each segment is its own clip, naturally timed.
    const captionBarY = Math.round(H * 0.80);
    f += `,drawbox=x=0:y=${captionBarY - 14}:w=${W}:h=100:color=0x000000@0.78:t=fill`;
    f += `,drawbox=x=0:y=${captionBarY - 14}:w=${W}:h=4:color=0x${accent}@0.9:t=fill`;
    const captionLines = wrapText(seg.text, 22);
    captionLines.forEach((line, li) => {
      f += `,drawtext=font=${FONT_BOLD}:text='${sanitize(line, 36)}':fontcolor=0x${accent}:fontsize=38:shadowcolor=black:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${captionBarY + 10 + li * 44}`;
    });

    // ── 4. PROGRESS BAR (bottom) ──────────────────────────────
    f += `,drawbox=x=0:y=${H - 8}:w=${W}:h=8:color=0x111827@1:t=fill`;
    f += `,drawbox=x=0:y=${H - 8}:w=${progressW}:h=8:color=0x${accent}@1:t=fill`;

    // ── 6. SEGMENT DOTS ───────────────────────────────────────
    const dotSpacing = 28;
    const totalDotsW = totalSegs * dotSpacing;
    const dotsStartX = Math.round((W - totalDotsW) / 2);
    for (let d = 0; d < totalSegs; d++) {
      const dotX = dotsStartX + d * dotSpacing;
      const dotColor = d <= i ? `0x${accent}` : 'white@0.2';
      f += `,drawbox=x=${dotX}:y=${H - 36}:w=14:h=14:color=${dotColor}:t=fill`;
    }

    // ── 7. VIGNETTE (cinematic depth — subtle, only on dark backgrounds) ──
    if (!hasStockClip) f += `,vignette=PI/5`;

    f += `[v${i}]`;
    filterParts.push(f);
  }

  // Concatenate all segment clips
  const concatIn = segments.map((_, i) => `[v${i}]`).join('');
  filterParts.push(`${concatIn}concat=n=${totalSegs}:v=1:a=0[out]`);

  const filterComplex = filterParts.join('; ');

  const audioSizeOk = !!(audioPath && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000);
  const audioInputs: string[] = audioSizeOk ? ['-i', audioPath!] : [];
  const audioIndex = segments.length;
  const hasAudio = audioInputs.length > 0;

  const args = [
    '-y',
    ...inputs,
    ...audioInputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    ...(hasAudio ? ['-map', `${audioIndex}:a`] : []),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-an']),
    outputPath,
  ];

  log.info('Running FFmpeg', { segments: segments.length, output: outputPath });

  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').slice(-2000);
    log.error('FFmpeg stderr', { stderr });
    throw new Error(`FFmpeg exited ${result.status}: ${stderr}`);
  }
}

// ─── MAIN: ASSEMBLE VIDEO ────────────────────────────────────

export async function assembleVideo(
  script: Script,
  format: VideoFormat = VideoFormat.YOUTUBE_SHORT,
  voiceOptions?: { language?: string; gender?: string }
): Promise<VideoAssemblyResult> {
  const startTime = Date.now();
  const jobId = uuidv4();

  log.info('Starting video assembly', {
    jobId,
    scriptId: script.id,
    format,
    duration: script.totalDurationSeconds,
    segments: script.segments.length,
  });

  const visuals  = buildVisualInstructions(script);
  const captions = buildCaptions(script);

  const resolutionKey = format as keyof typeof VIDEO_CONFIG.resolution;
  const resolution = VIDEO_CONFIG.resolution[resolutionKey] ?? VIDEO_CONFIG.resolution.youtube_short;

  ensureDir(VIDEO_CONFIG.outputDir);
  ensureDir(VIDEO_CONFIG.tempDir);

  const outputPath = path.join(VIDEO_CONFIG.outputDir, `${jobId}.mp4`);

  // ── STEP 1: Generate voice audio ──────────────────────────
  let audioPath: string | undefined;
  try {
    const voice = await generateVoice(script, voiceOptions);
    audioPath = voice.audioPath;
    log.info('Voice ready', { audioPath, mock: voice.isMock, voice: voice.voiceId });
  } catch (err) {
    log.warn('Voice generation skipped', { error: (err as Error).message });
  }

  // ── STEP 2: Fetch stock footage clips in parallel ─────────
  let stockClips: (string | null)[] = [];
  try {
    if (process.env.PEXELS_API_KEY) {
      log.info('Fetching stock clips', { segments: script.segments.length });
      stockClips = await fetchStockClips(script.segments);
      const fetched = stockClips.filter(Boolean).length;
      log.info('Stock clips ready', { fetched, total: script.segments.length });
    }
  } catch (err) {
    log.warn('Stock clip fetch failed — using dark background', { error: (err as Error).message });
  }

  // ── STEP 3: Assemble video with FFmpeg ────────────────────
  let usedRealFfmpeg = false;

  try {
    runRealFfmpeg(script, resolution, outputPath, audioPath, stockClips);
    usedRealFfmpeg = true;
    log.info('FFmpeg assembly complete', { outputPath, hasAudio: !!audioPath });
  } catch (err) {
    // FFmpeg failed — write manifest placeholder
    const manifest = {
      jobId, scriptId: script.id, format, resolution,
      duration: script.totalDurationSeconds,
      segments: script.segments.length,
      captions: captions.length,
      assembledAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      outputPath.replace('.mp4', '.manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    log.warn('FFmpeg failed — manifest written', { error: (err as Error).message });
  }

  const assemblyTimeMs = Date.now() - startTime;

  // Get actual file size if real file was produced, otherwise estimate
  let fileSizeBytes: number;
  if (usedRealFfmpeg && fs.existsSync(outputPath)) {
    fileSizeBytes = fs.statSync(outputPath).size;
  } else {
    fileSizeBytes = Math.floor((4_000_000 / 8) * script.totalDurationSeconds);
  }

  const result: VideoAssemblyResult = {
    outputPath,
    durationSeconds: script.totalDurationSeconds,
    fileSizeBytes,
    resolution,
    assemblyTimeMs,
  };

  log.info('Video assembly complete', {
    jobId,
    outputPath,
    duration: result.durationSeconds,
    fileSizeMB: Math.round(fileSizeBytes / 1024 / 1024 * 100) / 100,
    assemblyTimeMs,
    real: usedRealFfmpeg,
  });

  return result;
}

// ─── UTILITY ─────────────────────────────────────────────────

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}
