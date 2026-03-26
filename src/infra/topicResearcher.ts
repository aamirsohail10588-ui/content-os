// ============================================================
// MODULE: infra/topicResearcher.ts
// PURPOSE: Research topics using Google News RSS + Groq synthesis
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

// ─── GROQ SYNTHESIS ──────────────────────────────────────────

async function synthesizeResearch(headlines: string[], topic: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return '';

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
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 450,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: 'You are a research analyst. Provide specific, factual research for content creators. Be precise with numbers and names. No generic statements.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return '';
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    log.warn('Groq synthesis failed', { error: (err as Error).message });
    return '';
  }
}

// ─── INSIGHT EXTRACTION ──────────────────────────────────────

async function extractInsight(rawResearch: string, topic: string): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey || !rawResearch) return '';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 250,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are a viral content strategist for Indian short-form video.
Convert raw research into a content insight brief.

Output exactly 4 lines:
TENSION: [what is the conflict, contradiction, or surprising fact]
CURIOSITY_GAP: [what viewers don't know but will want to]
EMOTIONAL_HOOK: [fear / shock / curiosity / pride / outrage — pick one + why]
SCRIPT_ANGLE: [one sentence — the exact angle this video should take]

Be specific. Use real numbers from research. No generic statements.

STRICT CONTENT RULES — these override everything:
- NEVER suggest betting, gambling, or fantasy sports as the angle
- NEVER mention Dafabet, Dream11, or any betting platform
- NEVER use financial loss/gain from betting as emotional hook
- If research contains betting data, IGNORE it completely
- Focus ONLY on: team analysis, player performance, match predictions, fan emotions, cricket strategy`,
          },
          { role: 'user', content: `Research:\n${rawResearch}\n\nTopic: "${topic}"` },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) return '';
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const insight = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (insight) log.info('Insight extracted', { chars: insight.length });
    return insight;
  } catch (err) {
    log.warn('Insight extraction failed', { error: (err as Error).message });
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
