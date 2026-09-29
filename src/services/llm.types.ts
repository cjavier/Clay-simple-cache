/**
 * Provider-neutral shapes for the LLM layer. Callers (copy, explore, MCP) only
 * speak these; each provider adapter (openai.service.ts, deepseek.service.ts)
 * translates them to and from its own wire format.
 *
 * The shape follows the OpenAI chat-completions convention because it's the
 * lingua franca most providers accept, but nothing here is provider-specific.
 */

export type LlmProviderName = "openai" | "deepseek";

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  /**
   * The model's reasoning (chain of thought or a summary of it), for logging
   * only. Adapters never send it back to the API.
   */
  reasoning?: string;
  /**
   * Opaque provider payload an adapter needs to replay this assistant turn
   * faithfully (e.g. OpenAI's encrypted reasoning items). Keep it on the
   * message when appending to history; only the adapter that produced it reads it.
   */
  provider_state?: unknown;
}

export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type LlmToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Prompt tokens billed at the (cheaper) context-cache-hit rate. */
  prompt_cache_hit_tokens: number;
  /** Prompt tokens billed at the standard cache-miss rate. */
  prompt_cache_miss_tokens: number;
  /** Computed from the active provider's pricing table; `null` if `model` isn't in it. */
  cost_usd: number | null;
}

export interface ChatCompletionParams {
  messages: LlmMessage[];
  model?: string;
  /** Ignored (with a warning) by models that only support their default sampling. */
  temperature?: number;
  max_tokens?: number;
  tools?: LlmTool[];
  tool_choice?: LlmToolChoice;
  /** true = think before answering, false = answer directly, undefined = provider default. */
  reasoning?: boolean;
  /** Guarantees syntactically valid JSON output; it does not enforce a specific shape. */
  json?: boolean;
}

export interface ChatCompletionResult {
  message: LlmMessage;
  /** "stop" | "tool_calls" | "length" | provider-specific reason. */
  finish_reason: string;
  usage: LlmUsage;
  /** Parameters the model couldn't honour and the adapter dropped. */
  warnings?: string[];
}

export interface LlmProvider {
  name: LlmProviderName;
  label: string;
  defaultModel(): string;
  chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

/** Thrown when the active provider's API key is missing from the environment. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Thrown for any HTTP/network failure talking to the active provider. */
export class LlmApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "LlmApiError";
  }
}

export function emptyUsage(): LlmUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    cost_usd: 0,
  };
}
