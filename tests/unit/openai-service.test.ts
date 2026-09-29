import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { calculateOpenAICostUsd, isReasoningModel, openaiProvider } from "../../src/services/openai.service";
import { activeProvider, chatCompletion, defaultModel, LlmApiError, LlmConfigError } from "../../src/services/llm.service";

const TEST_KEY = "test-openai-key";

function mockFetchOnce(body: any, status = 200, ok = status >= 200 && status < 300) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: "status text",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function textResponse(text: string, usage: any = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) {
  return {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage,
  };
}

function sentBody(fetchMock: any, call = 0) {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

describe("llm.service provider selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to OpenAI gpt-6-luna when LLM_PROVIDER is unset", () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("OPENAI_MODEL", "");
    expect(activeProvider().name).toBe("openai");
    expect(defaultModel()).toBe("gpt-6-luna");
  });

  it("switches to DeepSeek with a single env var", () => {
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_MODEL", "");
    expect(activeProvider().name).toBe("deepseek");
    expect(defaultModel()).toBe("deepseek-v4-flash");
  });

  it("rejects an unknown provider as a config error (503), not a crash", () => {
    vi.stubEnv("LLM_PROVIDER", "gemini");
    expect(() => activeProvider()).toThrow(LlmConfigError);
  });
});

describe("openai.service chatCompletion", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("OPENAI_REASONING_EFFORT", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("throws LlmConfigError naming OPENAI_API_KEY when it is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(chatCompletion({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("calls the Responses API and parses text and usage", async () => {
    const fetchMock = mockFetchOnce(
      textResponse("Hello there", {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        output_tokens: 200,
        total_tokens: 1200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "Say hi" }] });

    expect(result.message.content).toBe("Hello there");
    expect(result.finish_reason).toBe("stop");
    expect(result.usage).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 600,
    });
    // 500 uncached * 0.10 + 400 cached * 0.01 + 100 writes * 0.125 + 200 out * 0.50, per 1M
    expect(result.usage.cost_usd).toBeCloseTo(0.0001665, 10);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options.headers.Authorization).toBe(["Bearer", TEST_KEY].join(" "));
    const body = sentBody(fetchMock);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Say hi" },
    ]);
  });

  it("maps max_tokens, json and reasoning, and drops temperature with a warning", async () => {
    const fetchMock = mockFetchOnce(textResponse("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 500,
      temperature: 0.7,
      json: true,
      reasoning: true,
    });

    const body = sentBody(fetchMock);
    expect(body.max_output_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.text).toEqual({ format: { type: "json_object" } });
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(result.warnings?.[0]).toMatch(/temperature/);
  });

  it("sends effort none when reasoning is disabled", async () => {
    const fetchMock = mockFetchOnce(textResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion({ messages: [{ role: "user", content: "hi" }], reasoning: false });
    expect(sentBody(fetchMock).reasoning).toEqual({ effort: "none" });
  });

  it("keeps temperature for non-reasoning models", async () => {
    const fetchMock = mockFetchOnce(textResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await chatCompletion({ messages: [{ role: "user", content: "hi" }], model: "gpt-4.1", temperature: 0.3, reasoning: true });
    const body = sentBody(fetchMock);
    expect(body.temperature).toBe(0.3);
    expect(body.reasoning).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.usage.cost_usd).toBeNull(); // not in the pricing table
  });

  it("flattens tools and returns function calls as neutral tool_calls", async () => {
    const reasoningItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need to search." }], encrypted_content: "enc" };
    const callItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "serp_search", arguments: '{"query":"x"}' };
    const fetchMock = mockFetchOnce({ status: "completed", output: [reasoningItem, callItem], usage: { input_tokens: 5, output_tokens: 5 } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "serp_search", description: "d", parameters: { type: "object" } } }],
      tool_choice: "auto",
    });

    const body = sentBody(fetchMock);
    expect(body.tools).toEqual([{ type: "function", name: "serp_search", description: "d", parameters: { type: "object" }, strict: false }]);
    expect(body.tool_choice).toBe("auto");
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "serp_search", arguments: '{"query":"x"}' } },
    ]);
    expect(result.message.reasoning).toBe("Need to search.");
    expect(result.message.provider_state).toEqual([reasoningItem, callItem]);
  });

  it("replays provider_state and maps tool results to function_call_output", async () => {
    const fetchMock = mockFetchOnce(textResponse("done"));
    vi.stubGlobal("fetch", fetchMock);
    const state = [{ type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] }, { type: "function_call", call_id: "call_1", name: "t", arguments: "{}" }];

    await chatCompletion({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, reasoning: "x", provider_state: state },
        { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
        // Plain history (e.g. from another provider) is rebuilt from tool_calls.
        { role: "assistant", content: "hm", tool_calls: [{ id: "call_2", type: "function", function: { name: "t", arguments: "{}" } }] },
      ],
    });

    expect(sentBody(fetchMock).input).toEqual([
      { role: "user", content: "hi" },
      ...state,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
      { role: "assistant", content: "hm" },
      { type: "function_call", call_id: "call_2", name: "t", arguments: "{}" },
    ]);
  });

  it("reports a truncated response as finish_reason length", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 1, output_tokens: 16 } })
    );
    const result = await chatCompletion({ messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    expect(result.finish_reason).toBe("length");
    expect(result.message.content).toBeNull();
  });

  it("throws LlmApiError with the upstream message on a non-ok response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: { message: "invalid api key" } }, 401, false));
    await expect(chatCompletion({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "LlmApiError",
      status: 401,
      message: expect.stringContaining("invalid api key"),
    });
  });

  it("throws LlmApiError 504 on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")));
    await expect(chatCompletion({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ status: 504 });
  });

  it("throws LlmApiError when the response has no output", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ status: "completed", output: [] }));
    await expect(chatCompletion({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(LlmApiError);
  });
});

describe("openai pricing helpers", () => {
  it("computes cost per bucket for gpt-6-luna", () => {
    expect(calculateOpenAICostUsd("gpt-6-luna", 1_000_000, 0, 0, 0)).toBeCloseTo(0.1, 10);
    expect(calculateOpenAICostUsd("gpt-6-luna", 1_000_000, 1_000_000, 0, 0)).toBeCloseTo(0.01, 10);
    expect(calculateOpenAICostUsd("gpt-6-luna", 1_000_000, 0, 1_000_000, 0)).toBeCloseTo(0.125, 10);
    expect(calculateOpenAICostUsd("gpt-6-luna", 0, 0, 0, 1_000_000)).toBeCloseTo(0.5, 10);
  });

  it("returns null for an unpriced model", () => {
    expect(calculateOpenAICostUsd("gpt-4.1", 1, 1, 1, 1)).toBeNull();
  });

  it("classifies reasoning models", () => {
    expect(isReasoningModel("gpt-6-luna")).toBe(true);
    expect(isReasoningModel("gpt-5.5")).toBe(true);
    expect(isReasoningModel("o3")).toBe(true);
    expect(isReasoningModel("gpt-4.1")).toBe(false);
  });

  it("uses OPENAI_MODEL as the default-model override", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-6-sol");
    expect(openaiProvider.defaultModel()).toBe("gpt-6-sol");
    vi.unstubAllEnvs();
  });
});
