import { Request, Response } from "express";
import {
  chatCompletion,
  DEFAULT_MODEL,
  DeepSeekApiError,
  DeepSeekConfigError,
  DeepSeekMessage,
} from "../services/deepseek.service";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a direct-response B2B copywriter for an outbound sales/GTM agency. " +
  "Write clear, concrete, persuasive outreach copy (emails, LinkedIn messages, ad copy, etc). " +
  "Respond only with the requested copy — no preambles, no meta-commentary, no explanations.";

export const copyController = {
  async generate(req: Request, res: Response): Promise<void> {
    const start = Date.now();
    try {
      const { prompt, system, model, temperature, max_tokens } = req.body || {};

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const usedModel = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL;

      const messages: DeepSeekMessage[] = [
        {
          role: "system",
          content: typeof system === "string" && system.trim() ? system : DEFAULT_SYSTEM_PROMPT,
        },
        { role: "user", content: prompt },
      ];

      const result = await chatCompletion({
        messages,
        model: usedModel,
        temperature: typeof temperature === "number" ? temperature : undefined,
        max_tokens: typeof max_tokens === "number" ? max_tokens : undefined,
      });

      res.json({
        response: result.choice.message.content ?? "",
        model: usedModel,
        usage: result.usage,
        duration_ms: Date.now() - start,
      });
    } catch (error: any) {
      if (error instanceof DeepSeekConfigError) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error instanceof DeepSeekApiError) {
        res.status(502).json({ error: error.message });
        return;
      }
      console.error("Copy Generate Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
