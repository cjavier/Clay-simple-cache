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
    expect(res.body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    expect(typeof res.body.duration_ms).toBe("number");
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
