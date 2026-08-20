import prisma from "../db/prisma";

/**
 * Balance monitor for every paid API the service depends on.
 *
 * This exists because of a real, silent 82-day outage: EmailListVerify ran out
 * of credits and DeBounce's key stopped authenticating, and because both
 * failures surface as a soft `unknown` result rather than an error, /find kept
 * answering 200 OK while finding nothing. Nobody noticed until the search log
 * was audited. A dead provider must be loud.
 */

export type CreditStatus = "green" | "yellow" | "red";

export interface CreditCheck {
  provider: string;
  label: string;
  /** What this provider being down actually breaks. */
  impact: string;
  status: CreditStatus;
  balance: number | null;
  unit: "credits" | "usd" | "unknown";
  /** balance / measured daily burn, when we know the burn rate. */
  days_left: number | null;
  error: string | null;
  raw: unknown;
}

const TIMEOUT_MS = 15_000;

/**
 * Runway thresholds. Days are preferred over absolute balances: 30k credits is
 * comfortable for Serper and three days of verification, so an absolute number
 * would be wrong for one provider or the other. Burn is measured from
 * search_log, so these track real usage instead of a guess.
 */
const RED_DAYS = Number(process.env.CREDIT_ALERT_RED_DAYS || 3);
const YELLOW_DAYS = Number(process.env.CREDIT_ALERT_YELLOW_DAYS || 10);

/** Fallback floors for providers whose consumption we don't log (DeepSeek). */
const USD_RED = Number(process.env.CREDIT_ALERT_RED_USD || 5);
const USD_YELLOW = Number(process.env.CREDIT_ALERT_YELLOW_USD || 20);

async function getJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text — some providers answer plain strings */
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Daily burn per resource, measured over the last 30 days of real traffic.
 * `verifications` counts API calls made against the verification cascade;
 * `searches` doubles as the SERP call count, since the pipeline issues one
 * Serper query per search.
 */
export async function measureDailyBurn(): Promise<{
  searches: number;
  verifications: number;
}> {
  try {
    const rows = await prisma.$queryRaw<
      { searches: bigint; verifications: bigint | null }[]
    >`
      SELECT count(*) AS searches, sum(api_calls_made) AS verifications
      FROM search_log
      WHERE created_at > now() - interval '30 days'
    `;
    const r = rows[0];
    return {
      searches: Number(r?.searches ?? 0) / 30,
      verifications: Number(r?.verifications ?? 0) / 30,
    };
  } catch {
    return { searches: 0, verifications: 0 };
  }
}

function classifyByRunway(
  balance: number,
  dailyBurn: number
): { status: CreditStatus; days_left: number | null } {
  if (balance <= 0) return { status: "red", days_left: 0 };
  if (dailyBurn <= 0) {
    // No measured traffic — fall back to "has some balance is fine".
    return { status: "green", days_left: null };
  }
  const days = balance / dailyBurn;
  if (days < RED_DAYS) return { status: "red", days_left: days };
  if (days < YELLOW_DAYS) return { status: "yellow", days_left: days };
  return { status: "green", days_left: days };
}

/** A provider we couldn't read at all is red: unknown is not safe. */
function unreadable(
  provider: string,
  label: string,
  impact: string,
  error: string,
  raw: unknown = null
): CreditCheck {
  return {
    provider,
    label,
    impact,
    status: "red",
    balance: null,
    unit: "unknown",
    days_left: null,
    error,
    raw,
  };
}

// ─── EmailListVerify ────────────────────────────────────────

async function checkEmailListVerify(burnPerDay: number): Promise<CreditCheck> {
  const key = process.env.EMAILLISTVERIFY_API_KEY || "";
  const label = "EmailListVerify";
  const impact = "Tier 1 de verificación — sin esto /find no confirma correos";
  if (!key) return unreadable("emaillistverify", label, impact, "API key no configurada");

  try {
    const { body } = await getJson(
      `https://api.emaillistverify.com/api/credits?secret=${encodeURIComponent(key)}`
    );
    // { "onDemand": { "available": 0 }, "subscription": null }
    const onDemand = Number(body?.onDemand?.available ?? 0);
    const sub = Number(body?.subscription?.available ?? 0);
    const balance = onDemand + sub;
    if (!Number.isFinite(balance)) {
      return unreadable("emaillistverify", label, impact, "Respuesta ilegible", body);
    }
    const { status, days_left } = classifyByRunway(balance, burnPerDay);
    return {
      provider: "emaillistverify",
      label,
      impact,
      status,
      balance,
      unit: "credits",
      days_left,
      error: balance <= 0 ? "Sin créditos (error_credit en /find)" : null,
      raw: body,
    };
  } catch (e: any) {
    return unreadable("emaillistverify", label, impact, e?.message || "Error de red");
  }
}

// ─── DeBounce ───────────────────────────────────────────────

async function checkDebounce(burnPerDay: number): Promise<CreditCheck> {
  const key = process.env.DEBOUNCE_API_KEY || "";
  const label = "DeBounce";
  const impact = "Tier 2 de verificación y contraste de catch-all";
  if (!key) return unreadable("debounce", label, impact, "API key no configurada");

  try {
    const { body } = await getJson(
      `https://api.debounce.io/v1/balance/?api=${encodeURIComponent(key)}`
    );
    // Healthy: { "balance": "12345", "success": "1" }
    // Bad key: { "debounce": { "error": "Wrong API", "code": "0" }, "success": "0" }
    const err = body?.debounce?.error;
    if (err) {
      return unreadable("debounce", label, impact, String(err), body);
    }
    const balance = Number(body?.balance ?? body?.debounce?.balance);
    if (!Number.isFinite(balance)) {
      return unreadable("debounce", label, impact, "Respuesta ilegible", body);
    }
    const { status, days_left } = classifyByRunway(balance, burnPerDay);
    return {
      provider: "debounce",
      label,
      impact,
      status,
      balance,
      unit: "credits",
      days_left,
      error: balance <= 0 ? "Sin créditos" : null,
      raw: body,
    };
  } catch (e: any) {
    return unreadable("debounce", label, impact, e?.message || "Error de red");
  }
}

// ─── Serper ─────────────────────────────────────────────────

async function checkSerper(burnPerDay: number): Promise<CreditCheck> {
  const key = process.env.SERPER_API_KEY || "";
  const label = "Serper (Google)";
  const impact = "Descubrimiento de patrones, /find-linkedin y el agente /explore";
  if (!key) return unreadable("serper", label, impact, "API key no configurada");

  try {
    const { body } = await getJson("https://google.serper.dev/account", {
      method: "POST",
      headers: { "X-API-KEY": key },
    });
    // { "balance": 34297, "rateLimit": 50 }
    const balance = Number(body?.balance);
    if (!Number.isFinite(balance)) {
      return unreadable("serper", label, impact, "Respuesta ilegible", body);
    }
    const { status, days_left } = classifyByRunway(balance, burnPerDay);
    return {
      provider: "serper",
      label,
      impact,
      status,
      balance,
      unit: "credits",
      days_left,
      error: balance <= 0 ? "Sin créditos" : null,
      raw: body,
    };
  } catch (e: any) {
    return unreadable("serper", label, impact, e?.message || "Error de red");
  }
}

// ─── DeepSeek ───────────────────────────────────────────────

async function checkDeepSeek(): Promise<CreditCheck> {
  const key = process.env.DEEPSEEK_API_KEY || "";
  const label = "DeepSeek";
  const impact = "Endpoints /copy y /explore";
  if (!key) return unreadable("deepseek", label, impact, "API key no configurada");

  try {
    const { body } = await getJson("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    // { "is_available": true, "balance_infos": [{ "currency": "USD", "total_balance": "59.15" }] }
    const usd = body?.balance_infos?.find((b: any) => b?.currency === "USD");
    const balance = Number(usd?.total_balance);
    if (!Number.isFinite(balance)) {
      return unreadable("deepseek", label, impact, "Respuesta ilegible", body);
    }
    // We don't log DeepSeek token spend, so runway isn't computable — use
    // absolute USD floors instead of pretending to know the burn rate.
    const status: CreditStatus =
      balance <= 0 || balance < USD_RED
        ? "red"
        : balance < USD_YELLOW
        ? "yellow"
        : "green";
    return {
      provider: "deepseek",
      label,
      impact,
      status,
      balance,
      unit: "usd",
      days_left: null,
      error:
        body?.is_available === false ? "Cuenta marcada como no disponible" : null,
      raw: body,
    };
  } catch (e: any) {
    return unreadable("deepseek", label, impact, e?.message || "Error de red");
  }
}

// ─── Orchestration ──────────────────────────────────────────

export interface CreditReport {
  checks: CreditCheck[];
  worst: CreditStatus;
  burn: { searches: number; verifications: number };
  checked_at: Date;
}

const RANK: Record<CreditStatus, number> = { green: 0, yellow: 1, red: 2 };

export function worstStatus(checks: CreditCheck[]): CreditStatus {
  return checks.reduce<CreditStatus>(
    (acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc),
    "green"
  );
}

export async function checkAllCredits(): Promise<CreditReport> {
  const burn = await measureDailyBurn();
  const checks = await Promise.all([
    checkEmailListVerify(burn.verifications),
    checkDebounce(burn.verifications),
    checkSerper(burn.searches),
    checkDeepSeek(),
  ]);
  return {
    checks,
    worst: worstStatus(checks),
    burn,
    checked_at: new Date(),
  };
}

/** Status recorded for each provider on the previous run, for change detection. */
export async function getPreviousStatuses(): Promise<Map<string, CreditStatus>> {
  const out = new Map<string, CreditStatus>();
  try {
    const rows = await prisma.$queryRaw<{ provider: string; status: string }[]>`
      SELECT DISTINCT ON (provider) provider, status
      FROM provider_credits
      ORDER BY provider, checked_at DESC
    `;
    for (const r of rows) out.set(r.provider, r.status as CreditStatus);
  } catch {
    /* first run, or table not migrated yet */
  }
  return out;
}

export async function persistReport(report: CreditReport): Promise<void> {
  await prisma.providerCredit.createMany({
    data: report.checks.map((c) => ({
      provider: c.provider,
      status: c.status,
      balance: c.balance,
      unit: c.unit,
      days_left: c.days_left,
      error: c.error,
      raw: (c.raw ?? {}) as any,
      checked_at: report.checked_at,
    })),
  });
}
