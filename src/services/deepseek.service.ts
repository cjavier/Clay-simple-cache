/**
 * Thin client for the DeepSeek chat completions API (OpenAI-compatible).
 * Docs: https://api-docs.deepseek.com
 */

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
// "deepseek-chat"/"deepseek-reasoner" aliases are deprecated 2026-07-24;
// deepseek-v4-flash is the same model the aliases resolved to.
export const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 120_000;

export type DeepSeekRole = "system" | "user" | "assistant" | "tool";

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  /** Chain-of-thought text returned when thinking mode is enabled. Never send it back to the API. */
  reasoning_content?: string;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface DeepSeekThinking {
  type: "enabled" | "disabled";
  reasoning_effort?: "high" | "max";
}

export interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type DeepSeekToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface DeepSeekChatChoice {
  message: DeepSeekMessage;
  finish_reason: string;
}

export interface DeepSeekChatCompletionResult {
  choice: DeepSeekChatChoice;
  usage: DeepSeekUsage;
}

export interface ChatCompletionParams {
  messages: DeepSeekMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: DeepSeekTool[];
  tool_choice?: DeepSeekToolChoice;
  thinking?: DeepSeekThinking;
}

/** Thrown when DEEPSEEK_API_KEY is missing from the environment. */
export class DeepSeekConfigError extends Error {
  constructor(message = "DEEPSEEK_API_KEY is not configured") {
    super(message);
    this.name = "DeepSeekConfigError";
  }
}

/** Thrown for any HTTP/network failure talking to the DeepSeek API. */
export class DeepSeekApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

export async function chatCompletion(
  params: ChatCompletionParams
): Promise<DeepSeekChatCompletionResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new DeepSeekConfigError();
  }

  const model = params.model || DEFAULT_MODEL;

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;
  if (params.tools) body.tools = params.tools;
  if (params.tool_choice) body.tool_choice = params.tool_choice;
  if (params.thinking) body.thinking = params.thinking;

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
      throw new DeepSeekApiError(
        504,
        `DeepSeek request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      );
    }
    throw new DeepSeekApiError(
      502,
      `DeepSeek request failed: ${error?.message || "network error"}`
    );
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
    throw new DeepSeekApiError(
      response.status,
      `DeepSeek API error (${response.status}): ${detail || response.statusText}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (error: any) {
    throw new DeepSeekApiError(502, "DeepSeek returned an invalid JSON response");
  }

  const rawChoice = data?.choices?.[0];
  if (!rawChoice) {
    throw new DeepSeekApiError(502, "DeepSeek response contained no choices");
  }

  return {
    choice: {
      message: rawChoice.message,
      finish_reason: rawChoice.finish_reason,
    },
    usage: {
      prompt_tokens: data?.usage?.prompt_tokens ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
      total_tokens: data?.usage?.total_tokens ?? 0,
    },
  };
}
