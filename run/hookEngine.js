// ============================================================
// MODULE: hookEngine.js
// PURPOSE: Generate high-retention hooks for short-form video
// PHASE: 1
// ============================================================

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { HOOK_CONFIG, SYSTEM_CONFIG } = require('./config');
const { getMockHooks } = require('./mockAiProvider');

const log = createLogger('HookEngine');

const HOOK_PATTERNS = [
  'curiosity_gap', 'shocking_stat', 'direct_question',
  'pattern_interrupt', 'bold_claim', 'story_open', 'contrarian',
];

// Hinglish hook templates for Indian content
const HINGLISH_HOOKS = {
  curiosity_gap: [
    'Yaar, ek baat batao — kya tumhe pata hai India ke 90% log yeh galti karte hain?',
    'Dosto, ek secret hai jo banks tumse chupate hain...',
    'Bhai, jo cheez main aaj bataunga — school mein kisi ne nahi sikhayi.',
  ],
  shocking_stat: [
    'India mein sirf 3% log financially free hain — baki sab ek hi cycle mein phanse hain.',
    '10 lakh salary, aur fir bhi savings zero? Yeh sun lo.',
    '25 saal ki umar tak 1 crore? Haan, possible hai — aur main prove karunga.',
  ],
  direct_question: [
    'Kya tumhara paisa tumhare liye kaam kar raha hai, ya tum paisa ke liye?',
    'Agar aaj job jaaye — kitne mahine chal sakte ho bina income ke?',
    'Ek sawal — tumhare paas 5 saal baad kitna hoga?',
  ],
  bold_claim: [
    'Main guarantee deta hoon — yeh ek cheez karoge toh financially set ho jaoge.',
    '99% log investment mein yeh mistake karte hain. Tum mat karna.',
    'Yeh formula follow karo — 10 saal mein 1 crore pakka.',
  ],
  contrarian: [
    'Log bolte hain saving karo — main keh raha hoon yeh bakwaas hai.',
    'Yaar, EMI lena smart move hai — agar sahi jagah karo.',
    'FD mein paisa rakhna matlab — apna paisa khud barbaad karna.',
  ],
  story_open: [
    'Mere dost ne 2 saal mein 50 lakh banaye — sirf ek cheez karke.',
    'Jab main 22 saal ka tha, mujhe pata tha yeh 3 financial rules — aaj share kar raha hoon.',
    'Ek baar meine apna poora paisa ek galti mein gawa diya — woh galti mat karna.',
  ],
  pattern_interrupt: [
    'Ruko! Pehle yeh video dekho — phir koi financial decision lena.',
    'Bas 60 seconds do — yeh sun ke financial life badal jayegi.',
    'Stop! Jo tum karne wale ho — woh mat karo pehle yeh suno.',
  ],
};

const PATTERN_WEIGHTS = {
  curiosity_gap: 0.25,
  shocking_stat: 0.20,
  bold_claim: 0.15,
  contrarian: 0.15,
  story_open: 0.10,
  direct_question: 0.10,
  pattern_interrupt: 0.05,
};

function scoreHook(text, pattern) {
  let score = 50;
  const wordCount = text.split(/\s+/).length;

  if (wordCount >= 8 && wordCount <= 15) score += 15;
  else if (wordCount >= 5 && wordCount <= 20) score += 8;
  else score -= 10;

  if (pattern === 'curiosity_gap' && text.includes('...')) score += 5;
  if (pattern === 'shocking_stat' && /\d+%/.test(text)) score += 10;
  if (pattern === 'direct_question' && text.endsWith('?')) score += 5;
  if (pattern === 'pattern_interrupt' && text.includes('Stop')) score += 5;
  if (pattern === 'contrarian') score += 5;

  const triggers = ['never', 'always', 'secret', 'truth', 'mistake', 'lie', 'nobody', 'everyone'];
  const triggerCount = triggers.filter(t => text.toLowerCase().includes(t)).length;
  score += triggerCount * 3;

  if (/\$[\d,]+/.test(text)) score += 8;
  if (/\d+/.test(text)) score += 4;

  return Math.max(0, Math.min(100, score));
}

function generateFingerprint(text, pattern) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  return crypto.createHash('sha256').update(`${pattern}:${normalized}`).digest('hex').slice(0, 16);
}

function estimateDuration(text) {
  const wordCount = text.split(/\s+/).length;
  return Math.round((wordCount / 2.2) * 10) / 10;
}

function selectPatterns(count, exclude = []) {
  const available = Object.entries(PATTERN_WEIGHTS)
    .filter(([p]) => !exclude.includes(p))
    .map(([pattern, weight]) => ({ pattern, weight }));

  const selected = [];
  const pool = [...available];

  for (let i = 0; i < count && pool.length > 0; i++) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    for (let j = 0; j < pool.length; j++) {
      random -= pool[j].weight;
      if (random <= 0) {
        selected.push(pool[j].pattern);
        pool.splice(j, 1);
        break;
      }
    }
  }
  return selected;
}

async function generateHooks(request) {
  const startTime = Date.now();
  const language = request.voiceLanguage || 'english';
  log.info('Starting hook generation', { topic: request.topic, variants: request.variantCount, language });

  const patterns = selectPatterns(request.variantCount, request.excludePatterns || []);
  const hooks = [];

  for (const pattern of patterns) {
    try {
      let hookText;
      if (language === 'hinglish' || language === 'hindi') {
        const hinglishPool = HINGLISH_HOOKS[pattern] || HINGLISH_HOOKS.curiosity_gap;
        hookText = hinglishPool[Math.floor(Math.random() * hinglishPool.length)];
      } else {
        const mockHooks = getMockHooks(pattern, 1);
        hookText = mockHooks[0] || `${request.topic} — this changes everything.`;
      }
      const strengthScore = scoreHook(hookText, pattern);

      if (strengthScore < HOOK_CONFIG.minStrengthScore) {
        log.warn('Hook below threshold, discarding', { pattern, score: strengthScore });
        continue;
      }

      hooks.push({
        id: crypto.randomUUID(),
        text: hookText,
        pattern,
        estimatedDurationSeconds: estimateDuration(hookText),
        strengthScore,
        topic: request.topic,
        fingerprint: generateFingerprint(hookText, pattern),
      });

      log.info('Hook generated', { pattern, score: strengthScore });
    } catch (err) {
      log.error('Hook generation failed', { pattern, error: err.message });
    }
  }

  if (hooks.length === 0) {
    throw { stage: 'hook_generation', code: 'NO_HOOKS_GENERATED', message: 'All hooks failed or below threshold', retryable: true };
  }

  hooks.sort((a, b) => b.strengthScore - a.strengthScore);

  log.info('Hook generation complete', { count: hooks.length, bestScore: hooks[0].strengthScore, timeMs: Date.now() - startTime });

  return { hooks, generationTimeMs: Date.now() - startTime, tokensUsed: 0, provider: 'mock' };
}

function selectBestHook(hooks) {
  return [...hooks].sort((a, b) => b.strengthScore - a.strengthScore)[0];
}

module.exports = { generateHooks, selectBestHook };
