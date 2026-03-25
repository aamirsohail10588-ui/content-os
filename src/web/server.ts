// ============================================================
// MODULE: web/server.ts
// PURPOSE: Express web server — full frontend for Content OS
// ============================================================

import 'dotenv/config';
import * as express from 'express';
import * as session from 'express-session';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import db from './db';
import * as fs from 'fs';
import { google } from 'googleapis';
import { generateVideo } from '../pipeline/generateVideo';
import { publishVideo } from '../modules/publisher';
import { DEFAULT_CONTENT_CONFIG } from '../config';

const app = express.default();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((session as any).default({
  secret: process.env.SESSION_SECRET || 'content-os-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────

function requireAuth(req: any, res: any, next: any) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function getUser(req: any) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) as any;
}

// ─── PAGES ───────────────────────────────────────────────────

// Landing page
app.get('/', (req: any, res: any) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('landing');
});

// Login
app.get('/login', (req: any, res: any) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req: any, res: any) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

// Register
app.get('/register', (req: any, res: any) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('register', { error: null });
});

app.post('/register', async (req: any, res: any) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('register', { error: 'All fields are required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hash);
    req.session.userId = result.lastInsertRowid;
    res.redirect('/connect');
  } catch {
    res.render('register', { error: 'Email already registered' });
  }
});

// Logout
app.get('/logout', (req: any, res: any) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, (req: any, res: any) => {
  const user = getUser(req);
  const videos = db.prepare('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  const tokens = db.prepare('SELECT * FROM tokens WHERE user_id = ?').all(user.id) as any[];
  const youtube = tokens.find((t: any) => t.platform === 'youtube');
  const instagram = tokens.find((t: any) => t.platform === 'instagram');
  const stats = {
    total: (db.prepare('SELECT COUNT(*) as c FROM videos WHERE user_id = ?').get(user.id) as any).c,
    published: (db.prepare("SELECT COUNT(*) as c FROM videos WHERE user_id = ? AND status = 'published'").get(user.id) as any).c,
  };
  res.render('dashboard', { user, videos, youtube, instagram, stats });
});

// Connect accounts
app.get('/connect', requireAuth, (req: any, res: any) => {
  const user = getUser(req);
  const tokens = db.prepare('SELECT * FROM tokens WHERE user_id = ?').all(user.id) as any[];
  const youtube = tokens.find((t: any) => t.platform === 'youtube');
  const instagram = tokens.find((t: any) => t.platform === 'instagram');
  res.render('connect', { user, youtube, instagram, success: req.query.success, error: req.query.error });
});

// Settings
app.get('/settings', requireAuth, (req: any, res: any) => {
  const user = getUser(req);
  res.render('settings', { user, success: req.query.success });
});

app.post('/settings', requireAuth, (req: any, res: any) => {
  const { name, niche, tone, voice_language, voice_gender, auto_publish } = req.body;
  db.prepare('UPDATE users SET name = ?, niche = ?, tone = ?, voice_language = ?, voice_gender = ?, auto_publish = ? WHERE id = ?')
    .run(name, niche, tone, voice_language || 'english', voice_gender || 'male', auto_publish === 'on' ? 1 : 0, req.session.userId);
  res.redirect('/settings?success=1');
});

// Videos page
app.get('/videos', requireAuth, (req: any, res: any) => {
  const user = getUser(req);
  const videos = db.prepare('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
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

app.get('/connect/youtube', requireAuth, (req: any, res: any) => {
  const auth = getYouTubeOAuth();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    prompt: 'consent',
    state: String(req.session.userId), // carry userId through redirect
  });
  res.redirect(url);
});

app.get('/connect/youtube/callback', async (req: any, res: any) => {
  // Google sends ?error= if user denied or something went wrong
  if (req.query.error) {
    console.error('YouTube OAuth denied:', req.query.error);
    return res.redirect('/connect?error=' + encodeURIComponent(req.query.error));
  }

  // Recover userId from state param (session may not survive Google redirect)
  const userId = req.query.state || req.session?.userId;
  if (!userId) {
    console.error('YouTube callback: no userId in state or session');
    return res.redirect('/login');
  }

  try {
    const auth = getYouTubeOAuth();
    const { tokens } = await auth.getToken(req.query.code as string);
    auth.setCredentials(tokens);
    const yt = google.youtube({ version: 'v3', auth });
    const ch = await yt.channels.list({ part: ['snippet'], mine: true });
    const channelName = ch.data.items?.[0]?.snippet?.title ?? 'My Channel';
    db.prepare(`INSERT INTO tokens (user_id, platform, refresh_token, channel_name)
      VALUES (?, 'youtube', ?, ?)
      ON CONFLICT(user_id, platform) DO UPDATE SET refresh_token=excluded.refresh_token, channel_name=excluded.channel_name, updated_at=datetime('now')`)
      .run(userId, tokens.refresh_token, channelName);
    res.redirect('/connect?success=youtube');
  } catch (err: any) {
    console.error('YouTube callback error:', err.message);
    res.redirect('/connect?error=' + encodeURIComponent(err.message?.slice(0, 100) ?? 'unknown'));
  }
});

app.post('/connect/youtube/disconnect', requireAuth, (req: any, res: any) => {
  db.prepare("DELETE FROM tokens WHERE user_id = ? AND platform = 'youtube'").run(req.session.userId);
  res.redirect('/connect');
});

// ─── INSTAGRAM MANUAL TOKEN ──────────────────────────────────

app.post('/connect/instagram', requireAuth, (req: any, res: any) => {
  const { access_token, account_id } = req.body;
  if (!access_token || !account_id) return res.redirect('/connect?error=instagram_missing');
  db.prepare(`INSERT INTO tokens (user_id, platform, access_token, account_id)
    VALUES (?, 'instagram', ?, ?)
    ON CONFLICT(user_id, platform) DO UPDATE SET access_token=excluded.access_token, account_id=excluded.account_id, updated_at=datetime('now')`)
    .run(req.session.userId, access_token, account_id);
  res.redirect('/connect?success=instagram');
});

app.post('/connect/instagram/disconnect', requireAuth, (req: any, res: any) => {
  db.prepare("DELETE FROM tokens WHERE user_id = ? AND platform = 'instagram'").run(req.session.userId);
  res.redirect('/connect');
});

// ─── API: GENERATE VIDEO ─────────────────────────────────────

app.post('/api/generate', requireAuth, async (req: any, res: any) => {
  const user = getUser(req);
  const { topic, language, niche } = req.body;
  if (!topic) return res.json({ success: false, error: 'Topic is required' });

  // Insert pending video
  const videoRow = db.prepare(
    "INSERT INTO videos (user_id, topic, status) VALUES (?, ?, 'generating')"
  ).run(user.id, topic);
  const videoId = videoRow.lastInsertRowid;

  res.json({ success: true, videoId });

  // Per-request overrides: language and niche from form take priority over user settings
  const resolvedLang  = language  || user.voice_language  || 'english';
  const resolvedNiche = niche     || user.niche            || 'general';

  // Run generation in background
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
        db.prepare("UPDATE videos SET status='failed', error_message=? WHERE id=?").run(errMsg, videoId);
        return;
      }

      // Check the video file actually exists (FFmpeg may have fallen back to manifest)
      if (!fs.existsSync(result.video.outputPath)) {
        const errMsg = 'Video file not produced — FFmpeg may have failed. Check server console.';
        console.error('[Generate] Output file missing:', result.video.outputPath);
        db.prepare("UPDATE videos SET status='failed', error_message=? WHERE id=?").run(errMsg, videoId);
        return;
      }

      db.prepare(`UPDATE videos SET hook=?, hook_score=?, duration=?, output_path=?, status='generated' WHERE id=?`)
        .run(result.hook?.text, result.hook?.strengthScore, result.video.durationSeconds, result.video.outputPath, videoId);

      // Auto-publish only if user has enabled it in settings
      const freshUser = getUser(req);
      if (freshUser?.auto_publish) {
        const tokens = db.prepare('SELECT * FROM tokens WHERE user_id = ?').all(user.id) as any[];
        const ytToken = tokens.find((t: any) => t.platform === 'youtube');
        const igToken = tokens.find((t: any) => t.platform === 'instagram');

        if (ytToken || igToken) {
          if (ytToken) process.env.YOUTUBE_REFRESH_TOKEN = ytToken.refresh_token;
          if (igToken) {
            process.env.INSTAGRAM_ACCESS_TOKEN = igToken.access_token;
            process.env.INSTAGRAM_ACCOUNT_ID = igToken.account_id;
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

            db.prepare(`UPDATE videos SET youtube_url=?, instagram_url=?, status='published' WHERE id=?`)
              .run(youtubeUrl, instagramUrl, videoId);
          } catch (pubErr: any) {
            console.error('[Generate] Auto-publish failed:', pubErr.message);
            db.prepare("UPDATE videos SET error_message=? WHERE id=?")
              .run(`Auto-publish failed: ${pubErr.message?.slice(0, 200)}`, videoId);
          }
        }
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error('[Generate] Unexpected error:', errMsg);
      db.prepare("UPDATE videos SET status='failed', error_message=? WHERE id=?")
        .run(errMsg.slice(0, 500), videoId);
    }
  })();
});

// API: Get video status
app.get('/api/video/:id', requireAuth, (req: any, res: any) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!video) return res.json({ success: false, error: 'Not found' });
  res.json({ success: true, video });
});

// API: Stream video file for preview
app.get('/api/video/:id/file', requireAuth, (req: any, res: any) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId) as any;
  if (!video || !video.output_path) return res.status(404).send('Not found');
  if (!fs.existsSync(video.output_path)) return res.status(404).send('Video file not found');

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
app.post('/api/video/:id/publish', requireAuth, async (req: any, res: any) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId) as any;
  if (!video) return res.json({ success: false, error: 'Not found' });
  if (video.status === 'published') return res.json({ success: false, error: 'Already published' });
  if (!video.output_path || !fs.existsSync(video.output_path)) {
    return res.json({ success: false, error: 'Video file not found — cannot publish' });
  }

  const tokens = db.prepare('SELECT * FROM tokens WHERE user_id = ?').all(req.session.userId) as any[];
  const ytToken = tokens.find((t: any) => t.platform === 'youtube');
  const igToken = tokens.find((t: any) => t.platform === 'instagram');

  if (!ytToken && !igToken) {
    return res.json({ success: false, error: 'No platforms connected. Go to Connections to connect YouTube or Instagram.' });
  }

  try {
    if (ytToken) process.env.YOUTUBE_REFRESH_TOKEN = ytToken.refresh_token;
    if (igToken) {
      process.env.INSTAGRAM_ACCESS_TOKEN = igToken.access_token;
      process.env.INSTAGRAM_ACCOUNT_ID = igToken.account_id;
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

    db.prepare(`UPDATE videos SET youtube_url=?, instagram_url=?, status='published' WHERE id=?`)
      .run(youtubeUrl, instagramUrl, video.id);

    res.json({ success: true, youtubeUrl, instagramUrl });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Content OS — Web Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`${'═'.repeat(50)}\n`);
});
