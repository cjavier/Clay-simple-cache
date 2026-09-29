/**
 * DeepSeek adapter for the LLM layer — chat completions API (OpenAI-compatible).
 * Docs: https://api-docs.deepseek.com
 *
 * Selected with LLM_PROVIDER=deepseek. Callers use llm.service.ts, not this file.
 */

import {
  ChatCompletionParams,
  ChatCompletionResult,
  LlmApiError,
  LlmConfigError,
  LlmMessage,
  LlmProvider,
} from "./llm.types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
// "deepseek-chat"/"deepseek-reasoner" aliases are deprecated 2026-07-24;
// deepseek-v4-flash is the same model the aliases resolved to.
const FALLBACK_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 120_000;

export interface DeepSeekModelPricing {
  /** USD per 1,000,000 input tokens that hit the context cache. */
  cache_hit_per_million: number;
  /** USD per 1,000,000 input tokens that miss the context cache. */
  cache_miss_per_million: number;
  /** USD per 1,000,000 output (completion) tokens. */
  output_per_million: number;
}

// Source: https://api-docs.deepseek.com/quick_start/pricing — re-check after
// pricing changes. deepseek-chat/deepseek-reasoner (deprecated 2026-07-24) are
// the non-thinking/thinking aliases of deepseek-v4-flash and billed the same.
export const DEEPSEEK_PRICING: Record<string, DeepSeekModelPricing> = {
  "deepseek-v4-flash": { cache_hit_per_million: 0.0028, cache_miss_per_million: 0.14, output_per_million: 0.28 },
  "deepseek-v4-pro": { cache_hit_per_million: 0.003625, cache_miss_per_million: 0.435, output_per_million: 0.87 },
  "deepseek-chat": { cache_hit_per_million: 0.0028, cache_miss_per_million: 0.14, output_per_million: 0.28 },
  "deepseek-reasoner": { cache_hit_per_million: 0.0028, cache_miss_per_million: 0.14, output_per_million: 0.28 },
};

/** Returns null when `model` has no entry in `DEEPSEEK_PRICING`. */
export function calculateCostUsd(
  model: string,
  cacheHitTokens: number,
  cacheMissTokens: number,
  completionTokens: number
): number | null {
  const pricing = DEEPSEEK_PRICING[model];
  if (!pricing) return null;
  const cost =
    (cacheHitTokens / 1_000_000) * pricing.cache_hit_per_million +
    (cacheMissTokens / 1_000_000) * pricing.cache_miss_per_million +
    (completionTokens / 1_000_000) * pricing.output_per_million;
  return Math.round(cost * 1e8) / 1e8;
}

// The API rejects reasoning_content when echoed back, and provider_state is
// ours — strip both before sending history.
function toWireMessage({ reasoning: _r, provider_state: _p, ...rest }: LlmMessage): Record<string, unknown> {
  return rest;
}

async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new LlmConfigError("DEEPSEEK_API_KEY is not configured");
  }

  const model = params.model || deepseekProvider.defaultModel();

  const body: Record<string, unknown> = {
    model,
    messages: params.messages.map(toWireMessage),
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
  if (params.tools) body.tools = params.tools;
  if (params.tool_choice) body.tool_choice = params.tool_choice;
  if (params.reasoning !== undefined) body.thinking = { type: params.reasoning ? "enabled" : "disabled" };
  if (params.json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new LlmApiError(504, `DeepSeek request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new LlmApiError(502, `DeepSeek request failed: ${error?.message || "network error"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody: any = await response.json();
      detail = errBody?.error?.message || errBody?.message || JSON.stringify(errBody);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new LlmApiError(
      response.status,
      `DeepSeek API error (${response.status}): ${detail || response.statusText}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (error: any) {
    throw new LlmApiError(502, "DeepSeek returned an invalid JSON response");
  }

  const rawChoice = data?.choices?.[0];
  if (!rawChoice) {
    throw new LlmApiError(502, "DeepSeek response contained no choices");
  }

  const promptTokens = data?.usage?.prompt_tokens ?? 0;
  const completionTokens = data?.usage?.completion_tokens ?? 0;
  const promptCacheHitTokens = data?.usage?.prompt_cache_hit_tokens ?? 0;
  // Fall back to treating all prompt tokens as cache-miss (the conservative,
  // more expensive assumption) if DeepSeek doesn't return the cache breakdown.
  const promptCacheMissTokens = data?.usage?.prompt_cache_miss_tokens ?? promptTokens - promptCacheHitTokens;

  const { reasoning_content, ...rawMessage } = rawChoice.message ?? {};

  return {
    message: { ...rawMessage, reasoning: reasoning_content || undefined },
    finish_reason: rawChoice.finish_reason,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: data?.usage?.total_tokens ?? 0,
      prompt_cache_hit_tokens: promptCacheHitTokens,
      prompt_cache_miss_tokens: promptCacheMissTokens,
      cost_usd: calculateCostUsd(model, promptCacheHitTokens, promptCacheMissTokens, completionTokens),
    },
  };
}

export const deepseekProvider: LlmProvider = {
  name: "deepseek",
  label: "DeepSeek",
  defaultModel: () => process.env.DEEPSEEK_MODEL || FALLBACK_MODEL,
  chatCompletion,
};
