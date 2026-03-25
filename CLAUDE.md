# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There are two parallel codebases: `src/` (TypeScript, for production) and `run/` (compiled JS, for quick iteration). Most active development uses `run/`.

```bash
# Run the full system demo (TypeScript)
cd content-os && npx ts-node src/index.ts

# Run the Phase 1 pipeline (JS — fastest for testing video output)
cd content-os && node run/index.js

# Run the web dashboard
cd content-os && npx ts-node src/web/server.ts
# then open http://localhost:3000

# Compile TypeScript
cd content-os && npm run build

# YouTube OAuth setup (one-time)
cd content-os && npm run auth:youtube
```

Video output lands in `os.tmpdir()/content-os/output/` (Windows: `%TEMP%\content-os\output\`). Temp audio in `os.tmpdir()/content-os/assembly/audio/`.

## Architecture

### Dual-codebase structure
`src/` is TypeScript source. `run/` contains standalone JS modules that mirror `src/` — used for rapid iteration without the TypeScript compile step. **When fixing bugs or modifying behavior, update both** `src/modules/X.ts` and `run/X.js` if the file exists in both.

### Pipeline flow (7 stages)
```
topic → dedup_check → hook_generation → script_generation → full_dedup_check
      → video_assembly (voice + FFmpeg) → publish → registry_store
```
Each stage is wrapped in `executeStage()` which enforces `stageTimeoutMs` (120s). The pipeline returns a `PipelineResult` on both success and failure — it never throws. Checkpoints are saved in-memory after each stage so partial failures can resume (Phase 2: Redis).

### AI provider hierarchy
`infra/aiClient.ts` routes all LLM calls: **Groq first** (free, `llama-3.3-70b`) → **Claude fallback** (`claude-sonnet-4`) → **hardcoded mock fallback**. Controlled by `USE_MOCKS=false` in `.env`. When `USE_MOCKS=true` (default if unset), all AI calls return mock data from `src/mocks/mockAiProvider.ts` with no API usage.

### Video assembly (`run/videoAssembler.js`)
The video assembler is the most complex module:
1. Calls ElevenLabs API directly via Node's `https` module (no SDK) using voice `21m00Tcm4TlvDq8ikWAM` (Rachel)
2. Builds an FFmpeg filtergraph with `vignette` + `drawtext` captions — **do not use `geq` filter** (too slow: per-pixel expression eval across all frames)
3. Uses `-preset ultrafast` intentionally for speed over file size
4. Hook text shown for first 5 seconds in yellow, captions shown in lower third with style-based coloring (yellow=pop, cyan=highlight, white=normal)

### Content registry (`src/registry/contentRegistry.ts`)
Fingerprints every generated piece using SHA-256 hashes of topic + hook text + script structure + full text. The similarity check is hash-based in Phase 1 (exact/near-exact). Phase 3 will add embedding-based cosine similarity via `similarityEngine.ts`.

### Phase 4 intelligence modules
`DecisionEngine`, `EvolutionEngine`, `ExperimentEngine`, `PortfolioEngine` — these operate on mock performance data in the current demo. They are called from `src/index.ts` for demonstration but are not yet wired into the live pipeline loop.

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `USE_MOCKS` | `false` = real APIs, `true` (default) = mock data |
| `CLAUDE_API_KEY` | Primary LLM (fallback after Groq) |
| `GROQ_API_KEY` | Primary LLM (free tier, tried first) |
| `ELEVENLABS_API_KEY` | Voice generation (Rachel voice) |
| `YOUTUBE_REFRESH_TOKEN` | Required for YouTube upload (generate via `npm run auth:youtube`) |
| `PEXELS_API_KEY` | Stock footage backgrounds (free at pexels.com/api) |
| `CLOUDINARY_*` | Video hosting for Instagram upload |
| `INSTAGRAM_ACCESS_TOKEN` / `INSTAGRAM_ACCOUNT_ID` | Instagram Graph API |

## Key architectural decisions

- **`run/` JS files load `.env` explicitly** via `require('dotenv').config({ path: '../.env' })` at the top. `src/` TS files use `import 'dotenv/config'`. If env vars aren't loading in `run/`, check that dotenv.config path is correct.
- **`run/config.js` uses `os.tmpdir()`** for paths — don't hardcode `/tmp/` (breaks on Windows).
- **Pipeline timeouts**: `stageTimeoutMs: 120000`, `totalTimeoutMs: 600000`. ElevenLabs + FFmpeg assembly for a 60s video takes ~30-60s total.
- **FFmpeg is a hard dependency** — must be installed and on PATH. All video output is 1080×1920 (vertical short-form format) encoded with libx264.
- **The `run/mockAiProvider.js` mock hooks and scripts are finance-niche specific.** To target a different niche, mock data must be updated alongside `HOOK_CONFIG.financePatterns` in `src/config/index.ts`.
