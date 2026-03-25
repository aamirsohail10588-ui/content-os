// ============================================================
// MODULE: videoAssembler.js
// PURPOSE: FFmpeg-based video assembly — influencer style
// PHASE: 1
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');
const { createLogger } = require('./logger');
const { VIDEO_CONFIG } = require('./config');

const log = createLogger('VideoAssembler');

// ─── VOICE GENERATOR (ElevenLabs) ────────────────────────────

// ─── VOICE CONFIG ─────────────────────────────────────────────
// ElevenLabs voice IDs + Edge TTS fallback voices per language/gender
const VOICE_CONFIG = {
  english: {
    male:   { elevenLabsId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_turbo_v2_5',    edgeVoice: 'en-US-GuyNeural' },
    female: { elevenLabsId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_turbo_v2_5',    edgeVoice: 'en-US-JennyNeural' },
  },
  hindi: {
    male:   { elevenLabsId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_multilingual_v2', edgeVoice: 'hi-IN-MadhurNeural' },
    female: { elevenLabsId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_multilingual_v2', edgeVoice: 'hi-IN-SwaraNeural' },
  },
  hinglish: {
    male:   { elevenLabsId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_multilingual_v2', edgeVoice: 'en-IN-PrabhatNeural' },
    female: { elevenLabsId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_multilingual_v2', edgeVoice: 'en-IN-NeerjaNeural' },
  },
};

async function generateVoice(text, outputPath, language = 'english', gender = 'male') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.warn('No ELEVENLABS_API_KEY — skipping voice');
    return false;
  }

  const lang = VOICE_CONFIG[language] || VOICE_CONFIG.english;
  const voiceCfg = lang[gender] || lang.male;
  const voiceId = voiceCfg.elevenLabsId;
  const modelId = voiceCfg.model;

  const body = JSON.stringify({
    text,
    model_id: modelId,
    voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true },
  });

  log.info('Generating voice via ElevenLabs', { voiceId, modelId, language, gender, chars: text.length });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', d => errBody += d);
        res.on('end', () => {
          log.warn('ElevenLabs API error', { status: res.statusCode, body: errBody.slice(0, 150) });
          resolve(false);
        });
        return;
      }
      const writer = fs.createWriteStream(outputPath);
      res.pipe(writer);
      writer.on('finish', () => {
        const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
        log.info('Voice audio saved', { outputPath, sizeKB: Math.round(size / 1024) });
        resolve(size > 500); // valid if > 500 bytes
      });
      writer.on('error', (err) => {
        log.warn('Voice write error', { error: err.message });
        resolve(false);
      });
    });

    req.on('error', (err) => {
      log.warn('ElevenLabs request failed', { error: err.message });
      resolve(false);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      log.warn('ElevenLabs request timed out');
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

// ─── TEXT HELPERS ────────────────────────────────────────────

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')   // smart apostrophe avoids FFmpeg quoting issues
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/%/g, '\\%')
    .trim()
    .substring(0, 70);
}

// Split text into max 2 balanced lines
function splitToLines(text, maxCharsPerLine = 22) {
  const words = text.split(' ');
  if (text.length <= maxCharsPerLine) return [text];
  const mid = Math.ceil(words.length / 2);
  const line1 = words.slice(0, mid).join(' ');
  const line2 = words.slice(mid).join(' ');
  return [line1, line2].filter(Boolean);
}

// ─── BUILD CAPTIONS ──────────────────────────────────────────

function buildCaptions(script) {
  const captions = [];
  let currentTime = 0;
  for (const seg of script.segments) {
    const words = seg.text.split(/\s+/);
    const wordsPerCaption = 3; // 3 words per flash — punchy, like top creators
    const captionCount = Math.ceil(words.length / wordsPerCaption);
    const captionDuration = seg.estimatedDurationSeconds / captionCount;
    for (let i = 0; i < words.length; i += wordsPerCaption) {
      const text = words.slice(i, i + wordsPerCaption).join(' ');
      const style = seg.emotionalBeat === 'hook' ? 'pop'
        : seg.emotionalBeat === 'cta' ? 'highlight'
        : 'normal';
      captions.push({
        text,
        startTimeSeconds: Math.round(currentTime * 100) / 100,
        endTimeSeconds: Math.round((currentTime + captionDuration) * 100) / 100,
        style,
      });
      currentTime += captionDuration;
    }
  }
  return captions;
}

function buildVisualInstructions(script) {
  const instructions = [];
  let currentTime = 0;
  for (const seg of script.segments) {
    instructions.push({
      segmentIndex: seg.index,
      description: seg.visualCue,
      assetType: seg.visualCue?.startsWith('text_overlay') ? 'text_overlay' : 'stock_video',
      startTimeSeconds: currentTime,
      durationSeconds: seg.estimatedDurationSeconds,
    });
    currentTime += seg.estimatedDurationSeconds;
  }
  return instructions;
}

// ─── BUILD FILTERGRAPH ───────────────────────────────────────

function buildFiltergraph(captions, hookText, height) {
  const filters = [];

  // ── Hook text: huge, split into 2 lines, yellow, first 5 seconds ──
  const hookLines = splitToLines(hookText, 20);
  const hookLineH = 85;
  const hookStartY = Math.round(height / 2) - Math.round((hookLines.length * hookLineH) / 2);

  for (let i = 0; i < hookLines.length; i++) {
    const escaped = escapeDrawtext(hookLines[i]);
    const yPos = hookStartY + i * hookLineH;
    filters.push(
      `drawtext=font='Arial Bold':text='${escaped}':fontcolor=yellow:fontsize=78` +
      `:borderw=6:bordercolor=black@0.95:shadowx=4:shadowy=4:shadowcolor=black@0.8` +
      `:x=(w-text_w)/2:y=${yPos}:enable='between(t\\,0\\,5)'`
    );
  }

  // ── Rolling captions: bold, bottom-center, style-colored ──
  for (const c of captions) {
    const escaped = escapeDrawtext(c.text);
    let fontColor, fontSize;
    switch (c.style) {
      case 'pop':
        fontColor = 'yellow';
        fontSize = 74;
        break;
      case 'highlight':
        fontColor = '#00ffcc';
        fontSize = 70;
        break;
      default:
        fontColor = 'white';
        fontSize = 66;
    }
    // Place captions in lower third
    const yCaption = Math.round(height * 0.74);
    filters.push(
      `drawtext=font='Arial Bold':text='${escaped}':fontcolor=${fontColor}:fontsize=${fontSize}` +
      `:borderw=6:bordercolor=black@0.95:shadowx=5:shadowy=5:shadowcolor=black@0.85` +
      `:x=(w-text_w)/2:y=${yCaption}` +
      `:enable='between(t\\,${c.startTimeSeconds}\\,${c.endTimeSeconds})'`
    );
  }

  return filters.join(',');
}

// ─── FFMPEG RUNNER ───────────────────────────────────────────

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300_000,
  });
  return { ok: result.status === 0, stderr: result.stderr || '', error: result.error };
}

// ─── MAIN ASSEMBLER ──────────────────────────────────────────

async function assembleVideo(script, format = 'youtube_short', voiceOptions = {}) {
  const startTime = Date.now();
  const jobId = crypto.randomUUID();
  const outputPath = path.join(VIDEO_CONFIG.outputDir, `${jobId}.mp4`);
  const resolution = VIDEO_CONFIG.resolution[format] || VIDEO_CONFIG.resolution.youtube_short;
  const { width, height } = resolution;
  const duration = script.totalDurationSeconds;

  log.info('Starting influencer-style video assembly', { jobId, scriptId: script.id, format, duration });

  // Ensure output dirs exist
  if (!fs.existsSync(VIDEO_CONFIG.outputDir)) fs.mkdirSync(VIDEO_CONFIG.outputDir, { recursive: true });
  const audioDir = path.join(VIDEO_CONFIG.tempDir, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

  // ── STEP 1: Generate voice via ElevenLabs ─────────────────
  const audioPath = path.join(audioDir, `${jobId}.mp3`);
  const fullText = script.segments.map(s => s.text).join(' ');
  const language = voiceOptions.language || 'english';
  const gender = voiceOptions.gender || 'male';
  const hasAudio = await generateVoice(fullText, audioPath, language, gender);

  if (hasAudio) {
    log.info('Voice ready — audio will be included in video');
  } else {
    log.warn('No voice audio — video will be silent');
  }

  // ── STEP 2: Build captions & filtergraph ──────────────────
  const captions = buildCaptions(script);
  const hookText = script.hook?.text || script.segments[0]?.text || 'Watch this...';
  const captionFiltergraph = buildFiltergraph(captions, hookText, height);

  // ── STEP 3: Cinematic dark background + vignette ─────────
  // Dark navy (#0a1628) — premium finance/tech creator look
  // vignette adds edge-darkening depth without any compute cost
  const bgSource = `color=c=0x0a1628:s=${width}x${height}:r=30`;

  // Full video filter: vignette depth + captions
  const videoFilter = `vignette=PI/4,${captionFiltergraph}`;

  // ── STEP 4: FFmpeg args ───────────────────────────────────
  const audioInputArgs = hasAudio ? ['-i', audioPath] : [];

  const args = [
    '-y',
    '-f', 'lavfi', '-i', bgSource,
    ...audioInputArgs,
    '-vf', videoFilter,
    '-c:v', VIDEO_CONFIG.codec,
    '-preset', 'ultrafast',
    '-crf', '24',
    '-b:v', VIDEO_CONFIG.videoBitrate,
    '-t', String(duration),
    '-pix_fmt', 'yuv420p',
    ...(hasAudio
      ? ['-c:a', 'aac', '-b:a', VIDEO_CONFIG.audioBitrate, '-shortest']
      : ['-an']),
    outputPath,
  ];

  log.info('Running FFmpeg', { jobId, outputPath, hasAudio, captionCount: captions.length });
  const { ok, stderr, error } = runFfmpeg(args);

  if (!ok) {
    const errMsg = error?.message || stderr?.slice(-400) || 'unknown error';
    log.error('FFmpeg failed', { jobId, error: errMsg });
    throw new Error('FFmpeg assembly failed: ' + errMsg.slice(0, 200));
  }

  const fileSizeBytes = fs.statSync(outputPath).size;
  const assemblyTimeMs = Date.now() - startTime;

  log.info('Video assembly complete', {
    jobId, outputPath, duration,
    fileSizeMB: Math.round(fileSizeBytes / 1024 / 1024 * 100) / 100,
    timeMs: assemblyTimeMs,
    hasAudio,
  });

  return { outputPath, durationSeconds: duration, fileSizeBytes, resolution, assemblyTimeMs };
}

module.exports = { assembleVideo, buildVisualInstructions, buildCaptions };
