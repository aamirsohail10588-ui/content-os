// ============================================================
// MODULE: infra/topicResearcher.ts
// PURPOSE: Research topics using Google News RSS + OpenRouter synthesis
//          for accurate, current, topic-specific script facts
// ============================================================

import { createLogger } from './logger';

const log = createLogger('TopicResearcher');

// ─── GOOGLE NEWS RSS ─────────────────────────────────────────

async function fetchNewsHeadlines(topic: string): Promise<string[]> {
  // Strip Hinglish/Hindi words — search in English keywords only
  const englishKeywords = topic
    .replace(/[^\x00-\x7F]/g, ' ')  // remove non-ASCII (Devanagari)
    .replace(/\b(se|ka|ki|ke|kyu|aur|ab|kya|ne|pe|mein|hai|hain|tha|the|karo|karna|wala|wali)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);

  const query = englishKeywords || topic.substring(0, 80);

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsReader/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) return [];

    const xml = await response.text();

    // Extract titles from RSS (CDATA and plain)
    const titles: string[] = [];
    const titleMatches = xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs);
    for (const m of titleMatches) {
      const t = m[1].replace(/<[^>]+>/g, '').trim();
      if (t && t.length > 10 && !t.includes('Google News')) titles.push(t);
    }

    // Extract descriptions
    const descs: string[] = [];
    const descMatches = xml.matchAll(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/gs);
    for (const m of descMatches) {
      const d = m[1].replace(/<[^>]+>/g, '').trim();
      if (d && d.length > 20) descs.push(d.substring(0, 120));
    }

    // Combine top headlines
    const headlines: string[] = [];
    for (let i = 0; i < Math.min(titles.length, 8); i++) {
      const desc = descs[i] ? ` — ${descs[i]}` : '';
      headlines.push(`${titles[i]}${desc}`);
    }

    log.info('News headlines fetched', { query: query.slice(0, 50), count: headlines.length });
    return headlines;
  } catch (err) {
    log.warn('News fetch failed', { error: (err as Error).message });
    return [];
  }
}

// ─── OPENROUTER SYNTHESIS ────────────────────────────────────

async function synthesizeResearch(headlines: string[], topic: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return '';

  const headlineText = headlines.length > 0
    ? `Recent news headlines:\n${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : `No recent headlines found. Use your training knowledge about: "${topic}"`;

  const prompt = `${headlineText}

Based on the above, provide SPECIFIC research for a viral short-form video about: "${topic}"

Give me:
1. The core event/fact (what exactly happened, when, specific numbers)
2. Key people/organizations involved (exact names, roles)
3. Specific numbers that will shock viewers (%, amounts, counts)
4. Simple cause — why did this happen? (1-2 sentences max)
5. Impact on regular people's lives/money/jobs

Be SPECIFIC. No vague language. Use exact figures from the headlines.
If headlines don't have specifics, use your training knowledge for known facts.`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://content-os.app',
        'X-Title': 'Content OS',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 450,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `You are a strict news research extractor for viral short-form video content.
You will receive recent news headlines about any topic.
Your ONLY job is to extract facts FROM THESE HEADLINES ONLY.

ABSOLUTE RULES:
- Use ONLY information present in the provided headlines
- NEVER use your own training knowledge or memory
- NEVER fill gaps with assumptions or general knowledge
- NEVER add context from before these headlines
- If headlines say X happened, report exactly X
- If headlines do not mention something, write: not confirmed in headlines
- All dates, names, numbers, events must come FROM the headlines only
- If headlines are insufficient, say so clearly

Output format (always use this structure):
CURRENT_STATUS: [what is happening RIGHT NOW according to headlines]
KEY_FACT_1: [most important specific fact from headlines — with exact number or name if available]
KEY_FACT_2: [second important fact from headlines]
KEY_FACT_3: [third fact — preferably something surprising or non-obvious]
UNIQUE_ANGLE: [the most interesting or unexpected thing found in these headlines]

This works for ANY topic: sports, politics, finance, technology, entertainment, health, etc.`,
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) return '';
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    log.warn('OpenRouter synthesis failed', { error: (err as Error).message });
    return '';
  }
}

// ─── INSIGHT EXTRACTION ──────────────────────────────────────

async function extractInsight(rawResearch: string, topic: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !rawResearch) return '';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://content-os.app',
        'X-Title': 'Content OS',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 250,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are a viral content strategist.
Work ONLY from the research text provided below.
Do NOT add any information from your training data or general knowledge.
Do NOT fill gaps with assumptions.

Convert the provided research into a content insight:

Output exactly 4 lines:
TENSION: [conflict or contradiction found IN THE RESEARCH]
CURIOSITY_GAP: [what viewers don't know but will want to, based on research]
EMOTIONAL_HOOK: [fear / shock / curiosity / pride / outrage — based on research facts]
SCRIPT_ANGLE: [one sentence — the exact angle this video should take, grounded in research]

If research lacks facts for any line, write: insufficient data`,
          },
          { role: 'user', content: `Research:\n${rawResearch}\n\nTopic: "${topic}"` },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) return '';
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const insight = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (insight) log.info('Insight extracted', { chars: insight.length });
    return insight;
  } catch (err) {
    log.warn('OpenRouter insight extraction failed', { error: (err as Error).message });
    return '';
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────

export async function researchTopic(topic: string, niche: string): Promise<string> {
  try {
    log.info('Starting topic research', { topic: topic.slice(0, 60) });
    const headlines = await fetchNewsHeadlines(topic);
    const rawResearch = await synthesizeResearch(headlines, topic);
    if (!rawResearch) {
      log.warn('Research returned empty', { topic: topic.slice(0, 50) });
      return '';
    }
    log.info('Raw research complete', { chars: rawResearch.length, headlines: headlines.length });
    const insight = await extractInsight(rawResearch, topic);
    const combined = insight
      ? `RESEARCH:\n${rawResearch}\n\nINSIGHT:\n${insight}`
      : `RESEARCH:\n${rawResearch}`;
    log.info('Research + insight ready', { totalChars: combined.length });
    return combined;
  } catch (err) {
    log.warn('researchTopic failed', { error: (err as Error).message });
    return '';
  }
}
