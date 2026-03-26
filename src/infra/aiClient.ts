// ============================================================
// MODULE: infra/aiClient.ts
// PURPOSE: Centralized AI client — Groq primary, OpenRouter fallback
// ============================================================

import Groq from 'groq-sdk';
import { SYSTEM_CONFIG } from '../config';
import { createLogger } from './logger';

const log = createLogger('AiClient');

// ─── GROQ CLIENT ─────────────────────────────────────────────

function getGroqClient(): Groq | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return new Groq({ apiKey });
}

async function callGroq(req: AiRequest): Promise<AiResponse> {
  const client = getGroqClient();
  if (!client) throw new Error('GROQ_API_KEY not set');

  const start = Date.now();
  const model = 'llama-3.3-70b-versatile';
  log.info('Groq API call', { model, promptLen: req.prompt.length, maxTokens: req.maxTokens });

  const completion = await client.chat.completions.create({
    model,
    max_tokens: req.maxTokens ?? 1200,
    temperature: req.temperature ?? 0.8,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.prompt },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim() ?? '';
  const tokensUsed = (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0);
  const latencyMs = Date.now() - start;

  log.info('Groq response received', { model, tokensUsed, latencyMs, contentLen: content.length });
  return { content, tokensUsed, model, latencyMs };
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

// ─── OPENROUTER CALL ─────────────────────────────────────────

async function callOpenRouter(req: AiRequest, model: string): Promise<AiResponse> {
  const start = Date.now();
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  log.info('OpenRouter API call', { model, promptLen: req.prompt.length, maxTokens: req.maxTokens });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://content-os.app',
      'X-Title': 'Content OS',
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1200,
      temperature: req.temperature ?? 0.8,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  const content = data.choices?.[0]?.message?.content?.trim() ?? '';
  const tokensUsed = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  const latencyMs = Date.now() - start;
  const usedModel = data.model ?? model;

  log.info('OpenRouter response received', { model: usedModel, tokensUsed, latencyMs, contentLen: content.length });

  return { content, tokensUsed, model: usedModel, latencyMs };
}

// ─── CLAUDE-ONLY CALL — Groq primary → OpenRouter claude-sonnet-4-5 → fallback() ──

export async function callClaudeDirectly(
  req: AiRequest,
  fallback: () => string
): Promise<AiResponse> {
  if (SYSTEM_CONFIG.useMocks) {
    return { content: fallback(), tokensUsed: 0, model: 'mock', latencyMs: 0 };
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const result = await callGroq(req);
      log.info('callClaudeDirectly: used Groq llama-3.3-70b-versatile');
      return result;
    } catch (err) {
      log.warn('Groq failed — trying OpenRouter claude-sonnet-4-5', { error: (err as Error).message });
    }
  }
  try {
    const result = await callOpenRouter(req, 'anthropic/claude-sonnet-4-5');
    log.info('callClaudeDirectly: used OpenRouter claude-sonnet-4-5');
    return result;
  } catch (err) {
    log.error('claude-sonnet-4-5 failed — using fallback', { error: (err as Error).message });
    return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
  }
}

// ─── SAFE WRAPPER — Groq primary → fallback() ────────────────

export async function callClaudeWithFallback(
  req: AiRequest,
  fallback: () => string
): Promise<AiResponse> {
  if (SYSTEM_CONFIG.useMocks) {
    return { content: fallback(), tokensUsed: 0, model: 'mock', latencyMs: 0 };
  }

  try {
    const result = await callGroq(req);
    log.info('callClaudeWithFallback: used Groq llama-3.3-70b-versatile');
    return result;
  } catch (err) {
    log.error('Groq failed — using mock fallback', { error: (err as Error).message });
    return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
  }
}
