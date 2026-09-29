/**
 * OpenAI adapter for the LLM layer — Responses API.
 * Docs: https://developers.openai.com/api/docs/models/gpt-6-luna
 *
 * Selected with LLM_PROVIDER=openai (the default). Callers use llm.service.ts,
 * not this file.
 *
 * Why Responses and not chat completions: gpt-6-luna rejects function tools
 * combined with reasoning on /v1/chat/completions (verified against the live
 * API), and /explore needs both. Responses supports them together.
 */

import {
  ChatCompletionParams,
  ChatCompletionResult,
  LlmApiError,
  LlmConfigError,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
} from "./llm.types";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const FALLBACK_MODEL = "gpt-6-luna";
const REQUEST_TIMEOUT_MS = 120_000;

export interface OpenAIModelPricing {
  /** USD per 1,000,000 uncached input tokens. */
  input_per_million: number;
  /** USD per 1,000,000 input tokens read from the prompt cache. */
  cached_input_per_million: number;
  /** USD per 1,000,000 input tokens written to the prompt cache. */
  cache_write_per_million: number;
  /** USD per 1,000,000 output tokens (reasoning tokens included). */
  output_per_million: number;
}

// Source: https://developers.openai.com/api/docs/models/gpt-6-luna (checked
// 2026-09-29, after the 50% price cut) — re-check after pricing changes.
export const OPENAI_PRICING: Record<string, OpenAIModelPricing> = {
  "gpt-6-luna": {
    input_per_million: 0.1,
    cached_input_per_million: 0.01,
    cache_write_per_million: 0.125,
    output_per_million: 0.5,
  },
};

/** Returns null when `model` has no entry in `OPENAI_PRICING`. */
export function calculateOpenAICostUsd(
  model: string,
  inputTokens: number,
  cachedTokens: number,
  cacheWriteTokens: number,
  outputTokens: number
): number | null {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) return null;
  const uncached = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
  const cost =
    (uncached / 1_000_000) * pricing.input_per_million +
    (cachedTokens / 1_000_000) * pricing.cached_input_per_million +
    (cacheWriteTokens / 1_000_000) * pricing.cache_write_per_million +
    (outputTokens / 1_000_000) * pricing.output_per_million;
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * Reasoning models (o-series, gpt-5+, gpt-6+) take `reasoning.effort` and
 * reject custom sampling (`temperature`). Older models are the reverse.
 */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-[5-9])/.test(model);
}

function reasoningEffort(): string {
  return process.env.OPENAI_REASONING_EFFORT || "medium";
}

/** Converts neutral chat history into Responses API input items. */
function toInputItems(messages: LlmMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      // Replaying the raw output items keeps the encrypted reasoning attached
      // to the tool calls it produced, which the model uses on the next turn.
      if (Array.isArray(m.provider_state)) {
        items.push(...m.provider_state);
        continue;
      }
      if (m.content) items.push({ role: "assistant", content: m.content });
      for (const call of m.tool_calls ?? []) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    items.push({ role: m.role, content: m.content ?? "" });
  }
  return items;
}

async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new LlmConfigError("OPENAI_API_KEY is not configured");
  }

  const model = params.model || openaiProvider.defaultModel();
  const reasoningModel = isReasoningModel(model);
  const warnings: string[] = [];

  const body: Record<string, unknown> = {
    model,
    input: toInputItems(params.messages),
    // Stateless: we resend history ourselves, so nothing needs to live on
    // OpenAI's side. Encrypted reasoning lets that history keep its reasoning.
    store: false,
  };

  if (params.temperature !== undefined) {
    if (reasoningModel) {
      warnings.push(`temperature is not supported by ${model} and was ignored.`);
    } else {
      body.temperature = params.temperature;
    }
  }
  // Reasoning tokens count against this budget, so small values can leave no
  // room for visible output (surfaced as finish_reason "length").
  if (params.max_tokens !== undefined) body.max_output_tokens = params.max_tokens;
  if (params.tools) {
    body.tools = params.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: false,
    }));
  }
  if (params.tool_choice) {
    body.tool_choice =
      typeof params.tool_choice === "string"
        ? params.tool_choice
        : { type: "function", name: params.tool_choice.function.name };
  }
  if (reasoningModel) {
    body.include = ["reasoning.encrypted_content"];
    if (params.reasoning === true) body.reasoning = { effort: reasoningEffort(), summary: "auto" };
    if (params.reasoning === false) body.reasoning = { effort: "none" };
  }
  if (params.json) body.text = { format: { type: "json_object" } };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${OPENAI_BASE_URL}/responses`, {
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
      throw new LlmApiError(504, `OpenAI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new LlmApiError(502, `OpenAI request failed: ${error?.message || "network error"}`);
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
      `OpenAI API error (${response.status}): ${detail || response.statusText}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new LlmApiError(502, "OpenAI returned an invalid JSON response");
  }

  const output: any[] = Array.isArray(data?.output) ? data.output : [];
  if (data?.status === "failed" || (output.length === 0 && data?.status !== "incomplete")) {
    throw new LlmApiError(502, `OpenAI response contained no output${data?.error?.message ? `: ${data.error.message}` : ""}`);
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const item of output) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && part.text) textParts.push(part.text);
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "" },
      });
    } else if (item?.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (s?.text) reasoningParts.push(s.text);
      }
    }
  }

  let finishReason = "stop";
  if (toolCalls.length > 0) finishReason = "tool_calls";
  else if (data?.status === "incomplete") {
    const reason = data?.incomplete_details?.reason;
    finishReason = reason === "max_output_tokens" ? "length" : reason || "incomplete";
  }

  const inputTokens = data?.usage?.input_tokens ?? 0;
  const outputTokens = data?.usage?.output_tokens ?? 0;
  const cachedTokens = data?.usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = data?.usage?.input_tokens_details?.cache_write_tokens ?? 0;

  return {
    message: {
      role: "assistant",
      content: textParts.length ? textParts.join("") : null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      reasoning: reasoningParts.length ? reasoningParts.join("\n\n") : undefined,
      provider_state: output,
    },
    finish_reason: finishReason,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: data?.usage?.total_tokens ?? inputTokens + outputTokens,
      prompt_cache_hit_tokens: cachedTokens,
      prompt_cache_miss_tokens: Math.max(0, inputTokens - cachedTokens),
      cost_usd: calculateOpenAICostUsd(model, inputTokens, cachedTokens, cacheWriteTokens, outputTokens),
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

export const openaiProvider: LlmProvider = {
  name: "openai",
  label: "OpenAI",
  defaultModel: () => process.env.OPENAI_MODEL || FALLBACK_MODEL,
  chatCompletion,
};
