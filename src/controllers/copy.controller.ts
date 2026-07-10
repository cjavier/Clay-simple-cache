import { Request, Response } from "express";
import { generateCopy } from "../services/copy.service";
import { DeepSeekApiError, DeepSeekConfigError } from "../services/deepseek.service";

export { DEFAULT_SYSTEM_PROMPT } from "../services/copy.service";

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const copyController = {
  async generate(req: Request, res: Response): Promise<void> {
    const start = Date.now();
    try {
      const { prompt, system, model, temperature, max_tokens, response_schema } = req.body || {};

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      if (response_schema !== undefined && !isPlainObject(response_schema)) {
        res.status(400).json({ error: "response_schema must be a JSON object" });
        return;
      }

      const result = await generateCopy({
        prompt,
        system: typeof system === "string" ? system : undefined,
        model: typeof model === "string" ? model : undefined,
        temperature: typeof temperature === "number" ? temperature : undefined,
        max_tokens: typeof max_tokens === "number" ? max_tokens : undefined,
        response_schema,
      });

      res.json({
        ...result,
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
