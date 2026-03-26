// ============================================================
// MODULE: web/server.ts
// PURPOSE: Express web server — full frontend for Content OS
// ============================================================

import 'dotenv/config';
import * as express from 'express';
import * as session from 'express-session';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { queryOne, queryAll, queryRun, UserRow, TokenRow, VideoRow } from './db';
import * as fs from 'fs';
import { google } from 'googleapis';
import { generateVideo } from '../pipeline/generateVideo';
import { publishVideo } from '../modules/publisher';
import { DEFAULT_CONTENT_CONFIG } from '../config';
import { recordPublishedVideo } from '../modules/performanceStore';
import rateLimit from 'express-rate-limit';
import csurf from 'csurf';
import cookieParser from 'cookie-parser';

// ─── SESSION TYPE EXTENSION ──────────────────────────────────

declare module 'express-session' {
  interface SessionData {
    userId: number | undefined;
  }
}

const app = express.default();
const PORT = process.env.PORT || 3000;

// ─── STARTUP GUARD ───────────────────────────────────────────

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required. Set it before starting the server.');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((session as any).default({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ─── RATE LIMITERS ───────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: express.Request, res: express.Response) => {
    res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
  },
});

// ─── CSRF ────────────────────────────────────────────────────

// Cookie-based CSRF: secret lives in a signed cookie, not the session.
// More reliable than session-based — survives server restarts and MemoryStore resets.
const csrfProtection = csurf({ cookie: { httpOnly: true, sameSite: 'strict' } });

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.session.userId) {
    res.redirect('/login');
    return;
  }
  next();
}

async function getUser(req: express.Request): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [req.session.userId]);
}

// ─── PAGES ───────────────────────────────────────────────────

// Landing page
app.get('/', (req: express.Request, res: express.Response) => {
  if (req.session.userId) { res.redirect('/dashboard'); return; }
  res.render('landing');
});

// Login
app.get('/login', csrfProtection, (req: express.Request, res: express.Response) => {
  if (req.session.userId) { res.redirect('/dashboard'); return; }
  res.render('login', { error: null, csrfToken: req.csrfToken() });
});

app.post('/login', authLimiter, csrfProtection, async (req: express.Request, res: express.Response) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
  if (!user || !await bcrypt.compare(password, user.password)) {
    res.render('login', { error: 'Invalid email or password', csrfToken: req.csrfToken() });
    return;
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

// Register
app.get('/register', csrfProtection, (req: express.Request, res: express.Response) => {
  if (req.session.userId) { res.redirect('/dashboard'); return; }
  res.render('register', { error: null, csrfToken: req.csrfToken() });
});

app.post('/register', authLimiter, csrfProtection, async (req: express.Request, res: express.Response) => {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (!name || !email || !password) {
    res.render('register', { error: 'All fields are required', csrfToken: req.csrfToken() });
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await queryRun(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
      [name, email, hash]
    );
    req.session.userId = result.rows[0].id as number;
    res.redirect('/connect');
  } catch {
    res.render('register', { error: 'Email already registered', csrfToken: req.csrfToken() });
  }
});

// Logout
app.get('/logout', (req: express.Request, res: express.Response) => {
  req.session.destroy(() => { /* ignore errors */ });
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  if (!user) { res.redirect('/login'); return; }
  const videos = await queryAll<VideoRow>(
    'SELECT * FROM videos WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [user.id]
  );
  const tokens = await queryAll<TokenRow>('SELECT * FROM tokens WHERE user_id = $1', [user.id]);
  const youtube = tokens.find(t => t.platform === 'youtube');
  const instagram = tokens.find(t => t.platform === 'instagram');
  const totalRow = await queryOne<{ c: string }>(
    'SELECT COUNT(*) as c FROM videos WHERE user_id = $1', [user.id]
  );
  const publishedRow = await queryOne<{ c: string }>(
    "SELECT COUNT(*) as c FROM videos WHERE user_id = $1 AND status = 'published'", [user.id]
  );
  const stats = {
    total: parseInt(totalRow?.c ?? '0', 10),
    published: parseInt(publishedRow?.c ?? '0', 10),
  };
  res.render('dashboard', { user, videos, youtube, instagram, stats });
});

// Connect accounts
app.get('/connect', requireAuth, async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  if (!user) { res.redirect('/login'); return; }
  const tokens = await queryAll<TokenRow>('SELECT * FROM tokens WHERE user_id = $1', [user.id]);
  const youtube = tokens.find(t => t.platform === 'youtube');
  const instagram = tokens.find(t => t.platform === 'instagram');
  res.render('connect', { user, youtube, instagram, success: req.query.success, error: req.query.error });
});

// Settings
app.get('/settings', requireAuth, async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  res.render('settings', { user, success: req.query.success });
});

app.post('/settings', requireAuth, csrfProtection, async (req: express.Request, res: express.Response) => {
  const { name, niche, tone, voice_language, voice_gender, auto_publish } = req.body as {
    name: string; niche: string; tone: string;
    voice_language: string; voice_gender: string; auto_publish: string;
  };
  await queryRun(
    'UPDATE users SET name = $1, niche = $2, tone = $3, voice_language = $4, voice_gender = $5, auto_publish = $6 WHERE id = $7',
    [name, niche, tone, voice_language || 'english', voice_gender || 'male', auto_publish === 'on' ? 1 : 0, req.session.userId]
  );
  res.redirect('/settings?success=1');
});

// Videos page
app.get('/videos', requireAuth, async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  if (!user) { res.redirect('/login'); return; }
  const videos = await queryAll<VideoRow>(
    'SELECT * FROM videos WHERE user_id = $1 ORDER BY created_at DESC',
    [user.id]
  );
  res.render('videos', { user, videos });
});

// ─── YOUTUBE OAUTH ───────────────────────────────────────────

function getYouTubeOAuth() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    `http://localhost:${PORT}/connect/youtube/callback`
  );
}

app.get('/connect/youtube', requireAuth, (req: express.Request, res: express.Response) => {
  const auth = getYouTubeOAuth();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    prompt: 'consent',
    state: String(req.session.userId),
  });
  res.redirect(url);
});

app.get('/connect/youtube/callback', async (req: express.Request, res: express.Response) => {
  if (req.query.error) {
    console.error('YouTube OAuth denied:', req.query.error);
    res.redirect('/connect?error=' + encodeURIComponent(String(req.query.error)));
    return;
  }

  const userId = req.query.state || req.session?.userId;
  if (!userId) {
    console.error('YouTube callback: no userId in state or session');
    res.redirect('/login');
    return;
  }

  try {
    const auth = getYouTubeOAuth();
    const { tokens } = await auth.getToken(req.query.code as string);
    auth.setCredentials(tokens);
    const yt = google.youtube({ version: 'v3', auth });
    const ch = await yt.channels.list({ part: ['snippet'], mine: true });
    const channelName = ch.data.items?.[0]?.snippet?.title ?? 'My Channel';
    await queryRun(
      `INSERT INTO tokens (user_id, platform, refresh_token, channel_name)
       VALUES ($1, 'youtube', $2, $3)
       ON CONFLICT (user_id, platform) DO UPDATE
         SET refresh_token = EXCLUDED.refresh_token,
             channel_name = EXCLUDED.channel_name,
             updated_at = now()`,
      [userId, tokens.refresh_token, channelName]
    );
    res.redirect('/connect?success=youtube');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? 'unknown';
    console.error('YouTube callback error:', msg);
    res.redirect('/connect?error=' + encodeURIComponent(msg.slice(0, 100)));
  }
});

app.post('/connect/youtube/disconnect', requireAuth, csrfProtection, async (req: express.Request, res: express.Response) => {
  await queryRun("DELETE FROM tokens WHERE user_id = $1 AND platform = 'youtube'", [req.session.userId]);
  res.redirect('/connect');
});

// ─── INSTAGRAM MANUAL TOKEN ──────────────────────────────────

app.post('/connect/instagram', requireAuth, csrfProtection, async (req: express.Request, res: express.Response) => {
  const { access_token, account_id } = req.body as { access_token: string; account_id: string };
  if (!access_token || !account_id) { res.redirect('/connect?error=instagram_missing'); return; }
  await queryRun(
    `INSERT INTO tokens (user_id, platform, access_token, account_id)
     VALUES ($1, 'instagram', $2, $3)
     ON CONFLICT (user_id, platform) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           account_id = EXCLUDED.account_id,
           updated_at = now()`,
    [req.session.userId, access_token, account_id]
  );
  res.redirect('/connect?success=instagram');
});

app.post('/connect/instagram/disconnect', requireAuth, csrfProtection, async (req: express.Request, res: express.Response) => {
  await queryRun("DELETE FROM tokens WHERE user_id = $1 AND platform = 'instagram'", [req.session.userId]);
  res.redirect('/connect');
});

// ─── API: GENERATE VIDEO ─────────────────────────────────────

app.post('/api/generate', requireAuth, async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  if (!user) { res.json({ success: false, error: 'Not authenticated' }); return; }
  const { topic, language, niche } = req.body as { topic: string; language: string; niche: string };
  if (!topic) { res.json({ success: false, error: 'Topic is required' }); return; }

  const videoResult = await queryRun(
    "INSERT INTO videos (user_id, topic, status) VALUES ($1, $2, 'generating') RETURNING id",
    [user.id, topic]
  );
  const videoId: number = videoResult.rows[0].id as number;

  res.json({ success: true, videoId });

  const resolvedLang  = language  || user.voice_language  || 'english';
  const resolvedNiche = niche     || user.niche            || 'general';

  (async () => {
    try {
      const result = await generateVideo(topic, {
        ...DEFAULT_CONTENT_CONFIG,
        niche: resolvedNiche,
        tone: user.tone || 'authoritative_yet_accessible',
        voiceLanguage: resolvedLang,
        voiceGender: user.voice_gender || 'male',
      } as any);

      if (!result.success || !result.video) {
        const errMsg = result.error ? `${result.error.code}: ${result.error.message}` : 'Pipeline failed';
        console.error('[Generate] Pipeline failed:', errMsg);
        await queryRun("UPDATE videos SET status='failed', error_message=$1 WHERE id=$2", [errMsg, videoId]);
        return;
      }

      if (!fs.existsSync(result.video.outputPath)) {
        const errMsg = 'Video file not produced — FFmpeg may have failed. Check server console.';
        console.error('[Generate] Output file missing:', result.video.outputPath);
        await queryRun("UPDATE videos SET status='failed', error_message=$1 WHERE id=$2", [errMsg, videoId]);
        return;
      }

      await queryRun(
        `UPDATE videos SET hook=$1, hook_score=$2, duration=$3, output_path=$4, status='generated' WHERE id=$5`,
        [result.hook?.text, result.hook?.strengthScore, result.video.durationSeconds, result.video.outputPath, videoId]
      );

      const freshUser = await getUser(req);
      if (freshUser?.auto_publish) {
        const tokens = await queryAll<TokenRow>('SELECT * FROM tokens WHERE user_id = $1', [user.id]);
        const ytToken = tokens.find(t => t.platform === 'youtube');
        const igToken = tokens.find(t => t.platform === 'instagram');

        if (ytToken || igToken) {
          if (ytToken) process.env.YOUTUBE_REFRESH_TOKEN = ytToken.refresh_token ?? undefined;
          if (igToken) {
            process.env.INSTAGRAM_ACCESS_TOKEN = igToken.access_token ?? undefined;
            process.env.INSTAGRAM_ACCOUNT_ID = igToken.account_id ?? undefined;
          }

          try {
            const publishResults = await publishVideo(
              result.video.outputPath,
              topic,
              `${result.hook?.text}\n\n#finance #money #investing #personalfinance`
            );

            let youtubeUrl = '';
            let instagramUrl = '';
            for (const r of publishResults) {
              if (r.platform === 'youtube' && r.success) youtubeUrl = r.url ?? '';
              if (r.platform === 'instagram' && r.success) instagramUrl = r.url ?? '';
            }

            await queryRun(
              `UPDATE videos SET youtube_url=$1, instagram_url=$2, status='published' WHERE id=$3`,
              [youtubeUrl, instagramUrl, videoId]
            );

            // DECISION: recordPublishedVideo is called here (server.ts) rather than inside
            // generateVideo.ts because the DB videoId is only known in server.ts.
            const successfulPublishes = publishResults.filter(r => r.success);
            if (successfulPublishes.length > 0 && result.hook) {
              for (const r of successfulPublishes) {
                await recordPublishedVideo({
                  videoId,
                  hookPattern: result.hook.pattern,
                  hookScore: result.hook.strengthScore,
                  topic,
                  platform: r.platform,
                  publishedAt: new Date(),
                });
              }
            }
          } catch (pubErr: unknown) {
            const msg = (pubErr as Error).message ?? String(pubErr);
            console.error('[Generate] Auto-publish failed:', msg);
            await queryRun(
              "UPDATE videos SET error_message=$1 WHERE id=$2",
              [`Auto-publish failed: ${msg.slice(0, 200)}`, videoId]
            );
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = (err as Error)?.message || String(err);
      console.error('[Generate] Unexpected error:', errMsg);
      await queryRun(
        "UPDATE videos SET status='failed', error_message=$1 WHERE id=$2",
        [errMsg.slice(0, 500), videoId]
      );
    }
  })();
});

// API: Get video status
app.get('/api/video/:id', requireAuth, async (req: express.Request, res: express.Response) => {
  const video = await queryOne<VideoRow>(
    'SELECT * FROM videos WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (!video) { res.json({ success: false, error: 'Not found' }); return; }
  res.json({ success: true, video });
});

// API: Stream video file for preview
app.get('/api/video/:id/file', requireAuth, async (req: express.Request, res: express.Response) => {
  const video = await queryOne<VideoRow>(
    'SELECT * FROM videos WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (!video || !video.output_path) { res.status(404).send('Not found'); return; }
  if (!fs.existsSync(video.output_path)) { res.status(404).send('Video file not found'); return; }

  const stat = fs.statSync(video.output_path);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(video.output_path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
    fs.createReadStream(video.output_path).pipe(res);
  }
});

// API: Manually publish a video
app.post('/api/video/:id/publish', requireAuth, async (req: express.Request, res: express.Response) => {
  const video = await queryOne<VideoRow>(
    'SELECT * FROM videos WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (!video) { res.json({ success: false, error: 'Not found' }); return; }
  if (video.status === 'published') { res.json({ success: false, error: 'Already published' }); return; }
  if (!video.output_path || !fs.existsSync(video.output_path)) {
    res.json({ success: false, error: 'Video file not found — cannot publish' });
    return;
  }

  const tokens = await queryAll<TokenRow>(
    'SELECT * FROM tokens WHERE user_id = $1', [req.session.userId]
  );
  const ytToken = tokens.find(t => t.platform === 'youtube');
  const igToken = tokens.find(t => t.platform === 'instagram');

  if (!ytToken && !igToken) {
    res.json({ success: false, error: 'No platforms connected. Go to Connections to connect YouTube or Instagram.' });
    return;
  }

  try {
    if (ytToken) process.env.YOUTUBE_REFRESH_TOKEN = ytToken.refresh_token ?? undefined;
    if (igToken) {
      process.env.INSTAGRAM_ACCESS_TOKEN = igToken.access_token ?? undefined;
      process.env.INSTAGRAM_ACCOUNT_ID = igToken.account_id ?? undefined;
    }

    const publishResults = await publishVideo(
      video.output_path,
      video.topic,
      `${video.hook || video.topic}\n\n#finance #money #investing #personalfinance`
    );

    let youtubeUrl = '';
    let instagramUrl = '';
    for (const r of publishResults) {
      if (r.platform === 'youtube' && r.success) youtubeUrl = r.url ?? '';
      if (r.platform === 'instagram' && r.success) instagramUrl = r.url ?? '';
    }

    await queryRun(
      `UPDATE videos SET youtube_url=$1, instagram_url=$2, status='published' WHERE id=$3`,
      [youtubeUrl, instagramUrl, video.id]
    );

    // Record performance entry for each successfully published platform
    const successfulPublishes = publishResults.filter(r => r.success);
    if (successfulPublishes.length > 0) {
      for (const r of successfulPublishes) {
        await recordPublishedVideo({
          videoId: video.id,
          hookPattern: video.hook ?? 'unknown',
          hookScore: video.hook_score ?? 0,
          topic: video.topic,
          platform: r.platform,
          publishedAt: new Date(),
        });
      }
    }

    res.json({ success: true, youtubeUrl, instagramUrl });
  } catch (err: unknown) {
    res.json({ success: false, error: (err as Error).message });
  }
});

// ─── START ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Content OS — Web Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`${'═'.repeat(50)}\n`);
});
