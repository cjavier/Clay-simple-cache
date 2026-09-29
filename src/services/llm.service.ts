/**
 * Single entry point for every AI call in the service (/copy, /explore, MCP).
 *
 * The provider is chosen by one env var, read on every call:
 *   LLM_PROVIDER=openai   (default) — gpt-6-luna via the Responses API
 *   LLM_PROVIDER=deepseek           — deepseek-v4-flash via chat completions
 *
 * Each provider has its own key (OPENAI_API_KEY / DEEPSEEK_API_KEY) and
 * optional model override (OPENAI_MODEL / DEEPSEEK_MODEL).
 */

import { deepseekProvider } from "./deepseek.service";
import { openaiProvider } from "./openai.service";
import {
  ChatCompletionParams,
  ChatCompletionResult,
  LlmConfigError,
  LlmProvider,
  LlmProviderName,
} from "./llm.types";

export * from "./llm.types";

const PROVIDERS: Record<LlmProviderName, LlmProvider> = {
  openai: openaiProvider,
  deepseek: deepseekProvider,
};

export const DEFAULT_PROVIDER: LlmProviderName = "openai";

export function activeProvider(): LlmProvider {
  const name = (process.env.LLM_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  const provider = PROVIDERS[name as LlmProviderName];
  if (!provider) {
    throw new LlmConfigError(
      `Unknown LLM_PROVIDER "${process.env.LLM_PROVIDER}". Expected one of: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return provider;
}

/** The model used when a request doesn't name one, for the active provider. */
export function defaultModel(): string {
  return activeProvider().defaultModel();
}

export function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  return activeProvider().chatCompletion(params);
}
