// ============================================================
// MODULE: server.js
// PURPOSE: Express HTTP API for the Content OS pipeline
// USAGE: node run/server.js
// ============================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateVideo } = require('./pipeline');
const { getRegistryStats, resetRegistry } = require('./contentRegistry');
const { createLogger } = require('./logger');

const log = createLogger('Server');
const app = express();
app.use(express.json());

// In-memory job store
const jobs = new Map();

// ── POST /generate ─────────────────────────────────────────
// Body: { topic, niche?, tone?, targetDurationSeconds?, format?, maxVariants? }
app.post('/generate', async (req, res) => {
  const { topic, niche, tone, targetDurationSeconds, format, maxVariants } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'running', startedAt: new Date().toISOString() });

  // Run pipeline in background, don't await
  generateVideo(topic.trim(), {
    niche: niche || 'finance',
    tone: tone || 'authoritative_yet_accessible',
    targetDurationSeconds: targetDurationSeconds || 60,
    format: format || 'youtube_short',
    maxVariants: maxVariants || 3,
  }).then(result => {
    jobs.set(jobId, {
      status: result.success ? 'done' : 'failed',
      completedAt: new Date().toISOString(),
      result,
    });
    log.info('Job completed', { jobId, success: result.success });
  }).catch(err => {
    jobs.set(jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err.message,
    });
    log.error('Job crashed', { jobId, error: err.message });
  });

  log.info('Job queued', { jobId, topic });
  res.status(202).json({ jobId, status: 'running', message: 'Pipeline started. Poll /status/' + jobId });
});

// ── GET /status/:jobId ──────────────────────────────────────
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status !== 'done') {
    return res.json({ jobId: req.params.jobId, status: job.status, startedAt: job.startedAt, error: job.error });
  }

  const { result } = job;
  res.json({
    jobId: req.params.jobId,
    status: 'done',
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    success: result.success,
    totalTimeMs: result.totalTimeMs,
    hook: result.hook ? { text: result.hook.text, pattern: result.hook.pattern, score: result.hook.strengthScore } : null,
    script: result.script ? {
      duration: result.script.totalDurationSeconds,
      segments: result.script.segments.length,
      words: result.script.wordCount,
    } : null,
    video: result.video ? {
      outputPath: result.video.outputPath,
      durationSeconds: result.video.durationSeconds,
      fileSizeMB: Math.round(result.video.fileSizeBytes / 1024 / 1024 * 100) / 100,
      assemblyTimeMs: result.video.assemblyTimeMs,
    } : null,
    error: result.error || null,
  });
});

// ── GET /jobs ───────────────────────────────────────────────
app.get('/jobs', (req, res) => {
  const list = [];
  for (const [jobId, job] of jobs) {
    list.push({
      jobId,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt || null,
      topic: job.result?.script?.topic || null,
    });
  }
  res.json({ total: list.length, jobs: list.reverse() });
});

// ── GET /registry ───────────────────────────────────────────
app.get('/registry', (req, res) => {
  res.json(getRegistryStats());
});

// ── DELETE /registry ────────────────────────────────────────
app.delete('/registry', (req, res) => {
  resetRegistry();
  log.info('Registry reset');
  res.json({ message: 'Registry cleared' });
});

// ── GET /video/:jobId — stream the MP4 ─────────────────────
app.get('/video/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.result?.video?.outputPath) {
    return res.status(404).json({ error: 'Video not ready or not found' });
  }

  // Convert Windows-style path to local path
  const videoPath = job.result.video.outputPath.replace(/\\/g, path.sep);
  const absPath = videoPath.startsWith(path.sep) ? videoPath : path.join('/', videoPath);

  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Video file not found on disk', path: absPath });
  }

  const stat = fs.statSync(absPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(absPath).pipe(res);
  }
});

// ── GET /health ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), jobs: jobs.size });
});

// ── GET / — Browser Dashboard ───────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Content OS</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:24px}
  h1{font-size:1.6rem;font-weight:700;color:#fff;margin-bottom:4px}
  .subtitle{color:#64748b;font-size:.9rem;margin-bottom:28px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:1000px;margin:0 auto}
  @media(max-width:700px){.grid{grid-template-columns:1fr}}
  .card{background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px}
  .card h2{font-size:1rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px}
  label{display:block;font-size:.85rem;color:#94a3b8;margin-bottom:6px}
  input,select{width:100%;background:#0f1117;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;padding:10px 12px;font-size:.95rem;outline:none;margin-bottom:12px}
  input:focus,select:focus{border-color:#6366f1}
  button{width:100%;background:#6366f1;color:#fff;border:none;border-radius:8px;padding:11px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .15s}
  button:hover{background:#4f52d4}
  button:disabled{background:#2d3148;color:#64748b;cursor:not-allowed}
  .result{margin-top:16px;background:#0f1117;border-radius:8px;padding:14px;font-size:.82rem;font-family:monospace;color:#94a3b8;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto;display:none}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;font-weight:600}
  .badge-done{background:#14532d;color:#4ade80}
  .badge-running{background:#1e3a5f;color:#60a5fa}
  .badge-failed{background:#450a0a;color:#f87171}
  .job-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #2d3148;font-size:.85rem}
  .job-row:last-child{border-bottom:none}
  .job-topic{flex:1;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .job-time{color:#475569;font-size:.75rem}
  .stat-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2d3148;font-size:.88rem}
  .stat-row:last-child{border-bottom:none}
  .stat-val{color:#6366f1;font-weight:600}
  #statusBox .result{display:block}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid #6366f1;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .header{max-width:1000px;margin:0 auto 24px}
</style>
</head>
<body>
<div class="header">
  <h1>Content OS</h1>
  <p class="subtitle">AI Video Pipeline — Phase 1</p>
</div>
<div class="grid">

  <!-- Generate -->
  <div class="card">
    <h2>Generate Video</h2>
    <label>Topic</label>
    <input id="topic" type="text" placeholder="e.g. Investing tips during global tensions"/>
    <label>Format</label>
    <select id="format">
      <option value="youtube_short">YouTube Short</option>
      <option value="instagram_reel">Instagram Reel</option>
      <option value="tiktok">TikTok</option>
    </select>
    <label>Duration (seconds)</label>
    <select id="duration">
      <option value="30">30s</option>
      <option value="60" selected>60s</option>
      <option value="90">90s</option>
    </select>
    <button id="genBtn" onclick="generate()">Generate</button>
    <div class="result" id="genResult"></div>
  </div>

  <!-- Video Player -->
  <div class="card" id="playerCard" style="display:none">
    <h2>Video Preview</h2>
    <video id="videoPlayer" controls playsinline style="width:100%;border-radius:8px;background:#000;max-height:400px">
      Your browser does not support video.
    </video>
    <div style="margin-top:10px;display:flex;gap:8px">
      <a id="downloadLink" href="#" download style="flex:1;background:#1e2130;border:1px solid #2d3148;color:#94a3b8;border-radius:8px;padding:9px;font-size:.85rem;text-align:center;text-decoration:none">Download MP4</a>
      <div id="videoMeta" style="flex:1;font-size:.78rem;color:#64748b;padding:9px"></div>
    </div>
  </div>

  <!-- Check Status -->
  <div class="card" id="statusBox">
    <h2>Check Job Status</h2>
    <label>Job ID</label>
    <input id="jobId" type="text" placeholder="Paste job ID here"/>
    <button onclick="checkStatus()">Check Status</button>
    <div class="result" id="statusResult"></div>
  </div>

  <!-- Jobs List -->
  <div class="card">
    <h2>Recent Jobs <button onclick="loadJobs()" style="width:auto;padding:4px 12px;font-size:.75rem;margin-left:8px">Refresh</button></h2>
    <div id="jobsList"><p style="color:#475569;font-size:.85rem">Click Refresh to load jobs.</p></div>
  </div>

  <!-- Registry Stats -->
  <div class="card">
    <h2>Registry Stats <button onclick="loadRegistry()" style="width:auto;padding:4px 12px;font-size:.75rem;margin-left:8px">Refresh</button></h2>
    <div id="registryStats"><p style="color:#475569;font-size:.85rem">Click Refresh to load stats.</p></div>
  </div>

</div>
<script>
async function generate() {
  const topic = document.getElementById('topic').value.trim();
  if (!topic) { alert('Enter a topic first'); return; }
  const btn = document.getElementById('genBtn');
  const box = document.getElementById('genResult');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating...';
  box.style.display = 'block';
  box.textContent = 'Starting pipeline...';
  try {
    const r = await fetch('/generate', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        topic,
        format: document.getElementById('format').value,
        targetDurationSeconds: parseInt(document.getElementById('duration').value),
      })
    });
    const data = await r.json();
    box.textContent = JSON.stringify(data, null, 2);
    document.getElementById('jobId').value = data.jobId || '';
    // Auto-poll
    if (data.jobId) pollJob(data.jobId, box);
  } catch(e) {
    box.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

async function pollJob(jobId, box) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const r = await fetch('/status/' + jobId);
      const data = await r.json();
      box.textContent = JSON.stringify(data, null, 2);
      if (data.status === 'done') {
        loadJobs();
        if (data.success) showPlayer(jobId, data);
        break;
      }
      if (data.status === 'failed') { loadJobs(); break; }
    } catch(e) { break; }
  }
}

function showPlayer(jobId, data) {
  const card = document.getElementById('playerCard');
  const player = document.getElementById('videoPlayer');
  const dl = document.getElementById('downloadLink');
  const meta = document.getElementById('videoMeta');
  const url = '/video/' + jobId;
  player.src = url;
  dl.href = url;
  dl.download = jobId + '.mp4';
  meta.innerHTML = \`Hook: <b style="color:#e2e8f0">\${data.hook?.pattern || ''}</b><br>
    Score: <b style="color:#6366f1">\${data.hook?.score || ''}</b><br>
    Duration: <b style="color:#e2e8f0">\${data.script?.duration || ''}s</b><br>
    Time: <b style="color:#e2e8f0">\${data.totalTimeMs}ms</b>\`;
  card.style.display = 'block';
  player.load();
  card.scrollIntoView({ behavior: 'smooth' });
}

async function checkStatus() {
  const jobId = document.getElementById('jobId').value.trim();
  if (!jobId) { alert('Enter a job ID'); return; }
  const box = document.getElementById('statusResult');
  box.style.display = 'block';
  box.textContent = 'Loading...';
  try {
    const r = await fetch('/status/' + jobId);
    const data = await r.json();
    box.textContent = JSON.stringify(data, null, 2);
  } catch(e) {
    box.textContent = 'Error: ' + e.message;
  }
}

async function loadJobs() {
  const el = document.getElementById('jobsList');
  try {
    const r = await fetch('/jobs');
    const data = await r.json();
    if (!data.jobs.length) { el.innerHTML = '<p style="color:#475569;font-size:.85rem">No jobs yet.</p>'; return; }
    el.innerHTML = data.jobs.slice(0,10).map(j => \`
      <div class="job-row">
        <span class="badge badge-\${j.status}">\${j.status}</span>
        <span class="job-topic">\${j.topic || j.jobId}</span>
        <span class="job-time">\${j.completedAt ? new Date(j.completedAt).toLocaleTimeString() : 'running'}</span>
      </div>\`).join('');
  } catch(e) {
    el.innerHTML = '<p style="color:#f87171">Failed to load</p>';
  }
}

async function loadRegistry() {
  const el = document.getElementById('registryStats');
  try {
    const r = await fetch('/registry');
    const d = await r.json();
    el.innerHTML = \`
      <div class="stat-row"><span>Total Fingerprints</span><span class="stat-val">\${d.totalFingerprints}</span></div>
      <div class="stat-row"><span>Unique Topics</span><span class="stat-val">\${d.uniqueTopics}</span></div>
      <div class="stat-row"><span>Unique Hook Patterns</span><span class="stat-val">\${d.uniqueHookPatterns}</span></div>\`;
  } catch(e) {
    el.innerHTML = '<p style="color:#f87171">Failed to load</p>';
  }
}

loadJobs();
loadRegistry();
</script>
</body>
</html>`);
});

// ── 404 fallback ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    routes: [
      'POST  /generate',
      'GET   /status/:jobId',
      'GET   /jobs',
      'GET   /registry',
      'DELETE /registry',
      'GET   /health',
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log.info(`Server running on http://localhost:${PORT}`);
  console.log('\n' + '='.repeat(50));
  console.log(`  Content OS API — http://localhost:${PORT}`);
  console.log('='.repeat(50));
  console.log('  POST  /generate       — run the pipeline');
  console.log('  GET   /status/:jobId  — check job status');
  console.log('  GET   /jobs           — list all jobs');
  console.log('  GET   /registry       — dedup registry stats');
  console.log('  GET   /health         — health check');
  console.log('='.repeat(50) + '\n');
});
