import { chatCompletion, DEFAULT_MODEL, DeepSeekMessage, DeepSeekUsage } from "./deepseek.service";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a direct-response B2B copywriter for an outbound sales/GTM agency. " +
  "Write clear, concrete, persuasive outreach copy (emails, LinkedIn messages, ad copy, etc). " +
  "Respond only with the requested copy — no preambles, no meta-commentary, no explanations.";

export interface GenerateCopyParams {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /**
   * A JSON structure/shape describing the desired output (either a literal example
   * object or a JSON-Schema-like object). When set, the model is instructed to reply
   * with only a JSON object matching it and `response` is the parsed object instead
   * of a string. Best-effort: DeepSeek guarantees valid JSON syntax, not schema
   * conformance — malformed output falls back to the raw string plus a `warning`.
   */
  response_schema?: unknown;
}

export interface GenerateCopyResult {
  response: string | unknown;
  model: string;
  usage: DeepSeekUsage;
  warning?: string;
}

export async function generateCopy(params: GenerateCopyParams): Promise<GenerateCopyResult> {
  const usedModel = params.model?.trim() ? params.model.trim() : DEFAULT_MODEL;

  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content: params.system?.trim() ? params.system : DEFAULT_SYSTEM_PROMPT,
    },
    { role: "user", content: params.prompt },
  ];

  const wantsStructured = params.response_schema !== undefined;
  if (wantsStructured) {
    messages.push({
      role: "user",
      content:
        "Respond with ONLY a single JSON object matching this structure (field names/shape as a guide, " +
        "not literal values):\n" +
        JSON.stringify(params.response_schema) +
        "\nNo explanations, no markdown code fences.",
    });
  }

  const result = await chatCompletion({
    messages,
    model: usedModel,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    response_format: wantsStructured ? { type: "json_object" } : undefined,
  });

  const rawContent = result.choice.message.content ?? "";

  if (wantsStructured) {
    try {
      return { response: JSON.parse(rawContent), model: usedModel, usage: result.usage };
    } catch {
      return {
        response: rawContent,
        model: usedModel,
        usage: result.usage,
        warning: "DeepSeek did not return valid JSON; returning raw text in `response`.",
      };
    }
  }

  return { response: rawContent, model: usedModel, usage: result.usage };
}
