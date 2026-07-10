import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock shared config so serpSearch has an API key configured.
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

// Mock DNS resolution so tests don't depend on real network access. By default,
// every hostname resolves to a public IP; individual tests can override this
// (e.g. to simulate DNS rebinding into a private range) via mockLookup.
const mockLookup = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
vi.mock("dns/promises", () => ({
  lookup: (...args: any[]) => mockLookup(...args),
}));

import {
  fetchPage,
  isBlockedHost,
  runExploreAgent,
  SsrfBlockedError,
} from "../../src/services/explore-agent.service";

describe("fetch_page SSRF guard", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const blockedUrls = [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://127.5.5.5/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/", // cloud metadata endpoint
    "http://[::1]/",
    "http://foo.local/",
    "http://bar.internal/",
  ];

  it.each(blockedUrls)("blocks %s", async (url) => {
    await expect(fetchPage(url)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("does not treat public IPs or hostnames as blocked", () => {
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("172.32.0.1")).toBe(false); // just outside 172.16.0.0/12
    expect(isBlockedHost("172.15.255.255")).toBe(false);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(fetchPage("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("fetches and strips HTML for an allowed URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
        text: () => Promise.resolve("<html><body><script>evil()</script><p>Hello world</p></body></html>"),
      })
    );

    const result = await fetchPage("https://example.com/page");
    expect(result.text).toContain("Hello world");
    expect(result.text).not.toContain("evil()");
    expect(result.truncated).toBe(false);
  });

  it("follows redirects up to the limit and re-validates each hop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { get: (name: string) => (name === "location" ? "https://example.com/final" : null) },
        text: () => Promise.resolve(""),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
        text: () => Promise.resolve("<p>Final page</p>"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPage("https://example.com/start");
    expect(result.final_url).toBe("https://example.com/final");
    expect(result.text).toContain("Final page");
  });

  it("blocks a redirect that points to an internal address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 302,
        headers: { get: (name: string) => (name === "location" ? "http://169.254.169.254/latest/meta-data" : null) },
        text: () => Promise.resolve(""),
      })
    );

    await expect(fetchPage("https://example.com/start")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks a hostname that resolves (DNS rebinding) to a private IP", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn());

    await expect(fetchPage("https://rebind.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a hostname whose resolved IPs are all public", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
        text: () => Promise.resolve("<p>Safe page</p>"),
      })
    );

    const result = await fetchPage("https://safe.example.com/");
    expect(result.text).toContain("Safe page");
  });
});

describe("runExploreAgent loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
  });

  function deepseekResponse(body: any) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  it("executes one tool call then returns the final response", async () => {
    const toolCallResponse = deepseekResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Let me search for that.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "serp_search", arguments: JSON.stringify({ query: "clay cache" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });

    const finalResponse = deepseekResponse({
      choices: [
        {
          message: { role: "assistant", content: "Clay Cache is a GTM enrichment API." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
    });

    const serperResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          answerBox: null,
          organic: [{ title: "Clay Cache", link: "https://example.com", snippet: "A GTM cache API" }],
        }),
    };

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("google.serper.dev")) return Promise.resolve(serperResponse);
      return Promise.resolve(fetchMock.mock.calls.filter((c) => c[0].includes("deepseek")).length === 1
        ? toolCallResponse
        : finalResponse);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await runExploreAgent({ prompt: "What is Clay Cache?" });

    expect(result.message).toBe("Clay Cache is a GTM enrichment API.");
    expect(result.total_steps).toBe(1);
    expect(result.steps[0]).toMatchObject({
      step: 1,
      tool: "serp_search",
      input: { query: "clay cache" },
      reasoning: "Let me search for that.",
    });
    expect(result.steps[0].output_summary).toContain("Clay Cache");
    expect(result.usage.prompt_tokens).toBe(60);
    expect(result.usage.completion_tokens).toBe(25);
    expect(result.usage.total_tokens).toBe(85);
    expect(typeof result.usage.cost_usd).toBe("number");
  });

  it("forces a final answer without tools once max_steps is reached", async () => {
    let deepseekCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, options: any) => {
      if (url.includes("google.serper.dev")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ organic: [] }),
        });
      }
      deepseekCalls++;
      const parsedBody = JSON.parse(options.body);
      if (deepseekCalls <= 1) {
        // Model keeps calling tools.
        expect(parsedBody.tools).toBeDefined();
        return Promise.resolve(
          deepseekResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `call_${deepseekCalls}`,
                      type: "function",
                      function: { name: "serp_search", arguments: JSON.stringify({ query: "loop" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          })
        );
      }
      // Forced-final call must not include tools.
      expect(parsedBody.tools).toBeUndefined();
      return Promise.resolve(
        deepseekResponse({
          choices: [
            { message: { role: "assistant", content: "Final answer after max steps." }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await runExploreAgent({ prompt: "loop forever", max_steps: 1 });

    expect(result.message).toBe("Final answer after max steps.");
    expect(result.total_steps).toBe(1);
  });

  it("caps max_steps at the hard limit of 15", async () => {
    // Just verify the loop terminates (doesn't hang) when a huge max_steps is requested
    // and the model never stops calling tools, by checking it stops within HARD_MAX_STEPS.
    let deepseekCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("google.serper.dev")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ organic: [] }) });
      }
      deepseekCalls++;
      return Promise.resolve(
        deepseekResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${deepseekCalls}`,
                    type: "function",
                    function: { name: "serp_search", arguments: JSON.stringify({ query: "x" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runExploreAgent({ prompt: "never stop", max_steps: 999 });
    expect(result.total_steps).toBeLessThanOrEqual(15 + 2); // hard cap + small slack for forced-final round
  });

  it("reformats the final answer as JSON and adds one extra call's usage when response_schema is set", async () => {
    let deepseekCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, options: any) => {
      deepseekCalls++;
      const parsedBody = JSON.parse(options.body);
      if (deepseekCalls === 1) {
        expect(parsedBody.response_format).toBeUndefined();
        return Promise.resolve(
          deepseekResponse({
            choices: [{ message: { role: "assistant", content: "Clay Cache is a GTM enrichment API." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
          })
        );
      }
      // The follow-up reformat call must request JSON output and skip tools/thinking.
      expect(parsedBody.response_format).toEqual({ type: "json_object" });
      expect(parsedBody.tools).toBeUndefined();
      expect(parsedBody.thinking).toEqual({ type: "disabled" });
      return Promise.resolve(
        deepseekResponse({
          choices: [
            {
              message: { role: "assistant", content: JSON.stringify({ answer: "Clay Cache is a GTM enrichment API." }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 },
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runExploreAgent({
      prompt: "What is Clay Cache?",
      response_schema: { answer: "string" },
    });

    expect(deepseekCalls).toBe(2);
    expect(result.message).toEqual({ answer: "Clay Cache is a GTM enrichment API." });
    // Usage from both the research call and the reformat call is accumulated.
    expect(result.usage.prompt_tokens).toBe(100);
    expect(result.usage.completion_tokens).toBe(25);
    expect(result.usage.total_tokens).toBe(125);
  });
});
