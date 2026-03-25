// ============================================================
// MODULE: scriptGenerator.js
// PURPOSE: Generate full video scripts with JSON scene output
// PHASE: 2
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { SCRIPT_CONFIG } = require('./config');

const log = createLogger('ScriptGenerator');

// ─── STRUCTURE ───────────────────────────────────────────────

function calculateStructure(targetDuration) {
  const hookDuration = Math.min(5, targetDuration * 0.1);
  const ctaDuration = Math.min(5, targetDuration * 0.08);
  const bodyDuration = targetDuration - hookDuration - ctaDuration;
  const bodySegmentCount = Math.max(2, Math.min(7, Math.floor(bodyDuration / 10)));
  const wordsPerSegment = Math.floor((bodyDuration * SCRIPT_CONFIG.wordsPerSecond) / bodySegmentCount);
  return { hookDuration, bodyDuration, ctaDuration, totalDuration: targetDuration, bodySegmentCount, wordsPerSegment };
}

// ─── MOCK DATA ───────────────────────────────────────────────

const MOCK_ENGLISH = {
  hook: "73% of people who invest lose money. Here's the exact reason why.",
  cta: "Follow for more — and drop a comment if this changed how you think.",
  scenes: [
    { text: "73% of people who invest in the stock market lose money. That's not an opinion — it's a fact.", visual_query: "stock market crash red graph falling investors stressed", visual_type: "video", emotion: "shock" },
    { text: "They buy when everyone's excited. They panic sell the moment it drops.", visual_query: "traders panic selling stocks trading floor red numbers", visual_type: "video", emotion: "tension" },
    { text: "The top 1% do the opposite. They buy when there's blood in the streets.", visual_query: "confident investor analyzing stock charts laptop finance", visual_type: "video", emotion: "revelation" },
    { text: "Warren Buffett made 80% of his fortune after age 50. By doing nothing during crashes.", visual_query: "warren buffett interview wealth investing success", visual_type: "video", emotion: "proof" },
    { text: "The next crash is coming. Your job right now is to prepare — not panic.", visual_query: "stock market recovery growth chart upward trend success", visual_type: "video", emotion: "urgency" },
  ],
};

const MOCK_HINGLISH = {
  hook: "Kal market 3% gira. Sabne becha. Ek ne 50 lakh kamaye.",
  cta: "Abhi share karo — aur comment mein batao tumhara kya plan hai!",
  scenes: [
    { text: "Kal market 3% gira. Sabne becha. Ek ne 50 lakh kamaye.", visual_query: "indian stock market sensex crash red candles falling", visual_type: "video", emotion: "shock" },
    { text: "Trump ne tariffs laga diye. India ka export 40% neeche. Dalal Street pe ghanta bajta raha.", visual_query: "donald trump tariffs announcement india trade war", visual_type: "video", emotion: "tension" },
    { text: "Jab market girta hai — dono cheez hoti hai. Ek darta hai, ek kharidta hai. Woh ek ameer hota hai.", visual_query: "wealthy indian investor buying stocks market dip opportunity", visual_type: "video", emotion: "revelation" },
    { text: "Tumhara portfolio abhi red mein hai. Par yeh wahi time hai — jab asli paisa banta hai.", visual_query: "portfolio investment recovery india finance rupee growth", visual_type: "video", emotion: "urgency" },
    { text: "Abhi share karo — aur comment mein batao tumhara kya plan hai!", visual_query: "indian youth mobile phone social media sharing finance", visual_type: "video", emotion: "hope" },
  ],
};

// ─── JSON PARSER ─────────────────────────────────────────────

function parseScriptJSON(raw) {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) return null;
    if (!parsed.scenes.every(s => typeof s.text === 'string' && s.text.trim())) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── SEGMENT BUILDER ─────────────────────────────────────────

const HINGLISH_SCENE_DURATIONS = [3, 12, 25, 15, 5];
const EMOTIONAL_BEATS = ['tension', 'revelation', 'proof', 'application', 'urgency'];

function buildSegmentsFromJSON(parsed, structure, hook, language) {
  const isIndian = language === 'hinglish' || language === 'hindi';
  const segments = [];

  parsed.scenes.forEach((scene, i) => {
    let durationSeconds, emotionalBeat;

    if (isIndian) {
      durationSeconds = HINGLISH_SCENE_DURATIONS[Math.min(i, HINGLISH_SCENE_DURATIONS.length - 1)];
      const hinglishBeats = ['hook', 'context', 'explanation', 'impact', 'cta'];
      emotionalBeat = hinglishBeats[Math.min(i, hinglishBeats.length - 1)];
    } else {
      const wordCount = scene.text.split(/\s+/).length;
      durationSeconds = Math.max(3, Math.round((wordCount / SCRIPT_CONFIG.wordsPerSecond) * 10) / 10);
      emotionalBeat = EMOTIONAL_BEATS[i % EMOTIONAL_BEATS.length];
      if (i === 0) emotionalBeat = 'hook';
      if (i === parsed.scenes.length - 1) emotionalBeat = 'cta';
    }

    segments.push({
      index: i,
      text: scene.text,
      estimatedDurationSeconds: durationSeconds,
      visualCue: scene.visual_query || 'stock_footage:generic_b_roll',
      emotionalBeat,
      visual_query: scene.visual_query || undefined,
      visual_type: scene.visual_type || 'video',
      emotion: scene.emotion || undefined,
    });
  });

  return segments;
}

// ─── AI CALL ─────────────────────────────────────────────────

async function callAI(systemPrompt, userPrompt) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1200,
          temperature: 0.5,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
      const data = await response.json();
      if (data.choices?.[0]?.message?.content) {
        log.info('Script generated via Groq');
        return data.choices[0].message.content.trim();
      }
    } catch (err) {
      log.warn('Groq failed — trying Claude', { error: err.message });
    }
  }

  const claudeKey = process.env.CLAUDE_API_KEY;
  if (claudeKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      const data = await response.json();
      if (data.content?.[0]?.text) {
        log.info('Script generated via Claude');
        return data.content[0].text.trim();
      }
    } catch (err) {
      log.warn('Claude failed — using mock', { error: err.message });
    }
  }

  return null;
}

// ─── PROMPT BUILDERS ─────────────────────────────────────────

function buildSystemPrompt(niche, tone, language) {
  const jsonSchema = `Return ONLY valid JSON — no markdown, no explanation:
{
  "hook": "single shocking opening line",
  "cta": "call to action line",
  "scenes": [
    {
      "text": "spoken narration (1-2 sentences)",
      "visual_query": "searchable English stock footage description",
      "visual_type": "video",
      "emotion": "shock|fear|curiosity|tension|surprise|confidence|urgency|hope"
    }
  ]
}`;

  if (language === 'hinglish' || language === 'hindi') {
    return `You are a real Indian content creator. You talk like a friend over chai, not a news anchor.

NICHE: ${niche}
TONE: ${tone}

SPOKEN TEXT RULES:
- Max 10 words per sentence. Hard limit.
- Mix Hindi + English: "Yaar, yeh soch" / "Bhai sun"
- Use real numbers: "50 lakh rupaye", "40% crash"

BANNED WORDS in spoken text:
furthermore, moreover, crucial, essential, vital, significant, delve, navigate,
leverage, utilize, implement, in conclusion, to summarize, this means that

BAD: "It is crucial to understand that markets experienced significant volatility."
GOOD: "Yaar, market 40% gira. Ek hi din mein."

VISUAL QUERY: MUST be in English (for Pexels search)
- Specific: "sensex crash red candles trading screen" not "bad market"

SCENE STRUCTURE (exactly 5 scenes):
1. HOOK (3s): One shocking line
2. CONTEXT (12s): What happened. Real names. Real numbers.
3. BREAKDOWN (25s): Why. Simple Indian comparison.
4. IMPACT (15s): Viewer's money/job/life
5. CTA (5s): One urgent action

${jsonSchema}`;
  }

  return `You are a real person making viral short-form videos — not an AI, not a journalist.

NICHE: ${niche}
TONE: ${tone}

SPOKEN TEXT RULES:
- Every sentence max 12 words. Short. Punchy.
- Talk to ONE person: "you", "your money", "your job"
- Use specific numbers: "73% of people" not "most people"

BANNED PHRASES:
furthermore, moreover, crucial, essential, vital, significant, delve, navigate,
leverage, utilize, in conclusion, to summarize, it is important to note

BAD: "It is important to note this has significant implications."
GOOD: "Here's what this means for your wallet. Right now."

VISUAL QUERY: searchable English description for stock footage API

SCENE STRUCTURE (5-6 scenes):
1. HOOK: One shocking statement
2-4. BODY: Build story, proof, insight
5-6. IMPACT + CTA: Personal consequence and action

${jsonSchema}`;
}

function buildScriptPrompt(request, structure, language) {
  const isIndian = language === 'hinglish' || language === 'hindi';

  if (isIndian) {
    return `TOPIC: ${request.topic}
NICHE: ${request.niche}
DURATION: 60 seconds

Generate exactly 5 scenes. Spoken text in Hinglish. visual_query MUST be in English.
Return ONLY the JSON object. No markdown. No explanation.`;
  }

  return `TOPIC: ${request.topic}
HOOK (already written): "${request.hook.text}"
TARGET DURATION: ${Math.round(structure.totalDuration)} seconds

Generate 5-6 scenes that follow from the hook and build to a CTA.
Each scene: 1-2 punchy sentences. Real person talking.
Return ONLY the JSON object. No markdown. No explanation.`;
}

// ─── FINGERPRINT ─────────────────────────────────────────────

function generateScriptFingerprint(fullText, topic) {
  const normalized = fullText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const structSig = normalized.split(/\s+/).length.toString();
  return crypto.createHash('sha256').update(`${topic}:${structSig}:${normalized.slice(0, 200)}`).digest('hex').slice(0, 16);
}

// ─── MAIN ────────────────────────────────────────────────────

async function generateScript(request) {
  const startTime = Date.now();
  const language = request.voiceLanguage || 'english';
  const isIndian = language === 'hinglish' || language === 'hindi';

  log.info('Starting script generation', { topic: request.topic, targetDuration: request.targetDurationSeconds, language });

  const structure = calculateStructure(request.targetDurationSeconds);
  const mockFallback = isIndian ? MOCK_HINGLISH : MOCK_ENGLISH;

  let parsed = null;

  if (process.env.USE_MOCKS !== 'true') {
    const systemPrompt = buildSystemPrompt(request.niche, request.tone || 'authoritative_yet_accessible', language);
    const userPrompt = buildScriptPrompt(request, structure, language);
    const raw = await callAI(systemPrompt, userPrompt);
    if (raw) {
      parsed = parseScriptJSON(raw);
      if (!parsed) log.warn('JSON parse failed — using mock', { preview: raw.slice(0, 80) });
    }
  }

  if (!parsed) {
    parsed = mockFallback;
    log.info('Using mock script JSON');
  }

  const segments = buildSegmentsFromJSON(parsed, structure, request.hook, language);
  const fullText = segments.map(s => s.text).join(' ');
  const totalDuration = segments.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);

  const script = {
    id: crypto.randomUUID(),
    hook: request.hook,
    segments,
    fullText,
    totalDurationSeconds: Math.round(totalDuration * 10) / 10,
    wordCount: fullText.split(/\s+/).length,
    topic: request.topic,
    fingerprint: generateScriptFingerprint(fullText, request.topic),
  };

  log.info('Script generation complete', {
    scriptId: script.id,
    segments: segments.length,
    duration: script.totalDurationSeconds,
    words: script.wordCount,
    timeMs: Date.now() - startTime,
  });

  return { script, generationTimeMs: Date.now() - startTime, tokensUsed: 0, provider: parsed === mockFallback ? 'mock' : 'ai' };
}

module.exports = { generateScript };
