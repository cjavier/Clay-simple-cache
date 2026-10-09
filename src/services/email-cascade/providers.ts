import { Blitz, BlitzError, blitzConfigured } from "../blitz.client";
import { junkReason } from "../table-build";

/**
 * The paid email finders of the cascade, behind one shape.
 *
 * Every adapter turns the provider's own vocabulary into five outcomes, and
 * the difference between them is the whole point of the cascade:
 *  - found       an address (with who verified it);
 *  - not_found   the provider looked and has nothing — a real answer, not retried for 90 days;
 *  - no_credits  402 or the provider's "insufficient credits" — trips the breaker;
 *  - rate_limit  429 after one backoff — the person stays pending;
 *  - error       anything else (network, 5xx, bad key) — the person stays pending.
 *
 * Costs (USD per address found; a miss costs nothing on all three) are
 * configurable because they depend on the plan:
 *  - Blitz      EMAIL_COST_BLITZAPI_USD  (default 0: flat plan, "an email not found costs 0")
 *  - Prospeo    EMAIL_COST_PROSPEO_USD   (default 0.05: 1 credit per verified match)
 *  - Findymail  EMAIL_COST_FINDYMAIL_USD (default 0.05: 1 credit per verified contact, ~$49/1,000)
 */

export const CASCADE_PROVIDERS = ["blitzapi", "prospeo", "findymail"] as const;
export type CascadeProviderId = (typeof CASCADE_PROVIDERS)[number];

export interface CascadePerson {
  linkedin_url?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  company_domain?: string | null;
  company_name?: string | null;
}

export interface EmailVerification {
  provider: string | null;
  verdict: "valid" | "invalid" | "catch_all" | "unknown" | "risky";
}

export type ProviderOutcome =
  | { kind: "found"; email: string; verification: EmailVerification | null; raw?: unknown }
  | { kind: "not_found"; detail?: string }
  | { kind: "no_credits"; detail: string; reason: "sin_creditos" | "sin_acceso" }
  | { kind: "rate_limit"; detail: string }
  | { kind: "error"; detail: string };

export interface Balance {
  balance: number | null;
  error: string | null;
  raw?: unknown;
}

export interface CascadeProvider {
  id: CascadeProviderId;
  label: string;
  configured(): boolean;
  /** USD charged when it finds an address (misses are free). */
  costUsd(): number;
  find(person: CascadePerson): Promise<ProviderOutcome>;
  /** Free balance check; absent when the provider has none we can read. */
  balance?(): Promise<Balance>;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function unitCost(id: CascadeProviderId, env: NodeJS.ProcessEnv = process.env): number {
  if (id === "blitzapi") return num(env.EMAIL_COST_BLITZAPI_USD, 0);
  if (id === "prospeo") return num(env.EMAIL_COST_PROSPEO_USD, 0.05);
  return num(env.EMAIL_COST_FINDYMAIL_USD, 0.05);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny semaphore so one provider never gets the build's whole fan-out at once. */
export function limiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function bareDomain(v: string | null | undefined): string {
  return String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] || "";
}

export function fullName(p: CascadePerson): string {
  return (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")).trim();
}

/** A usable address: has an @, isn't masked, isn't junk (rule 5). */
export function usable(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  if (!e.includes("@") || e.includes("*")) return null;
  return junkReason(e) ? null : e;
}

interface HttpResult {
  status: number;
  body: any;
}

type FetchLike = typeof fetch;

async function http(url: string, init: RequestInit, fetchImpl: FetchLike, timeoutMs = 30_000): Promise<HttpResult> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* plain text */
  }
  return { status: res.status, body };
}

const short = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? "")).slice(0, 300);

/** One request, one retry after a backoff on 429. Network failures are `error`. */
async function withRetry(call: () => Promise<HttpResult>): Promise<HttpResult | { failed: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await call();
      if (r.status === 429 && attempt === 0) {
        await sleep(Number(process.env.EMAIL_RATE_LIMIT_BACKOFF_MS || 2000));
        continue;
      }
      return r;
    } catch (e: any) {
      return { failed: e?.message || String(e) };
    }
  }
}

// ─── Prospeo ────────────────────────────────────────────────

/**
 * POST https://api.prospeo.io/enrich-person (header X-KEY), only verified
 * emails: a hit is already verified by Prospeo; NO_MATCH (400) is a free
 * miss. Out of credits = error_code INSUFFICIENT_CREDITS (or 402).
 * Balance: GET /account-information → response.remaining_credits (free).
 */
export function prospeoProvider(fetchImpl: FetchLike = fetch, key = () => process.env.PROSPEO_API_KEY || ""): CascadeProvider {
  const run = limiter(num(process.env.PROSPEO_CONCURRENCY, 5) || 5);
  return {
    id: "prospeo",
    label: "Prospeo",
    configured: () => Boolean(key()),
    costUsd: () => unitCost("prospeo"),
    async find(p) {
      const domain = bareDomain(p.company_domain);
      const name = fullName(p);
      const data: Record<string, string> = {};
      if (p.first_name) data.first_name = p.first_name;
      if (p.last_name) data.last_name = p.last_name;
      if (name) data.full_name = name;
      if (domain) data.company_website = domain;
      if (p.company_name) data.company_name = p.company_name;
      if (p.linkedin_url) data.linkedin_url = p.linkedin_url;
      if (!p.linkedin_url && !((domain || p.company_name) && name)) return { kind: "not_found", detail: "sin datos suficientes" };

      const r = await run(() =>
        withRetry(() =>
          http("https://api.prospeo.io/enrich-person", {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json", "X-KEY": key() },
            body: JSON.stringify({ only_verified_email: true, data }),
          }, fetchImpl)
        )
      );
      if ("failed" in r) return { kind: "error", detail: r.failed };
      const code = String(r.body?.error_code || "").toUpperCase();
      if (r.status === 402 || code === "INSUFFICIENT_CREDITS") return { kind: "no_credits", reason: "sin_creditos", detail: `HTTP ${r.status} ${code}`.trim() };
      if (r.status === 401 || code === "INVALID_API_KEY") return { kind: "no_credits", reason: "sin_acceso", detail: `HTTP ${r.status} ${code}`.trim() };
      if (code === "NO_MATCH") return { kind: "not_found" };
      if (r.status === 429 || code === "RATE_LIMITED") return { kind: "rate_limit", detail: `HTTP ${r.status}` };
      if (r.status >= 400 || r.body?.error === true) return { kind: "error", detail: `HTTP ${r.status} ${short(r.body)}` };
      const email = usable(r.body?.person?.email?.email);
      if (!email) return { kind: "not_found", detail: r.body?.person?.email?.email ? "descartado" : undefined };
      return { kind: "found", email, verification: { provider: "prospeo", verdict: "valid" }, raw: { status: r.body?.person?.email?.status ?? null } };
    },
    async balance() {
      try {
        const r = await http("https://api.prospeo.io/account-information", { headers: { "X-KEY": key() } }, fetchImpl, 15_000);
        const n = Number(r.body?.response?.remaining_credits);
        if (r.status >= 400 || !Number.isFinite(n)) return { balance: null, error: `HTTP ${r.status} ${short(r.body?.error_code || r.body)}`, raw: r.body };
        return { balance: n, error: null, raw: r.body?.response };
      } catch (e: any) {
        return { balance: null, error: e?.message || String(e) };
      }
    },
  };
}

// ─── Findymail ──────────────────────────────────────────────

/**
 * POST https://app.findymail.com/api/search/name {name, domain} — or
 * /search/business-profile {linkedin_url} when there's no domain — Bearer.
 * It charges and answers a contact only for a verified address; no contact
 * or 404 = a free miss; 402 = out of credits.
 * Balance: GET /api/credits → credits (free).
 */
export function findymailProvider(fetchImpl: FetchLike = fetch, key = () => process.env.FINDYMAIL_API_KEY || ""): CascadeProvider {
  const run = limiter(num(process.env.FINDYMAIL_CONCURRENCY, 5) || 5);
  const BASE = "https://app.findymail.com/api";
  const headers = () => ({ accept: "application/json", "content-type": "application/json", Authorization: `Bearer ${key()}` });
  return {
    id: "findymail",
    label: "Findymail",
    configured: () => Boolean(key()),
    costUsd: () => unitCost("findymail"),
    async find(p) {
      const domain = bareDomain(p.company_domain);
      const name = fullName(p);
      const byName = Boolean(name && (domain || p.company_name));
      if (!byName && !p.linkedin_url) return { kind: "not_found", detail: "sin datos suficientes" };
      const [path, body] = byName
        ? ["/search/name", { name, domain: domain || p.company_name }]
        : ["/search/business-profile", { linkedin_url: p.linkedin_url }];
      const r = await run(() => withRetry(() => http(`${BASE}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, fetchImpl)));
      if ("failed" in r) return { kind: "error", detail: r.failed };
      if (r.status === 402) return { kind: "no_credits", reason: "sin_creditos", detail: `HTTP 402 ${short(r.body?.error || r.body?.message || "")}`.trim() };
      if (r.status === 401 || r.status === 403) return { kind: "no_credits", reason: "sin_acceso", detail: `HTTP ${r.status}` };
      if (r.status === 404) return { kind: "not_found" };
      if (r.status === 429) return { kind: "rate_limit", detail: "HTTP 429" };
      if (r.status >= 400) return { kind: "error", detail: `HTTP ${r.status} ${short(r.body)}` };
      const contact = r.body?.contact;
      const email = usable(contact?.email ?? r.body?.email);
      if (!email) return { kind: "not_found", detail: contact?.email ? "descartado" : undefined };
      // Findymail only returns verified contacts; it says so when the response carries a flag.
      const v = contact?.verified ?? contact?.is_verified ?? r.body?.verified;
      const verification: EmailVerification =
        v === true ? { provider: "findymail", verdict: "valid" } : v === false ? { provider: "findymail", verdict: "risky" } : { provider: null, verdict: "unknown" };
      return { kind: "found", email, verification };
    },
    async balance() {
      try {
        const r = await http(`${BASE}/credits`, { headers: headers() }, fetchImpl, 15_000);
        const n = Number(r.body?.credits);
        if (r.status >= 400 || !Number.isFinite(n)) return { balance: null, error: `HTTP ${r.status} ${short(r.body?.error || r.body?.message || r.body)}`, raw: r.body };
        return { balance: n, error: null, raw: { credits: n, verifier_credits: r.body?.verifier_credits, has_capacity: r.body?.has_capacity } };
      } catch (e: any) {
        return { balance: null, error: e?.message || String(e) };
      }
    },
  };
}

// ─── Blitz ──────────────────────────────────────────────────

let sharedBlitz: Promise<Blitz> | null = null;
/** One client for every build and retry, so all of them share the plan's rate limit. */
export function blitzClient(): Promise<Blitz> {
  sharedBlitz ??= new Blitz().init().catch((e) => {
    sharedBlitz = null;
    throw e;
  });
  return sharedBlitz;
}

/** Blitz by LinkedIn (POST /v2/enrichment/email). Its addresses are verified by Blitz (legacy "valido"). */
export function blitzProvider(client: () => Promise<Pick<Blitz, "findEmail">> = blitzClient): CascadeProvider {
  return {
    id: "blitzapi",
    label: "Blitz",
    configured: blitzConfigured,
    costUsd: () => unitCost("blitzapi"),
    async find(p) {
      if (!p.linkedin_url) return { kind: "not_found", detail: "sin linkedin" };
      try {
        const bz = await client();
        const em = await bz.findEmail(p.linkedin_url);
        if (!em?.found) return { kind: "not_found" };
        const email = usable(em.email);
        if (!email) return { kind: "not_found", detail: "descartado" };
        // As today: no verifier object, the row says email_status "valido" (= verdict valid).
        return { kind: "found", email, verification: null, raw: { all_emails: em.all_emails ?? [] } };
      } catch (e: any) {
        const status = e instanceof BlitzError ? e.status : 0;
        if (status === 402) return { kind: "no_credits", reason: "sin_creditos", detail: "HTTP 402" };
        if (status === 401 || status === 403) return { kind: "no_credits", reason: "sin_acceso", detail: `HTTP ${status}` };
        if (status === 429) return { kind: "rate_limit", detail: "HTTP 429" };
        return { kind: "error", detail: String(e?.message || e).slice(0, 300) };
      }
    },
  };
}

/** The production cascade, in order. */
export function defaultProviders(): CascadeProvider[] {
  return [blitzProvider(), prospeoProvider(), findymailProvider()];
}
