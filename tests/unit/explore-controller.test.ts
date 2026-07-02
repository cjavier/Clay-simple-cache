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
    expect(res.body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    expect(typeof res.body.duration_ms).toBe("number");
  });
});
