import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  chatCompletion,
  DeepSeekApiError,
  DeepSeekConfigError,
} from "../../src/services/deepseek.service";

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

  it("throws DeepSeekConfigError when DEEPSEEK_API_KEY is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(DeepSeekConfigError);
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

    expect(result.choice.message.content).toBe("Hello there");
    expect(result.choice.finish_reason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    // Verify request shape: correct URL, auth header, default model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer test-deepseek-key");
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.model).toBe("deepseek-chat");
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

  it("throws DeepSeekApiError with details on a non-ok HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ error: { message: "invalid api key" } }, 401, false)
    );

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({
      name: "DeepSeekApiError",
      status: 401,
    });
  });

  it("throws DeepSeekApiError on timeout (AbortError)", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({
      name: "DeepSeekApiError",
      status: 504,
    });
  });

  it("throws DeepSeekApiError when response has no choices", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ choices: [] }));

    await expect(
      chatCompletion({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(DeepSeekApiError);
  });
});
