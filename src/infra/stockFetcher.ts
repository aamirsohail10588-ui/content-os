// ============================================================
// MODULE: infra/stockFetcher.ts
// PURPOSE: Fetch and cache stock footage clips from Pexels
// PHASE: 2
// STATUS: ACTIVE
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from './logger';
import { ScriptSegment } from '../types';

const log = createLogger('StockFetcher');

const CACHE_DIR = path.join(os.tmpdir(), 'content-os', 'stock-cache');
const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;
const MIN_FILE_SIZE = 10_000; // 10 KB

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCachePath(query: string, type: 'video' | 'image'): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${type}:${query.toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 14);
  return path.join(CACHE_DIR, `${hash}.${type === 'video' ? 'mp4' : 'jpg'}`);
}

// ─── PEXELS VIDEO SEARCH ─────────────────────────────────────

async function searchPexelsVideo(query: string, apiKey: string): Promise<string | null> {
  const params = new URLSearchParams({
    query,
    per_page: '8',
    orientation: 'portrait',
    size: 'medium',
  });

  const response = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    log.warn('Pexels video search error', { status: response.status, query: query.slice(0, 50) });
    return null;
  }

  const data = (await response.json()) as { videos?: any[] };
  const videos = data.videos ?? [];
  if (videos.length === 0) return null;

  // Prefer portrait SD files; fall back to any SD or first available
  for (const video of videos) {
    const files: any[] = video.video_files ?? [];
    const portrait = files.find(f => f.height > f.width && f.quality === 'sd');
    const anySd   = files.find(f => f.quality === 'sd');
    const chosen  = portrait ?? anySd ?? files[0];
    if (chosen?.link) return chosen.link as string;
  }

  return null;
}

async function searchVideoWithFallback(query: string, apiKey: string): Promise<string | null> {
  // Try full query
  let url = await searchPexelsVideo(query, apiKey);
  if (url) return url;

  // Try first 3 words
  const words = query.split(/\s+/);
  if (words.length > 3) {
    url = await searchPexelsVideo(words.slice(0, 3).join(' '), apiKey);
    if (url) return url;
  }

  // Try first 2 words
  if (words.length > 2) {
    url = await searchPexelsVideo(words.slice(0, 2).join(' '), apiKey);
    if (url) return url;
  }

  // Try first word only (usually a noun)
  url = await searchPexelsVideo(words[0], apiKey);
  if (url) return url;

  // Final: append ' video' to original query to force video results
  if (!query.trim().toLowerCase().endsWith('video')) {
    url = await searchPexelsVideo(query.trim() + ' video', apiKey);
  }
  return url ?? null;
}

// ─── PEXELS IMAGE SEARCH ─────────────────────────────────────

async function searchPexelsImage(query: string, apiKey: string): Promise<string | null> {
  const params = new URLSearchParams({ query, per_page: '5', orientation: 'portrait' });

  const response = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as { photos?: any[] };
  const photos = data.photos ?? [];
  if (photos.length === 0) return null;

  const src = photos[0]?.src;
  return (src?.large2x ?? src?.large ?? null) as string | null;
}

// ─── DOWNLOAD ────────────────────────────────────────────────

async function downloadFile(remoteUrl: string, destPath: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(remoteUrl, { signal: controller.signal });
    if (!response.ok) return false;

    const buf = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buf));

    const size = fs.statSync(destPath).size;
    if (size < MIN_FILE_SIZE) {
      fs.unlinkSync(destPath);
      return false;
    }

    log.info('Stock clip saved', { destPath: path.basename(destPath), sizeKB: Math.round(size / 1024) });
    return true;
  } catch (err) {
    log.warn('Download failed', { url: remoteUrl.slice(0, 60), error: (err as Error).message });
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────

export async function fetchStockClip(
  query: string,
  type: 'video' | 'image' = 'video'
): Promise<string | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return null;
  if (!query?.trim()) return null;

  ensureCacheDir();
  const cachePath = getCachePath(query, type);

  // Return cached file if valid
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size >= MIN_FILE_SIZE) {
    log.info('Cache hit', { query: query.slice(0, 40), file: path.basename(cachePath) });
    return cachePath;
  }

  try {
    const remoteUrl = type === 'video'
      ? await searchVideoWithFallback(query, apiKey)
      : await searchPexelsImage(query, apiKey);

    if (!remoteUrl) {
      log.warn('No Pexels result', { query: query.slice(0, 40), type });
      return null;
    }

    const ok = await downloadFile(remoteUrl, cachePath);
    return ok ? cachePath : null;
  } catch (err) {
    log.warn('fetchStockClip error', { query: query.slice(0, 40), error: (err as Error).message });
    return null;
  }
}

// Fetch clips for all segments in parallel (video only — never images)
// All returned paths are .mp4 to avoid SAR mismatch in FFmpeg concat.
export async function fetchStockClips(
  segments: Pick<ScriptSegment, 'visual_query' | 'visual_type'>[]
): Promise<(string | null)[]> {
  // Always fetch video regardless of visual_type — images cause SAR mismatch in FFmpeg
  const results = await Promise.all(
    segments.map(seg => {
      if (!seg.visual_query) return Promise.resolve(null);
      return fetchStockClip(seg.visual_query, 'video').catch(() => null);
    })
  );

  // Fill nulls with the nearest previous valid video clip so FFmpeg never
  // mixes video + lavfi sources in a way that causes SAR/format mismatches
  let lastClip: string | null = null;
  return results.map(clip => {
    if (clip) { lastClip = clip; return clip; }
    return lastClip;
  });
}
