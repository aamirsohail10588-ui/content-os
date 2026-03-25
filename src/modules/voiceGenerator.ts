// ============================================================
// MODULE: modules/voiceGenerator.ts
// PURPOSE: TTS — ElevenLabs (paid) or Edge TTS (free)
// PHASE: 2
// STATUS: ACTIVE
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { Script } from '../types';
import { VIDEO_CONFIG, SYSTEM_CONFIG } from '../config';
import { createLogger } from '../infra/logger';

const log = createLogger('VoiceGenerator');

export interface VoiceResult {
  audioPath: string;
  durationSeconds: number;
  sizeBytes: number;
  voiceId: string;
  model: string;
  generationMs: number;
  isMock: boolean;
}

// ─── SILENT MOCK ─────────────────────────────────────────────

async function generateSilentAudio(audioPath: string, durationSeconds: number): Promise<void> {
  const { spawnSync } = await import('child_process');
  const dur = Math.ceil(durationSeconds);
  spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', String(dur), '-q:a', '9', '-acodec', 'libmp3lame',
    audioPath,
  ], { encoding: 'utf8', timeout: 30000 });
}

// ─── EDGE TTS (FREE) ─────────────────────────────────────────

async function generateEdgeTTS(text: string, audioPath: string, voice = 'en-US-GuyNeural', language = 'english'): Promise<void> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  // Use plain text — the library wraps it in SSML with the configured voice.
  // Custom SSML with <prosody> was producing 0-byte files on some Edge TTS endpoints.
  const { audioStream } = tts.toStream(text);
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(audioPath);
    audioStream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    audioStream.on('error', reject);
  });

  // Throw if empty so the caller's fallback chain kicks in
  const size = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
  if (size < 1000) throw new Error(`Edge TTS produced empty file (${size} bytes) for voice ${voice}`);
}

// ─── ELEVENLABS (PAID) ───────────────────────────────────────

async function generateElevenLabsTTS(text: string, audioPath: string, voiceId: string, modelId = 'eleven_turbo_v2_5'): Promise<void> {
  const { ElevenLabsClient } = await import('elevenlabs');
  const key = process.env.ELEVENLABS_API_KEY ?? '';
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');
  const client = new ElevenLabsClient({ apiKey: key });
  const audioStream = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: modelId,
    voice_settings: { stability: 0.25, similarity_boost: 0.75, style: 0.45, use_speaker_boost: true },
  });
  const writer = fs.createWriteStream(audioPath);
  await new Promise<void>((resolve, reject) => {
    (audioStream as unknown as NodeJS.ReadableStream).pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ─── MAIN ────────────────────────────────────────────────────

// Voice configs per language/gender
const VOICE_CONFIG: Record<string, Record<string, { voiceId: string; model: string; edgeVoice: string }>> = {
  english: {
    male:   { voiceId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_turbo_v2_5',    edgeVoice: 'en-US-GuyNeural' },
    female: { voiceId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_turbo_v2_5',    edgeVoice: 'en-US-JennyNeural' },
  },
  hindi: {
    male:   { voiceId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_multilingual_v2', edgeVoice: 'hi-IN-MadhurNeural' },
    female: { voiceId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_multilingual_v2', edgeVoice: 'hi-IN-SwaraNeural' },
  },
  hinglish: {
    male:   { voiceId: 'pNInz6obpgDQGcFmaJgB', model: 'eleven_multilingual_v2', edgeVoice: 'en-IN-PrabhatNeural' },
    female: { voiceId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_multilingual_v2', edgeVoice: 'en-IN-NeerjaNeural' },
  },
};

export async function generateVoice(
  script: Script,
  voiceOptions?: { language?: string; gender?: string }
): Promise<VoiceResult> {
  const start = Date.now();
  const audioDir = path.join(VIDEO_CONFIG.tempDir, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `${script.id}.mp3`);
  const fullText = script.segments.map(s => s.text).join(' ');

  const lang = voiceOptions?.language || 'english';
  const gender = voiceOptions?.gender || 'male';
  const voiceCfg = (VOICE_CONFIG[lang] ?? VOICE_CONFIG.english)[gender] ?? VOICE_CONFIG.english.male;

  // Mock mode — silent audio
  if (SYSTEM_CONFIG.useMocks) {
    await generateSilentAudio(audioPath, script.totalDurationSeconds);
    const sizeBytes = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
    log.info('Mock audio generated (silent)', { audioPath, duration: Math.ceil(script.totalDurationSeconds), sizeBytes });
    return { audioPath, durationSeconds: script.totalDurationSeconds, sizeBytes, voiceId: 'mock', model: 'mock', generationMs: Date.now() - start, isMock: true };
  }

  const isIndian = lang === 'hindi' || lang === 'hinglish';
  const elevenKey = process.env.ELEVENLABS_API_KEY ?? '';

  // For Indian languages: Edge TTS first — Microsoft Indian voices handle Hinglish
  // pronunciation correctly. ElevenLabs multilingual reads Roman Hindi phonetically
  // as English, producing robotic/distorted output.
  if (isIndian) {
    try {
      log.info('Edge TTS (Indian) request', { voice: voiceCfg.edgeVoice, lang, chars: fullText.length });
      await generateEdgeTTS(fullText, audioPath, voiceCfg.edgeVoice, lang);
      const sizeBytes = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
      if (sizeBytes > 1000) {
        log.info('Edge TTS audio saved', { audioPath, sizeBytes, generationMs: Date.now() - start });
        return { audioPath, durationSeconds: script.totalDurationSeconds, sizeBytes, voiceId: voiceCfg.edgeVoice, model: 'edge-tts', generationMs: Date.now() - start, isMock: false };
      }
    } catch (err) {
      log.warn('Edge TTS (Indian) failed — trying ElevenLabs', { error: (err as Error).message });
    }
  }

  // English (and Indian fallback): try ElevenLabs
  if (elevenKey) {
    try {
      log.info('ElevenLabs TTS request', { voiceId: voiceCfg.voiceId, model: voiceCfg.model, lang, gender, chars: fullText.length });
      await Promise.race([
        generateElevenLabsTTS(fullText, audioPath, voiceCfg.voiceId, voiceCfg.model),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ElevenLabs timeout after 90s')), 90000)),
      ]);
      const sizeBytes = fs.statSync(audioPath).size;
      log.info('ElevenLabs audio saved', { audioPath, sizeBytes, generationMs: Date.now() - start });
      return { audioPath, durationSeconds: script.totalDurationSeconds, sizeBytes, voiceId: voiceCfg.voiceId, model: voiceCfg.model, generationMs: Date.now() - start, isMock: false };
    } catch (err) {
      log.warn('ElevenLabs failed — trying Edge TTS', { error: (err as Error).message });
    }
  }

  // Edge TTS fallback for English
  try {
    log.info('Edge TTS fallback', { chars: fullText.length, voice: voiceCfg.edgeVoice });
    await generateEdgeTTS(fullText, audioPath, voiceCfg.edgeVoice, lang);
    const sizeBytes = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
    log.info('Edge TTS audio saved', { audioPath, sizeBytes, generationMs: Date.now() - start });
    return { audioPath, durationSeconds: script.totalDurationSeconds, sizeBytes, voiceId: voiceCfg.edgeVoice, model: 'edge-tts', generationMs: Date.now() - start, isMock: false };
  } catch (err) {
    log.warn('Edge TTS failed — generating silent fallback', { error: (err as Error).message });
  }

  // Final fallback: silent
  await generateSilentAudio(audioPath, script.totalDurationSeconds);
  const sizeBytes = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
  return { audioPath, durationSeconds: script.totalDurationSeconds, sizeBytes, voiceId: 'fallback', model: 'silent', generationMs: Date.now() - start, isMock: true };
}
