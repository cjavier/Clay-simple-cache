import net from "net";
import { lookup as dnsLookup } from "dns/promises";
import { config } from "../email-finder/config";
import {
  chatCompletion,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekUsage,
} from "./deepseek.service";

// ---------------------------------------------------------------------------
// Tool: serp_search
// ---------------------------------------------------------------------------

export interface SerpOrganicResult {
  title: string;
  link: string;
  snippet: string;
}

export interface SerpSearchResult {
  query: string;
  answer_box: any;
  organic: SerpOrganicResult[];
}

const SERPER_TIMEOUT_MS = 15_000;

export async function serpSearch(query: string): Promise<SerpSearchResult> {
  if (!query || typeof query !== "string") {
    throw new Error("query is required");
  }
  if (!config.serper_api_key) {
    throw new Error("SERPER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": config.serper_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query }),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Serper search timed out for query: ${query}`);
    }
    throw new Error(`Serper search failed: ${error?.message || "network error"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Serper search failed with HTTP ${response.status}`);
  }

  const data: any = await response.json();
  const organic: SerpOrganicResult[] = (data?.organic || [])
    .slice(0, 8)
    .map((item: any) => ({
      title: item?.title || "",
      link: item?.link || "",
      snippet: item?.snippet || "",
    }));

  return {
    query,
    answer_box: data?.answerBox ?? null,
    organic,
  };
}

// ---------------------------------------------------------------------------
// Tool: fetch_page (with SSRF guard)
// ---------------------------------------------------------------------------

export class SsrfBlockedError extends Error {
  constructor(url: string) {
    super(`Blocked potentially unsafe URL: ${url}`);
    this.name = "SsrfBlockedError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal"];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const host = ip.toLowerCase();
  if (host === "::1") return true; // loopback
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return isPrivateIPv4(mapped);
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10 link-local
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isPrivateIPv4(host);
  if (ipVersion === 6) return isPrivateIPv6(host);

  return false;
}

/**
 * Validates a URL against SSRF targets, including DNS-rebinding protection:
 * even if the hostname itself looks safe, every IP address it resolves to
 * is checked against the private/internal ranges before we allow a connection.
 * Must be called immediately before each connection attempt (including every
 * redirect hop) so a rebound DNS answer can't slip through between check and use.
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(rawUrl);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new SsrfBlockedError(rawUrl);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 0) {
    // host is a hostname, not an IP literal: resolve it and validate every
    // returned address so a rebinding attack can't swap in a private IP.
    let addresses: { address: string; family: number }[];
    try {
      addresses = await dnsLookup(host, { all: true });
    } catch (error: any) {
      const wrapped: any = new Error(`Failed to resolve host ${host}`);
      wrapped.cause = error;
      throw wrapped;
    }
    if (!addresses || addresses.length === 0) {
      throw new SsrfBlockedError(rawUrl);
    }
    for (const { address, family } of addresses) {
      if (family === 4 && isPrivateIPv4(address)) {
        throw new SsrfBlockedError(rawUrl);
      }
      if (family === 6 && isPrivateIPv6(address)) {
        throw new SsrfBlockedError(rawUrl);
      }
    }
  }

  return parsed;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_CHARS = 8_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface FetchPageResult {
  url: string;
  final_url: string;
  status: number;
  text: string;
  truncated: boolean;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPage(rawUrl: string): Promise<FetchPageResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("url is required");
  }

  let currentUrl = rawUrl;
  let redirects = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const parsed = await assertSafeUrl(currentUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new Error(`Timed out fetching ${currentUrl} after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(`Failed to fetch ${currentUrl}: ${error?.message || "network error"}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect from ${currentUrl} had no Location header`);
      }
      redirects++;
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${rawUrl}`);
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const looksLikeHtml = contentType.includes("html") || /<html[\s>]/i.test(raw.slice(0, 500));
    const text = looksLikeHtml ? stripHtml(raw) : raw.replace(/\s+/g, " ").trim();
    const truncated = text.length > MAX_CHARS;

    return {
      url: rawUrl,
      final_url: currentUrl,
      status: response.status,
      text: truncated ? text.slice(0, MAX_CHARS) : text,
      truncated,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 8;
const HARD_MAX_STEPS = 15;

const SYSTEM_PROMPT =
  "You are a research/exploration agent for a GTM (go-to-market) agency. " +
  "You can call `serp_search` to search Google and `fetch_page` to read a web page's text content. " +
  "Use them as needed to investigate the user's request — verify facts, find sources, and read pages " +
  "before answering. When you have enough information, respond with a clear, direct final answer and " +
  "do not call any more tools.";

const TOOLS: DeepSeekTool[] = [
  {
    type: "function",
    function: {
      name: "serp_search",
      description:
        "Search Google (via Serper) for a query. Returns the top organic results (title, link, snippet) " +
        "and an answer box when available. Use this to find facts, companies, people, or general information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page and return its text content (HTML stripped, truncated to ~8000 chars). " +
        "Only http/https URLs are allowed; requests to internal/private network addresses are blocked.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The absolute URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
];

export interface ExploreStep {
  step: number;
  tool: string;
  input: any;
  output_summary: string;
  reasoning?: string;
}

export interface ExploreAgentResult {
  message: string;
  steps: ExploreStep[];
  total_steps: number;
  duration_ms: number;
  usage: DeepSeekUsage;
}

export interface RunExploreAgentParams {
  prompt: string;
  max_steps?: number;
  model?: string;
}

function safeParseJson(raw: string | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function summarize(output: unknown): string {
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (!str) return "";
  return str.length > 300 ? `${str.slice(0, 300)}…` : str;
}

function addUsage(total: DeepSeekUsage, delta: DeepSeekUsage): void {
  total.prompt_tokens += delta.prompt_tokens || 0;
  total.completion_tokens += delta.completion_tokens || 0;
  total.total_tokens += delta.total_tokens || 0;
}

export async function runExploreAgent(
  params: RunExploreAgentParams
): Promise<ExploreAgentResult> {
  const start = Date.now();

  const requestedMaxSteps =
    typeof params.max_steps === "number" && params.max_steps > 0
      ? Math.floor(params.max_steps)
      : DEFAULT_MAX_STEPS;
  const maxSteps = Math.min(requestedMaxSteps, HARD_MAX_STEPS);

  const messages: DeepSeekMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: params.prompt },
  ];

  const steps: ExploreStep[] = [];
  const usage: DeepSeekUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let stepCount = 0;
  let finalMessage = "";

  // Safety cap on outer loop iterations independent of tool-call count.
  const MAX_ITERATIONS = maxSteps + 2;
  let iterations = 0;

  while (true) {
    iterations++;
    const forceFinal = stepCount >= maxSteps || iterations > MAX_ITERATIONS;

    const result = await chatCompletion({
      messages,
      model: params.model,
      tools: forceFinal ? undefined : TOOLS,
      tool_choice: forceFinal ? undefined : "auto",
    });

    addUsage(usage, result.usage);

    const assistantMessage = result.choice.message;
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls;
    if (forceFinal || !toolCalls || toolCalls.length === 0) {
      finalMessage = assistantMessage.content || "";
      break;
    }

    for (const toolCall of toolCalls) {
      stepCount++;
      const input = safeParseJson(toolCall.function.arguments);
      let output: unknown;

      try {
        if (toolCall.function.name === "serp_search") {
          output = await serpSearch(input?.query);
        } else if (toolCall.function.name === "fetch_page") {
          output = await fetchPage(input?.url);
        } else {
          output = { error: `Unknown tool: ${toolCall.function.name}` };
        }
      } catch (error: any) {
        output = { error: error?.message || String(error) };
      }

      steps.push({
        step: stepCount,
        tool: toolCall.function.name,
        input,
        output_summary: summarize(output),
        reasoning: assistantMessage.content || undefined,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(output),
      });
    }
  }

  return {
    message: finalMessage,
    steps,
    total_steps: steps.length,
    duration_ms: Date.now() - start,
    usage,
  };
}
