import { describe, it, expect, vi, afterEach } from "vitest";
import { exploreController } from "../../src/controllers/explore.controller";

vi.mock("../../src/email-finder/config", () => ({
  config: {
    emaillistverify_api_key: "test-key",
    debounce_api_key: "test-key",
    serper_api_key: "test-serper-key",
    max_permutations_to_try: 15,
    domain_cache_ttl: 604800,
    verification_cache_ttl: 2592000,
  },
}));

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

describe("exploreController.explore", () => {
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
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/prompt/i);
  });

  it("returns 400 when max_steps is not a positive number", async () => {
    const { req, res } = mockReqRes({ prompt: "research something", max_steps: -1 });
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/max_steps/i);
  });

  it("returns 400 when max_steps is not a number", async () => {
    const { req, res } = mockReqRes({ prompt: "research something", max_steps: "eight" });
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when model is not a string", async () => {
    const { req, res } = mockReqRes({ prompt: "research something", model: 123 });
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when DEEPSEEK_API_KEY is not configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const { req, res } = mockReqRes({ prompt: "research something" });
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(503);
  });

  it("returns the agent result on success", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { role: "assistant", content: "Direct answer, no tools needed." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
      })
    );

    const { req, res } = mockReqRes({ prompt: "What is 2+2?" });
    await exploreController.explore(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe("Direct answer, no tools needed.");
    expect(res.body.total_steps).toBe(0);
    expect(res.body.steps).toEqual([]);
    expect(res.body.usage.prompt_tokens).toBe(5);
    expect(res.body.usage.completion_tokens).toBe(5);
    expect(res.body.usage.total_tokens).toBe(10);
    expect(typeof res.body.usage.cost_usd).toBe("number");
    expect(typeof res.body.duration_ms).toBe("number");
  });

  it("returns 400 when response_schema is not a JSON object", async () => {
    const { req, res } = mockReqRes({ prompt: "research something", response_schema: "nope" });
    await exploreController.explore(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/response_schema/i);
  });

  it("returns message as a parsed JSON object when response_schema is requested", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: "assistant", content: "Direct answer, no tools needed." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { req, res } = mockReqRes({
      prompt: "What is 2+2?",
      response_schema: { answer: "string" },
    });
    await exploreController.explore(req, res);

    expect(res.statusCode).toBe(200);
    // Every DeepSeek call in this mock (including the extra structured-reformat call)
    // returns the same plain-text content, which isn't valid JSON, so the agent falls
    // back to its parse-failure shape instead of throwing.
    expect(res.body.message).toEqual({
      error: expect.stringContaining("valid JSON"),
      raw: "Direct answer, no tools needed.",
    });
  });
});
