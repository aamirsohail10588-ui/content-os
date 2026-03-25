// ============================================================
// MODULE: modules/publisher.ts
// PURPOSE: Publish videos to YouTube and Instagram (via Cloudinary)
// PHASE: 3
// STATUS: ACTIVE
// ============================================================

import * as fs from 'fs';
import { google } from 'googleapis';
import { v2 as cloudinary } from 'cloudinary';
import { createLogger } from '../infra/logger';

const log = createLogger('Publisher');

export interface PublishResult {
  platform: 'youtube' | 'instagram' | 'cloudinary';
  success: boolean;
  url?: string;
  id?: string;
  error?: string;
}

// ─── CLOUDINARY UPLOAD (for Instagram public URL) ────────────

async function uploadToCloudinary(videoPath: string): Promise<string> {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    api_key:    process.env.CLOUDINARY_API_KEY ?? '',
    api_secret: process.env.CLOUDINARY_API_SECRET ?? '',
  });

  log.info('Uploading to Cloudinary', { videoPath });

  const result = await cloudinary.uploader.upload(videoPath, {
    resource_type: 'video',
    folder: 'content-os',
  });

  log.info('Cloudinary upload complete', { url: result.secure_url });
  return result.secure_url;
}

// ─── YOUTUBE ─────────────────────────────────────────────────

async function publishToYouTube(
  videoPath: string,
  title: string,
  description: string
): Promise<PublishResult> {
  const clientId     = process.env.YOUTUBE_CLIENT_ID ?? '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? '';
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN ?? '';

  if (!clientId || !clientSecret || !refreshToken) {
    return { platform: 'youtube', success: false, error: 'YouTube not connected' };
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: 'v3', auth });

    log.info('Uploading to YouTube', { title });

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description, tags: ['finance', 'money', 'investing', 'personalfinance', 'wealth'], categoryId: '22', defaultLanguage: 'en' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(videoPath) },
    });

    const videoId = res.data.id ?? '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    log.info('YouTube upload complete', { videoId, url });
    return { platform: 'youtube', success: true, id: videoId, url };
  } catch (err) {
    const msg = (err as Error).message;
    log.error('YouTube upload failed', { error: msg });
    return { platform: 'youtube', success: false, error: msg };
  }
}

// ─── INSTAGRAM ───────────────────────────────────────────────

async function publishToInstagram(
  videoPath: string,
  caption: string
): Promise<PublishResult> {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN ?? '';
  const accountId   = process.env.INSTAGRAM_ACCOUNT_ID ?? '';

  if (!accessToken || !accountId) {
    return { platform: 'instagram', success: false, error: 'Instagram credentials not configured' };
  }

  // Check Cloudinary is configured (needed for public video URL)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? '';
  const cloudKey  = process.env.CLOUDINARY_API_KEY ?? '';
  if (!cloudName || !cloudKey) {
    return { platform: 'instagram', success: false, error: 'Cloudinary not configured — required for Instagram video hosting' };
  }

  try {
    // Step 1: Upload video to Cloudinary to get public URL
    const videoUrl = await uploadToCloudinary(videoPath);

    log.info('Creating Instagram Reel container', { accountId });

    // Step 2: Create Instagram media container
    const containerRes = await fetch(
      `https://graph.facebook.com/v19.0/${accountId}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: 'REELS',
          video_url: videoUrl,
          caption,
          share_to_feed: true,
          access_token: accessToken,
        }),
      }
    );

    const container = await containerRes.json() as { id?: string; error?: { message: string } };
    if (!container.id) throw new Error(container.error?.message ?? 'Container creation failed');

    log.info('Instagram container created — waiting for processing', { containerId: container.id });

    // Step 3: Wait for Instagram to process the video
    await waitForProcessing(container.id, accessToken);

    // Step 4: Publish
    const publishRes = await fetch(
      `https://graph.facebook.com/v19.0/${accountId}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: container.id, access_token: accessToken }),
      }
    );

    const published = await publishRes.json() as { id?: string; error?: { message: string } };
    if (!published.id) throw new Error(published.error?.message ?? 'Publish failed');

    const url = `https://www.instagram.com/reel/${published.id}`;
    log.info('Instagram Reel published', { mediaId: published.id, url });
    return { platform: 'instagram', success: true, id: published.id, url };
  } catch (err) {
    const msg = (err as Error).message;
    log.error('Instagram publish failed', { error: msg });
    return { platform: 'instagram', success: false, error: msg };
  }
}

async function waitForProcessing(containerId: string, accessToken: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${accessToken}`
    );
    const data = await res.json() as { status_code?: string };
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error('Instagram video processing error');
    log.debug('Instagram processing...', { status: data.status_code, attempt: i + 1 });
  }
  throw new Error('Instagram processing timed out');
}

// ─── MAIN ────────────────────────────────────────────────────

export async function publishVideo(
  videoPath: string,
  title: string,
  description: string
): Promise<PublishResult[]> {
  const youtubeReady  = !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_REFRESH_TOKEN);
  const instagramReady = !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID);

  if (!youtubeReady && !instagramReady) {
    log.info('No platforms configured — skipping publish');
    return [];
  }

  const tasks: Promise<PublishResult>[] = [];
  if (youtubeReady)   tasks.push(publishToYouTube(videoPath, title, description));
  if (instagramReady) tasks.push(publishToInstagram(videoPath, description));

  const settled = await Promise.allSettled(tasks);
  return settled.map(s =>
    s.status === 'fulfilled' ? s.value : { platform: 'youtube' as const, success: false, error: String(s.reason) }
  );
}
