import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { calculateCostUsd, deepseekProvider } from "../../src/services/deepseek.service";
import { LlmApiError, LlmConfigError } from "../../src/services/llm.types";

const chatCompletion = deepseekProvider.chatCompletion;

function mockFetchOnce(body: any, status = 200, ok = status >= 200 && status < 300) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: "status text",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("deepseek.service chatCompletion", () => {
  const ORIGINAL_KEY = process.env.DEEPSEEK_API_KEY;

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_KEY !== undefined) {
      process.env.DEEPSEEK_API_KEY = ORIGINAL_KEY;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("throws LlmConfigError when DEEPSEEK_API_KEY is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmConfigError);
  });

  it("parses choice and usage from a successful response", async () => {
    const fetchMock = mockFetchOnce({
      choices: [
        {
          message: { role: "assistant", content: "Hello there" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(result.message.content).toBe("Hello there");
    expect(result.finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
    // No cache breakdown in the mocked response -> all prompt tokens counted as cache-miss.
    expect(result.usage.prompt_cache_hit_tokens).toBe(0);
    expect(result.usage.prompt_cache_miss_tokens).toBe(10);
    expect(result.usage.cost_usd).toBeCloseTo(0.0000028, 10);

    // Verify request shape: correct URL, auth header, default model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer test-deepseek-key");
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.model).toBe("deepseek-v4-flash");
  });

  it("maps reasoning_content to reasoning and never echoes it back", async () => {
    const fetchMock = mockFetchOnce({
      choices: [
        { message: { role: "assistant", content: "ok", reasoning_content: "thinking..." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "earlier", reasoning: "old thoughts", provider_state: { x: 1 } },
      ],
      reasoning: true,
    });

    expect(result.message.reasoning).toBe("thinking...");
    const parsedBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(parsedBody.thinking).toEqual({ type: "enabled" });
    expect(parsedBody.messages[1]).toEqual({ role: "assistant", content: "earlier" });
  });

  it("passes through a custom model and tool definitions", async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      model: "deepseek-reasoner",
      tools: [
        {
          type: "function",
          function: { name: "noop", description: "does nothing", parameters: { type: "object", properties: {} } },
        },
      ],
      tool_choice: "auto",
    });

    const [, options] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.model).toBe("deepseek-reasoner");
    expect(parsedBody.tools).toHaveLength(1);
    expect(parsedBody.tool_choice).toBe("auto");
  });

  it("throws LlmApiError with details on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ error: { message: "invalid api key" } }, 401, false)
    );

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({
      name: "LlmApiError",
      status: 401,
    });
  });

  it("throws LlmApiError on timeout (AbortError)", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({
      name: "LlmApiError",
      status: 504,
    });
  });

  it("throws LlmApiError when response has no choices", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ choices: [] }));

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmApiError);
  });

  it("uses the real prompt_cache_hit/miss breakdown when DeepSeek returns it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      })
    );

    const result = await chatCompletion({ messages: [{ role: "user", content: "hi" }] });

    expect(result.usage.prompt_cache_hit_tokens).toBe(80);
    expect(result.usage.prompt_cache_miss_tokens).toBe(20);
    // 80 * 0.0028/1e6 + 20 * 0.14/1e6 + 10 * 0.28/1e6
    expect(result.usage.cost_usd).toBeCloseTo(0.00000582, 10);
  });

  it("maps json: true to response_format json_object", async () => {
    const fetchMock = mockFetchOnce({
      choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      json: true,
    });

    const [, options] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.response_format).toEqual({ type: "json_object" });
  });
});

describe("calculateCostUsd", () => {
  it("computes cost using cache-hit and cache-miss pricing for a known model", () => {
    expect(calculateCostUsd("deepseek-v4-flash", 1_000_000, 0, 0)).toBeCloseTo(0.0028, 10);
    expect(calculateCostUsd("deepseek-v4-flash", 0, 1_000_000, 0)).toBeCloseTo(0.14, 10);
    expect(calculateCostUsd("deepseek-v4-flash", 0, 0, 1_000_000)).toBeCloseTo(0.28, 10);
  });

  it("returns null for a model with no pricing entry", () => {
    expect(calculateCostUsd("some-custom-model", 100, 100, 100)).toBeNull();
  });
});
