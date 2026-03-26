// ============================================================
// MODULE: infra/aiClient.ts
// PURPOSE: Centralized AI client via OpenRouter
// ============================================================

import { SYSTEM_CONFIG } from '../config';
import { createLogger } from './logger';

const log = createLogger('AiClient');

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

// ─── CLAUDE-ONLY CALL — Claude sonnet, falls back to Gemini then fallback() ──

export async function callClaudeDirectly(
  req: AiRequest,
  fallback: () => string
): Promise<AiResponse> {
  if (SYSTEM_CONFIG.useMocks) {
    return { content: fallback(), tokensUsed: 0, model: 'mock', latencyMs: 0 };
  }
  try {
    const result = await callOpenRouter(req, 'anthropic/claude-sonnet-4-5');
    log.info('callClaudeDirectly: used claude-sonnet-4-5');
    return result;
  } catch (err) {
    log.warn('claude-sonnet-4-5 failed — trying gemini-flash-1.5', { error: (err as Error).message });
    try {
      const result = await callOpenRouter(req, 'google/gemini-flash-1.5');
      log.info('callClaudeDirectly: fell back to gemini-flash-1.5');
      return result;
    } catch (err2) {
      log.error('Claude direct call failed — using fallback', { error: (err2 as Error).message });
      return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
    }
  }
}

// ─── SAFE WRAPPER — primary: llama-3.3-70b (free), 429 retry, then fallback() ──

export async function callClaudeWithFallback(
  req: AiRequest,
  fallback: () => string
): Promise<AiResponse> {
  if (SYSTEM_CONFIG.useMocks) {
    return { content: fallback(), tokensUsed: 0, model: 'mock', latencyMs: 0 };
  }

  const is429 = (err: Error) => err.message.includes('429') || err.message.includes('rate-limit');

  try {
    const result = await callOpenRouter(req, 'meta-llama/llama-3.3-70b-instruct:free');
    log.info('callClaudeWithFallback: used llama-3.3-70b-instruct:free');
    return result;
  } catch (err) {
    if (is429(err as Error)) {
      log.warn('Rate limited (429) — waiting 2s then retrying', { error: (err as Error).message });
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const retryResult = await callOpenRouter(req, 'meta-llama/llama-3.3-70b-instruct:free');
        log.info('callClaudeWithFallback: retry succeeded');
        return retryResult;
      } catch (retryErr) {
        log.error('Retry failed — using fallback', { error: (retryErr as Error).message });
        return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
      }
    }
    log.error('OpenRouter call failed — using fallback', { error: (err as Error).message });
    return { content: fallback(), tokensUsed: 0, model: 'fallback', latencyMs: 0 };
  }
}
