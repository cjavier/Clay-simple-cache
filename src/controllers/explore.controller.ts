import { Request, Response } from "express";
import { runExploreAgent } from "../services/explore-agent.service";
import { DeepSeekApiError, DeepSeekConfigError } from "../services/deepseek.service";

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const exploreController = {
  async explore(req: Request, res: Response): Promise<void> {
    try {
      const { prompt, max_steps, model, reasoning, response_schema } = req.body || {};

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      if (max_steps !== undefined && (typeof max_steps !== "number" || !Number.isFinite(max_steps) || max_steps <= 0)) {
        res.status(400).json({ error: "max_steps must be a positive number" });
        return;
      }

      if (model !== undefined && typeof model !== "string") {
        res.status(400).json({ error: "model must be a string" });
        return;
      }

      if (reasoning !== undefined && typeof reasoning !== "boolean") {
        res.status(400).json({ error: "reasoning must be a boolean" });
        return;
      }

      if (response_schema !== undefined && !isPlainObject(response_schema)) {
        res.status(400).json({ error: "response_schema must be a JSON object" });
        return;
      }

      const result = await runExploreAgent({ prompt, max_steps, model, reasoning, response_schema });

      res.json(result);
    } catch (error: any) {
      if (error instanceof DeepSeekConfigError) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error instanceof DeepSeekApiError) {
        res.status(502).json({ error: error.message });
        return;
      }
      console.error("Explore Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
