// ============================================================
// MODULE: infra/aiClient.ts
// PURPOSE: Centralized AI client — Claude or Groq (free)
// PHASE: 2
// STATUS: ACTIVE
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { AI_CONFIG, SYSTEM_CONFIG } from '../config';
import { createLogger } from './logger';

const log = createLogger('AiClient');

let _claude: Anthropic | null = null;
let _groq: Groq | null = null;

function getClaudeClient(): Anthropic {
  if (!_claude) {
    const key = AI_CONFIG.claude.apiKey;
    if (!key || key === 'mock-key') throw new Error('CLAUDE_API_KEY not set');
    _claude = new Anthropic({ apiKey: key });
  }
  return _claude;
}

function getGroqClient(): Groq {
  if (!_groq) {
    const key = process.env.GROQ_API_KEY ?? '';
    if (!key) throw new Error('GROQ_API_KEY not set');
    _groq = new Groq({ apiKey: key });
  }
  return _groq;
}

export interface AiRequest {
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiResponse {
  content: string;
  tokensUsed: number;
  model: string;
  latencyMs: number;
}

// ─── GROQ CALL ───────────────────────────────────────────────

async function callGroq(req: AiRequest): Promise<AiResponse> {
  const start = Date.now();
  const client = getGroqClient();

  log.info('Groq API call', { promptLen: req.prompt.length, maxTokens: req.maxTokens });

  const completion = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature ?? 0.8,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.prompt },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim() ?? '';
  const tokensUsed = (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0);
  const latencyMs = Date.now() - start;

  log.info('Groq response received', { tokensUsed, latencyMs, contentLen: content.length });

  return { content, tokensUsed, model: completion.model, latencyMs };
}

// ─── CLAUDE CALL ─────────────────────────────────────────────

async function callClaude(req: AiRequest): Promise<AiResponse> {
  const start = Date.now();
  const client = getClaudeClient();

  log.info('Claude API call', { promptLen: req.prompt.length, maxTokens: req.maxTokens });

  const message = await client.messages.create({
    model: AI_CONFIG.claude.model,
    max_tokens: req.maxTokens ?? AI_CONFIG.claude.maxTokens,
    temperature: req.temperature ?? AI_CONFIG.claude.temperature,
    system: req.systemPrompt,
    messages: [{ role: 'user', content: req.prompt }],
  });

  const content = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();

  const tokensUsed = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);
  const latencyMs = Date.now() - start;

  log.info('Claude response received', { tokensUsed, latencyMs, contentLen: content.length });

  return { content, tokensUsed, model: message.model, latencyMs };
}

// ─── SAFE WRAPPER — tries Groq first (free), then Claude, then mock ──

export async function callClaudeWithFallback(
  req: AiRequest,
  fallback: () => string
): Promise<AiResponse> {
  if (SYSTEM_CONFIG.useMocks) {
    return { content: fallback(), tokensUsed: 0, model: 'mock', latencyMs: 0 };
  }

  // Try Groq first (free tier)
  if (process.env.GROQ_API_KEY) {
    try {
      return await callGroq(req);
    } catch (err) {
      log.warn('Groq failed — trying Claude', { error: (err as Error).message });
    }
  }

  // Try Claude
  try {
    return await callClaude(req);
  } catch (err) {
    log.error('Claude API failed — using fallback', { error: (err as Error).message });
    return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
  }
}
