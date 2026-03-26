// ============================================================
// MODULE: modules/scriptGenerator.ts
// PURPOSE: Generate full video scripts from hooks with configurable duration
// PHASE: 2
// STATUS: ACTIVE
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import {
  Hook,
  Script,
  ScriptSegment,
  ScriptGenerationRequest,
  ScriptGenerationResult,
  PipelineError,
  PipelineStage,
} from '../types';
import { SCRIPT_CONFIG, SYSTEM_CONFIG } from '../config';
import { callClaudeDirectly, callClaudeWithFallback } from '../infra/aiClient';
import { createLogger } from '../infra/logger';

const log = createLogger('ScriptGenerator');

// ─── SCRIPT STRUCTURE ───────────────────────────────────────

interface ScriptStructure {
  hookDuration: number;
  bodyDuration: number;
  ctaDuration: number;
  totalDuration: number;
  bodySegmentCount: number;
  wordsPerSegment: number;
}

function calculateStructure(targetDuration: number): ScriptStructure {
  const hookDuration = Math.min(5, targetDuration * 0.1);
  const ctaDuration = Math.min(5, targetDuration * 0.08);
  const bodyDuration = targetDuration - hookDuration - ctaDuration;
  const bodySegmentCount = Math.max(
    SCRIPT_CONFIG.minSegments - 1,
    Math.min(SCRIPT_CONFIG.maxSegments - 1, Math.floor(bodyDuration / 10))
  );
  const wordsPerSegment = Math.floor(
    (bodyDuration * SCRIPT_CONFIG.wordsPerSecond) / bodySegmentCount
  );
  return { hookDuration, bodyDuration, ctaDuration, totalDuration: targetDuration, bodySegmentCount, wordsPerSegment };
}

// ─── JSON TYPES ─────────────────────────────────────────────

interface ScriptScene {
  text: string;
  visual_query: string;
  visual_type: 'video' | 'image';
  emotion: string;
}

interface ScriptJSON {
  hook?: string;
  cta?: string;
  scenes: ScriptScene[];
}

// ─── MOCK DATA ───────────────────────────────────────────────

const MOCK_SCRIPT_JSON_ENGLISH: ScriptJSON = {
  hook: "73% of people who invest lose money. Here's the exact reason why.",
  cta: "Follow for more — and drop a comment if this changed how you think.",
  scenes: [
    {
      text: "73% of people who invest in the stock market lose money. That's not an opinion — it's a fact.",
      visual_query: "stock market crash red graph falling investors stressed",
      visual_type: "video",
      emotion: "shock",
    },
    {
      text: "They buy when everyone's excited. They panic sell the moment it drops.",
      visual_query: "traders panic selling stocks trading floor red numbers",
      visual_type: "video",
      emotion: "tension",
    },
    {
      text: "The top 1% do the opposite. They buy when there's blood in the streets. They hold when everyone else runs.",
      visual_query: "confident investor analyzing stock charts laptop finance",
      visual_type: "video",
      emotion: "revelation",
    },
    {
      text: "Warren Buffett made 80% of his fortune after age 50. His secret: he did nothing during every crash.",
      visual_query: "warren buffett interview wealth investing success",
      visual_type: "video",
      emotion: "proof",
    },
    {
      text: "The next crash is coming. Your job right now is to prepare — not panic.",
      visual_query: "stock market recovery growth chart upward trend success",
      visual_type: "video",
      emotion: "urgency",
    },
  ],
};

const MOCK_SCRIPT_JSON_HINGLISH: ScriptJSON = {
  hook: "Kal market 3% gira. Sabne becha. Ek ne 50 lakh kamaye.",
  cta: "Abhi share karo — aur comment mein batao tumhara kya plan hai!",
  scenes: [
    {
      text: "Kal market 3% gira. Sabne becha. Ek ne 50 lakh kamaye.",
      visual_query: "indian stock market sensex crash red candles falling",
      visual_type: "video",
      emotion: "shock",
    },
    {
      text: "Trump ne tariffs laga diye. India ka export 40% neeche. Dalal Street pe ghanta bajta raha.",
      visual_query: "donald trump tariffs announcement india trade war",
      visual_type: "video",
      emotion: "tension",
    },
    {
      text: "Jab market girta hai — dono cheez hoti hai. Ek darta hai, ek kharidta hai. Woh ek ameer hota hai.",
      visual_query: "wealthy indian investor buying stocks market dip opportunity",
      visual_type: "video",
      emotion: "revelation",
    },
    {
      text: "Tumhara portfolio abhi red mein hai. Par yeh wahi time hai — jab asli paisa banta hai.",
      visual_query: "portfolio investment recovery india finance rupee growth",
      visual_type: "video",
      emotion: "urgency",
    },
    {
      text: "Abhi share karo — aur comment mein batao tumhara kya plan hai!",
      visual_query: "indian youth mobile phone social media sharing finance",
      visual_type: "video",
      emotion: "hope",
    },
  ],
};

// ─── JSON PARSER ─────────────────────────────────────────────

function parseScriptJSON(raw: string): ScriptJSON | null {
  // Strip markdown code fences
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Extract first JSON object
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as ScriptJSON;
    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) return null;
    // Validate each scene has text
    if (!parsed.scenes.every(s => typeof s.text === 'string' && s.text.trim())) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── SEGMENT BUILDER ────────────────────────────────────────

const HINGLISH_SCENE_DURATIONS = [3, 12, 25, 15, 5];
const EMOTIONAL_BEATS = ['tension', 'revelation', 'proof', 'application', 'urgency'] as const;

function buildSegmentsFromJSON(
  parsed: ScriptJSON,
  structure: ScriptStructure,
  hook: Hook,
  language: string
): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  const isIndian = language === 'hinglish' || language === 'hindi';

  parsed.scenes.forEach((scene, i) => {
    let durationSeconds: number;
    let emotionalBeat: string;

    if (isIndian) {
      durationSeconds = HINGLISH_SCENE_DURATIONS[Math.min(i, HINGLISH_SCENE_DURATIONS.length - 1)];
      const hinglishBeats = ['hook', 'context', 'explanation', 'impact', 'cta'];
      emotionalBeat = hinglishBeats[Math.min(i, hinglishBeats.length - 1)];
    } else {
      const wordCount = scene.text.split(/\s+/).length;
      durationSeconds = Math.max(3, Math.round((wordCount / SCRIPT_CONFIG.wordsPerSecond) * 10) / 10);
      emotionalBeat = EMOTIONAL_BEATS[i % EMOTIONAL_BEATS.length];
      // First scene gets hook beat
      if (i === 0) emotionalBeat = 'hook';
      // Last scene gets cta beat
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

// ─── FINGERPRINT ────────────────────────────────────────────

function generateScriptFingerprint(fullText: string, topic: string): string {
  const normalized = fullText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const structureSignature = normalized.split(/\s+/).length.toString();
  return crypto
    .createHash('sha256')
    .update(`${topic}:${structureSignature}:${normalized.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── ERROR FACTORY ──────────────────────────────────────────

function createScriptError(code: string, message: string): PipelineError {
  return {
    stage: PipelineStage.SCRIPT_GENERATION,
    code,
    message,
    retryable: true,
    timestamp: new Date(),
  };
}

// ─── MAIN: GENERATE SCRIPT ─────────────────────────────────

export async function generateScript(request: ScriptGenerationRequest): Promise<ScriptGenerationResult> {
  const startTime = Date.now();
  const language = request.voiceLanguage || 'english';
  const isIndian = language === 'hinglish' || language === 'hindi';

  log.info('Starting script generation', {
    topic: request.topic,
    hookPattern: request.hook.pattern,
    targetDuration: request.targetDurationSeconds,
    language,
  });

  const structure = calculateStructure(request.targetDurationSeconds);
  log.info('Script structure calculated', {
    hookDuration: structure.hookDuration,
    bodyDuration: structure.bodyDuration,
    bodySegments: structure.bodySegmentCount,
  });

  const mockFallback = isIndian ? MOCK_SCRIPT_JSON_HINGLISH : MOCK_SCRIPT_JSON_ENGLISH;

  const researchContext = request.researchBrief || '';
  if (researchContext) log.info('Using pre-researched brief', { chars: researchContext.length });

  async function attemptGeneration(temperature: number): Promise<{ script: Script; tokensUsed: number; model: string }> {
    const response = await callClaudeDirectly(
      {
        systemPrompt: buildSystemPrompt(request.niche, request.tone, language, researchContext),
        prompt: buildScriptPrompt(request, structure, language, researchContext),
        maxTokens: 800,
        temperature,
      },
      () => JSON.stringify(mockFallback)
    );

    let parsed = parseScriptJSON(response.content);
    if (!parsed) {
      log.warn('JSON parse failed — using mock fallback', { preview: response.content.slice(0, 100) });
      parsed = mockFallback;
    }

    const segs = buildSegmentsFromJSON(parsed, structure, request.hook, language);

    const ft = segs.map(s => s.text).join(' ');
    const dur = segs.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0);

    // DECISION: soft duration warn — real content > duration perfection
    const minDur = request.targetDurationSeconds * 0.8;
    const maxDur = request.targetDurationSeconds * 1.2;
    if (dur < minDur || dur > maxDur) {
      log.warn('Script duration out of range — keeping script', {
        dur, minDur, maxDur, targetDuration: request.targetDurationSeconds,
      });
    }

    const wordCount = ft.split(/\s+/).filter(Boolean).length;
    if (wordCount > 200) {
      log.warn('Script word count over 200 — keeping script (70-80s is acceptable)', {
        wordCount, targetDuration: request.targetDurationSeconds,
      });
    }

    const s: Script = {
      id: uuidv4(),
      hook: request.hook,
      segments: segs,
      fullText: ft,
      totalDurationSeconds: Math.round(dur * 10) / 10,
      wordCount,
      topic: request.topic,
      fingerprint: generateScriptFingerprint(ft, request.topic),
    };
    return { script: s, tokensUsed: response.tokensUsed, model: response.model };
  }

  const attempt = await attemptGeneration(0.5);

  let script = attempt.script;

  // ─── POST-GENERATION HARD CAP: 5 segments max (160 word target) ──
  if (script.wordCount > 160 && script.segments.length > 5) {
    const capped = script.segments.slice(0, 5);
    const cappedText = capped.map(s => s.text).join(' ');
    const cappedDur = Math.round(capped.reduce((sum, s) => sum + s.estimatedDurationSeconds, 0) * 10) / 10;
    const cappedWordCount = cappedText.split(/\s+/).filter(Boolean).length;
    log.info('Script capped at 5 segments for 60s target', {
      originalSegments: script.segments.length,
      originalWordCount: script.wordCount,
      cappedWordCount,
      cappedDuration: cappedDur,
    });
    script = {
      ...script,
      segments: capped,
      fullText: cappedText,
      totalDurationSeconds: cappedDur,
      wordCount: cappedWordCount,
    };
  }

  const generationTimeMs = Date.now() - startTime;
  log.info('Script generation complete', {
    scriptId: script.id,
    segments: script.segments.length,
    totalDuration: script.totalDurationSeconds,
    wordCount: script.wordCount,
    timeMs: generationTimeMs,
  });

  return {
    script,
    generationTimeMs,
    tokensUsed: attempt.tokensUsed,
    provider: SYSTEM_CONFIG.useMocks ? 'mock' : attempt.model,
  };
}

// ─── PROMPT BUILDERS ────────────────────────────────────────

function buildSystemPrompt(niche: string, tone: string, language = 'english', researchBrief = ''): string {
  const researchInjection = researchBrief
    ? `Use this verified research to ground your script with real facts:\n${researchBrief}\nDo not invent statistics. Only use figures from the research above or well-known verified facts.\n\n`
    : '';
  const jsonSchema = `Return ONLY valid JSON — no markdown, no explanation, no extra text:
{
  "hook": "single shocking opening line",
  "cta": "call to action line",
  "scenes": [
    {
      "text": "exact spoken narration (1-2 sentences)",
      "visual_query": "searchable English stock footage — MUST match the topic and what is literally being said in this segment, not generic finance",
      "visual_type": "video",
      "emotion": "shock|fear|curiosity|tension|surprise|confidence|urgency|hope"
    }
  ]
}`;

  const styleHint = niche && niche !== 'general'
    ? `CONTENT STYLE: ${niche} angle — use to frame WHY the viewer cares, NOT to restrict the topic`
    : '';

  const absoluteRules = `ABSOLUTE RULES — violating these means the output is wrong:
1. NEVER mention Dafabet, Dream11, MPL, or any betting/fantasy app
2. NEVER mention prize money from contests
3. NEVER suggest viewers bet or predict for money
4. If research mentions betting data, completely ignore it
5. Focus ONLY on: which team will win and WHY based on player form, team strength, past IPL record, captain strategy

`;

  if (language === 'hinglish' || language === 'hindi') {
    return `${absoluteRules}${researchInjection}You are a real Indian content creator making viral 60-second videos on ANY topic — war, politics, economy, sports, technology. You explain it like a friend over chai, not a news anchor.

TONE: ${tone}
${styleHint}

STRICT LENGTH RULE: Total script MUST be 60 seconds maximum.
That means 150 words MAXIMUM across all segments combined.
Each segment: 1-2 sentences only. Short. Punchy. No padding.

TONE RULES — mandatory:
- Write like a real Indian person talking to a friend
- Short sentences. Max 10 words per sentence.
- No formal words: never use 'however', 'therefore', 'it is essential', 'according to', 'various'
- Use contractions: don't, won't, can't
- Energy and excitement — not dry analysis
- Every segment must feel urgent and interesting

YOUR JOB: Use the RESEARCHED FACTS below to write the script. Do NOT use generic content. Every scene must use real names, real numbers, real events from the research.

SPOKEN TEXT RULES:
- Max 10 words per sentence. Hard limit.
- Natural Hinglish: "Yaar, dekh kya hua" / "Bhai, 40 crore affected hue" / "Soch — yeh tere saath bhi ho sakta hai"
- EXACT numbers from research: never "bahut log" — always "3 crore 40 lakh log"
- Indian analogies when explaining: compare to things Indians actually experience

BANNED WORDS — zero tolerance:
furthermore, moreover, however, additionally, crucial, essential, vital, significant,
important, key, delve, navigate, leverage, utilize, implement, ensure, facilitate,
it is important to note, in conclusion, to summarize, this means that, moving forward

BAD: "It is crucial to understand the significant implications of this development."
GOOD: "Yaar, 40 lakh jobs gaye. Ek hi hafte mein. Aur koi nahi bola."

VISUAL QUERY — CRITICAL RULE:
visual_query MUST be directly related to the topic. Never use generic finance or stock market visuals unless the topic is specifically about finance or stocks. Match the visual to what is literally being said in that segment.
BAD: "stock market graph falling"
GOOD (IPL topic): "cricket stadium crowd cheering IPL match"
GOOD (AI topic): "robot hand typing keyboard futuristic office"
GOOD (jobs topic): "people standing in job queue office building"
- Name real people and places: "modi parliament speech crowd", "ukraine war soldiers trench"
- NOT generic: NEVER "people worried" — YES "farmers protest delhi highway tractors"
- Always in English, 5-8 words

SCENE STRUCTURE (exactly 5 scenes):
1. HOOK (3s): One jaw-dropping line — stops the scroll cold
2. CONTEXT (12s): What happened — real names, real numbers from research
3. BREAKDOWN (25s): Why — root cause, with Indian analogy
4. IMPACT (15s): What it means for THIS viewer's life/money/future
5. CTA (5s): One urgent action

${jsonSchema}`;
  }

  return `${absoluteRules}${researchInjection}You are a real person making viral short-form videos on ANY topic — war, AI, economy, politics, science, sports. You explain it like a smart friend who just read everything about it.

TONE: ${tone}
${styleHint}

STRICT LENGTH RULE: Total script MUST be 60 seconds maximum.
That means 150 words MAXIMUM across all segments combined.
Each segment: 1-2 sentences only. Short. Punchy. No padding.

TONE RULES — mandatory:
- Write like a real Indian person talking to a friend
- Short sentences. Max 10 words per sentence.
- No formal words: never use 'however', 'therefore', 'it is essential', 'according to', 'various'
- Use contractions: don't, won't, can't
- Energy and excitement — not dry analysis
- Every segment must feel urgent and interesting

YOUR JOB: Use the RESEARCHED FACTS below. Every scene must be specific to THIS exact topic — real names, real numbers, real events. Zero generic content.

SPOKEN TEXT RULES:
- Every sentence max 12 words. Short. Punchy.
- Talk directly to ONE person: "you", "your country", "your job", "your future"
- EXACT numbers: "47 million jobs" not "millions of jobs"
- Create urgency with open loops: "But here's what nobody's saying..."
- Drop the viewer into the story. Never summarize.

BANNED PHRASES — zero tolerance:
furthermore, moreover, however, additionally, it is important to note,
crucial, essential, vital, significant, delve, navigate, leverage, utilize,
in conclusion, to summarize, this means that, one must consider,
the fact of the matter, at the end of the day, moving forward

BAD: "This development has significant implications for the global economy."
GOOD: "47 million jobs could vanish. By next year. And nobody's talking about it."

VISUAL QUERY — CRITICAL RULE:
visual_query for each segment MUST be directly related to the topic. Never use generic finance or stock market visuals unless the topic is specifically about finance or stocks. Match the visual to what is literally being said in that segment.
BAD: "stock market graph falling"
GOOD (IPL topic): "cricket stadium crowd cheering IPL match"
GOOD (AI topic): "robot hand typing keyboard futuristic office"
GOOD (jobs topic): "people standing in job queue office building"
- Real people: "donald trump signing executive order white house", "elon musk tesla factory"
- Real places/events: "ukraine war frontline soldiers tanks", "india pakistan border military tension"
- NOT generic: NEVER "business people meeting" — YES "silicon valley tech layoffs workers"
- 5-8 English words

SCENE STRUCTURE (5-6 scenes) — MANDATORY:
1. HOOK: Use the hook text verbatim — this is the first segment, word for word.
2-3. CORE CLAIM: Deliver the core claim immediately. No filler, no wind-up. Start with the most important fact.
4-5. PROOF: The second-to-last scene MUST contain one concrete data point or statistic (a real number, percentage, or named study).
6. CTA: End with a single direct call to action — choose exactly ONE: subscribe, comment, or follow. No alternatives, no hedging.

${jsonSchema}`;
}

function buildScriptPrompt(
  request: ScriptGenerationRequest,
  structure: ScriptStructure,
  language = 'english',
  researchContext = ''
): string {
  const isIndian = language === 'hinglish' || language === 'hindi';
  const keyPointsStr = request.keyPoints?.length
    ? `Key points to cover: ${request.keyPoints.join(', ')}\n`
    : '';
  const researchBlock = researchContext
    ? `\nRESEARCHED FACTS — use these specific details, numbers, and names in the script:\n${researchContext}\n`
    : '';

  const minWordCount = Math.floor(request.targetDurationSeconds * 2.5);
  const wordCountBlock = `WORD COUNT REQUIREMENT: This script MUST contain at least ${minWordCount} words total across all segments.
Current target: ${request.targetDurationSeconds} seconds = ${minWordCount} words minimum.
Each segment should be 2-4 sentences, not 1 sentence.`;

  if (isIndian) {
    return `TOPIC: ${request.topic}
NICHE: ${request.niche}
DURATION: 60 seconds
LANGUAGE: Hinglish (Hindi + English mix)
${wordCountBlock}
${keyPointsStr}${researchBlock}
Generate exactly 5 scenes. Use the researched facts for accuracy — real numbers, real names, real events.
Spoken text in Hinglish. visual_query MUST be in English and specific to this exact topic: "${request.topic}".
Every visual_query must match what is literally being said in that segment — never default to stock market or finance visuals unless this topic is specifically about finance.
Return ONLY the JSON object. No markdown. No explanation.`;
  }

  return `TOPIC: ${request.topic}
HOOK (already written): "${request.hook.text}"
TARGET DURATION: ${Math.round(structure.totalDuration)} seconds
NICHE: ${request.niche}
${wordCountBlock}
${keyPointsStr}${researchBlock}
Generate 5-6 scenes that follow from the hook and build to a CTA.
Use the researched facts — specific numbers, names, events. Each segment 2-4 sentences.
Every visual_query MUST match the topic "${request.topic}" and what is literally being said in that segment — never use generic finance or stock market visuals unless this topic is specifically about finance.
Return ONLY the JSON object. No markdown. No explanation.`;
}
