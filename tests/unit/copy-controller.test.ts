import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyController } from "../../src/controllers/copy.controller";

function mockReqRes(body: any) {
  const req: any = { body };
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return { req, res };
}

describe("copyController.generate", () => {
  const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_KEY !== undefined) {
      process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("returns 400 when prompt is missing", async () => {
    const { req, res } = mockReqRes({});
    await copyController.generate(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/prompt/i);
  });

  it("returns 400 when prompt is an empty string", async () => {
    const { req, res } = mockReqRes({ prompt: "   " });
    await copyController.generate(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when DEEPSEEK_API_KEY is not configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const { req, res } = mockReqRes({ prompt: "Write a cold email" });
    await copyController.generate(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/DEEPSEEK_API_KEY/);
  });

  it("returns generated copy with usage and duration on success", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [
              { message: { role: "assistant", content: "Hi {{firstName}}, quick question..." }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          }),
      })
    );

    const { req, res } = mockReqRes({ prompt: "Write a cold outreach opener" });
    await copyController.generate(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.response).toBe("Hi {{firstName}}, quick question...");
    expect(res.body.model).toBe("deepseek-v4-flash");
    expect(res.body.usage.prompt_tokens).toBe(12);
    expect(res.body.usage.completion_tokens).toBe(8);
    expect(res.body.usage.total_tokens).toBe(20);
    expect(typeof res.body.usage.cost_usd).toBe("number");
    expect(typeof res.body.duration_ms).toBe("number");
  });

  it("returns response_schema as a parsed JSON object when requested", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ description: "A GTM agency", top_problems: ["a", "b", "c"] }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { req, res } = mockReqRes({
      prompt: "Describe the client's service and their top 3 problems",
      response_schema: { description: "string", top_problems: ["string", "string", "string"] },
    });
    await copyController.generate(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.response).toEqual({ description: "A GTM agency", top_problems: ["a", "b", "c"] });
    expect(res.body.warning).toBeUndefined();

    const [, options] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.response_format).toEqual({ type: "json_object" });
  });

  it("falls back to the raw string with a warning when the model returns invalid JSON", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { role: "assistant", content: "not json" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
      })
    );

    const { req, res } = mockReqRes({
      prompt: "Describe the client's service",
      response_schema: { description: "string" },
    });
    await copyController.generate(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.response).toBe("not json");
    expect(res.body.warning).toMatch(/valid JSON/i);
  });

  it("returns 400 when response_schema is not a JSON object", async () => {
    const { req, res } = mockReqRes({ prompt: "Write something", response_schema: "not an object" });
    await copyController.generate(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/response_schema/i);
  });

  it("uses the default B2B copywriting system prompt when none is provided", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content: "copy" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { req, res } = mockReqRes({ prompt: "Write something" });
    await copyController.generate(req, res);

    const [, options] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.messages[0].role).toBe("system");
    expect(parsedBody.messages[0].content.length).toBeGreaterThan(0);
    expect(parsedBody.messages[1]).toEqual({ role: "user", content: "Write something" });
  });

  it("respects a custom system prompt and model when provided", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content: "copy" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { req, res } = mockReqRes({
      prompt: "Write something",
      system: "Custom system prompt",
      model: "deepseek-reasoner",
    });
    await copyController.generate(req, res);

    const [, options] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.messages[0].content).toBe("Custom system prompt");
    expect(parsedBody.model).toBe("deepseek-reasoner");
    expect(res.body.model).toBe("deepseek-reasoner");
  });
});
