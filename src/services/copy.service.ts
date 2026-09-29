import { chatCompletion, defaultModel, LlmMessage, LlmUsage } from "./llm.service";

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
   * of a string. Best-effort: the model guarantees valid JSON syntax, not schema
   * conformance — malformed output falls back to the raw string plus a `warning`.
   */
  response_schema?: unknown;
}

export interface GenerateCopyResult {
  response: string | unknown;
  model: string;
  usage: LlmUsage;
  warning?: string;
}

export async function generateCopy(params: GenerateCopyParams): Promise<GenerateCopyResult> {
  const usedModel = params.model?.trim() ? params.model.trim() : defaultModel();

  const messages: LlmMessage[] = [
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
    json: wantsStructured,
  });

  const rawContent = result.message.content ?? "";
  const paramWarning = result.warnings?.join(" ");

  if (wantsStructured) {
    try {
      return withWarning({ response: JSON.parse(rawContent), model: usedModel, usage: result.usage }, paramWarning);
    } catch {
      return withWarning(
        { response: rawContent, model: usedModel, usage: result.usage },
        "The model did not return valid JSON; returning raw text in `response`.",
        paramWarning
      );
    }
  }

  return withWarning({ response: rawContent, model: usedModel, usage: result.usage }, paramWarning);
}

function withWarning(result: GenerateCopyResult, ...warnings: (string | undefined)[]): GenerateCopyResult {
  const warning = warnings.filter(Boolean).join(" ");
  return warning ? { ...result, warning } : result;
}
