import { analyzeDomain } from "../../email-finder/domain-intel";
import {
  derivePattern,
  EVIDENCE,
  getDomainOutcomes,
  isBadMailDomain,
  mailGateway,
  patternTier,
  SendRecommendation,
} from "../../email-finder/outcomes";
import { Verdict } from "../../email-finder/provenance";
import { normalizeLinkedIn } from "../normalization";
import { limiter } from "./providers";
import type { Breaker } from "./cascade";

/**
 * Validation of every address the cascade is about to use, and the policy
 * that decides whether it goes in the row's `Email`.
 *
 * Validators, in order, behind the same circuit breaker as the finders:
 *   Findymail verify (POST /api/verify → {verified, provider}) — resolves
 *   catch-all on Google, which SMTP verifiers can't →
 *   DeBounce → EmailListVerify (fallbacks when the one before is out of credits).
 *
 * What we know about the recipient's server rides along: MX provider (Google,
 * Microsoft…), security gateway (Mimecast, Barracuda…), whether the domain is
 * catch-all, and this domain's real mail history (bounces/deliveries per
 * pattern, from MailBridge outcomes).
 */

export const VALIDATORS = ["findymail_verify", "debounce", "emaillistverify"] as const;
export type ValidatorId = (typeof VALIDATORS)[number];

export type ValidatorOutcome =
  | { kind: "verdict"; verdict: Verdict; confidence: number | null; raw: unknown }
  | { kind: "no_credits"; reason: "sin_creditos" | "sin_acceso"; detail: string }
  | { kind: "error"; detail: string };

export interface Validator {
  id: ValidatorId;
  label: string;
  configured(): boolean;
  /** USD per verdict (charged whatever the verdict). */
  costUsd(): number;
  verify(email: string): Promise<ValidatorOutcome>;
  balance?(): Promise<{ balance: number | null; error: string | null; raw?: unknown }>;
}

type FetchLike = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

async function get(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* text */
  }
  return { status: res.status, body, text };
}

// ─── Findymail verify ───────────────────────────────────────

/** POST https://app.findymail.com/api/verify {email} → {email, verified: bool, provider: "Google"}. 402 = no verifier credits. */
export function findymailVerifier(fetchImpl: FetchLike = fetch, key = () => process.env.FINDYMAIL_API_KEY || ""): Validator {
  const run = limiter(num(process.env.FINDYMAIL_VERIFY_CONCURRENCY, 5) || 5);
  const headers = () => ({ accept: "application/json", "content-type": "application/json", Authorization: `Bearer ${key()}` });
  return {
    id: "findymail_verify",
    label: "Findymail (verificación)",
    configured: () => Boolean(key()),
    costUsd: () => num(process.env.EMAIL_COST_FINDYMAIL_VERIFY_USD, 0.005),
    async verify(email) {
      return run(async () => {
        for (let attempt = 0; ; attempt++) {
          let r;
          try {
            r = await get(fetchImpl, "https://app.findymail.com/api/verify", { method: "POST", headers: headers(), body: JSON.stringify({ email }) });
          } catch (e: any) {
            return { kind: "error", detail: e?.message || String(e) };
          }
          if (r.status === 429 && attempt === 0) {
            await sleep(Number(process.env.EMAIL_RATE_LIMIT_BACKOFF_MS || 2000));
            continue;
          }
          if (r.status === 402) return { kind: "no_credits", reason: "sin_creditos", detail: "HTTP 402" };
          if (r.status === 401 || r.status === 403) return { kind: "no_credits", reason: "sin_acceso", detail: `HTTP ${r.status}` };
          if (r.status >= 400 || typeof r.body?.verified !== "boolean") return { kind: "error", detail: `HTTP ${r.status} ${String(r.text).slice(0, 200)}` };
          // Findymail answers deliverable / not deliverable, catch-all domains included (it resolves them).
          return { kind: "verdict", verdict: r.body.verified ? "valid" : "invalid", confidence: 0.9, raw: r.body };
        }
      });
    },
    async balance() {
      try {
        const r = await get(fetchImpl, "https://app.findymail.com/api/credits", { headers: headers() }, 15_000);
        const n = Number(r.body?.verifier_credits);
        if (r.status >= 400 || !Number.isFinite(n)) return { balance: null, error: `HTTP ${r.status}` };
        return { balance: n, error: null };
      } catch (e: any) {
        return { balance: null, error: e?.message || String(e) };
      }
    },
  };
}

// ─── DeBounce ───────────────────────────────────────────────

/** Result codes (help.debounce.com/understanding-results/result-codes). */
const DEBOUNCE: Record<string, [Verdict, number]> = {
  "1": ["invalid", 0.98], // syntax
  "2": ["invalid", 0.99], // spam trap: never send
  "3": ["risky", 0.95], // disposable
  "4": ["catch_all", 0.5], // accept-all
  "5": ["valid", 0.95],
  "6": ["invalid", 0.95],
  "7": ["unknown", 0.3],
  "8": ["risky", 0.8], // role
};

/** GET https://api.debounce.io/v1/?api=KEY&email=… (balance: /v1/balance/). DeBounce caps CONCURRENT calls per account. */
export function debounceVerifier(fetchImpl: FetchLike = fetch, key = () => process.env.DEBOUNCE_API_KEY || ""): Validator {
  const run = limiter(1);
  return {
    id: "debounce",
    label: "DeBounce",
    configured: () => Boolean(key()),
    costUsd: () => num(process.env.EMAIL_COST_DEBOUNCE_USD, 0.0015),
    async verify(email) {
      return run(async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          let r;
          try {
            r = await get(fetchImpl, `https://api.debounce.io/v1/?api=${encodeURIComponent(key())}&email=${encodeURIComponent(email)}`);
          } catch (e: any) {
            return { kind: "error", detail: e?.message || String(e) };
          }
          const err = String(r.body?.debounce?.error || "");
          if (r.status === 429 || /concurrent|rate limit|too many/i.test(err)) {
            await sleep(500 * (attempt + 1));
            continue;
          }
          if (r.status === 402 || /credit|balance/i.test(err)) return { kind: "no_credits", reason: "sin_creditos", detail: err || `HTTP ${r.status}` };
          if (r.status === 401 || /wrong api|authentication/i.test(err)) return { kind: "no_credits", reason: "sin_acceso", detail: err || `HTTP ${r.status}` };
          const d = r.body?.debounce;
          if (!d || err) return { kind: "error", detail: err || `HTTP ${r.status}` };
          const [verdict, confidence] = DEBOUNCE[String(d.code ?? "")] ?? ["unknown", 0.3];
          return { kind: "verdict", verdict, confidence, raw: { code: d.code, result: d.result, reason: d.reason, free_email: d.free_email, role: d.role } };
        }
        return { kind: "error", detail: "DeBounce: límite de concurrencia" };
      });
    },
    async balance() {
      try {
        const r = await get(fetchImpl, `https://api.debounce.io/v1/balance/?api=${encodeURIComponent(key())}`, {}, 15_000);
        const n = Number(r.body?.balance);
        if (r.body?.debounce?.error || !Number.isFinite(n)) return { balance: null, error: String(r.body?.debounce?.error || `HTTP ${r.status}`) };
        return { balance: n, error: null };
      } catch (e: any) {
        return { balance: null, error: e?.message || String(e) };
      }
    },
  };
}

// ─── EmailListVerify ────────────────────────────────────────

const ELV: Record<string, [Verdict, number]> = {
  ok: ["valid", 0.95],
  fail: ["invalid", 0.95],
  invalid: ["invalid", 0.95],
  syntax_error: ["invalid", 0.98],
  email_disabled: ["invalid", 0.9],
  domain_error: ["invalid", 0.9],
  dead_server: ["invalid", 0.9],
  invalid_mx: ["invalid", 0.95],
  dns_error: ["invalid", 0.9],
  ok_for_all: ["catch_all", 0.5],
  accept_all: ["catch_all", 0.5],
  disposable: ["risky", 0.95],
  role: ["risky", 0.8],
  antispam_system: ["unknown", 0.3],
  attempt_rejected: ["unknown", 0.3],
  smtp_protocol: ["unknown", 0.3],
  relay_error: ["unknown", 0.3],
  unknown_email: ["unknown", 0.3],
  unknown: ["unknown", 0.3],
};

/** GET https://apps.emaillistverify.com/api/verifyEmail?secret=…&email=… → a plain status word; "error_credit" = no credits. */
export function elvVerifier(fetchImpl: FetchLike = fetch, key = () => process.env.EMAILLISTVERIFY_API_KEY || ""): Validator {
  const run = limiter(5);
  return {
    id: "emaillistverify",
    label: "EmailListVerify",
    configured: () => Boolean(key()),
    costUsd: () => num(process.env.EMAIL_COST_EMAILLISTVERIFY_USD, 0.0004),
    async verify(email) {
      return run(async () => {
        let r;
        try {
          r = await get(fetchImpl, `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(key())}&email=${encodeURIComponent(email)}`);
        } catch (e: any) {
          return { kind: "error", detail: e?.message || String(e) };
        }
        const word = String(r.text || "").trim().toLowerCase();
        if (word === "error_credit") return { kind: "no_credits", reason: "sin_creditos", detail: "error_credit" };
        const m = ELV[word];
        if (!m) return { kind: "error", detail: `respuesta no reconocida: ${word.slice(0, 80)}` };
        return { kind: "verdict", verdict: m[0], confidence: m[1], raw: { status: word } };
      });
    },
    async balance() {
      try {
        const r = await get(fetchImpl, `https://api.emaillistverify.com/api/credits?secret=${encodeURIComponent(key())}`, {}, 15_000);
        const n = Number(r.body?.onDemand?.available ?? 0) + Number(r.body?.subscription?.available ?? 0);
        if (r.status >= 400 || !Number.isFinite(n)) return { balance: null, error: `HTTP ${r.status}` };
        return { balance: n, error: null };
      } catch (e: any) {
        return { balance: null, error: e?.message || String(e) };
      }
    },
  };
}

export function defaultValidators(): Validator[] {
  return [findymailVerifier(), debounceVerifier(), elvVerifier()];
}

// ─── Server facts and evidence ──────────────────────────────

export interface ServerFacts {
  /** google_workspace | office365 | yahoo | other | null (no MX read) */
  mx_provider: string | null;
  /** mimecast | barracuda | sophos | null */
  mail_gateway: string | null;
  /** The domain accepts any address (domain intel or the verifier said catch_all). */
  domain_catch_all: boolean | null;
  /** Every send to this domain bounced (≥3, none landed): 45% of all bounces in the audit. */
  bad_domain: boolean;
  pattern: string | null;
  /** pattern_confirmed | pattern_mostly_ok | pattern_contradicted | null — this pattern's mail history here. */
  pattern_tier: string | null;
  /** This exact address in MailBridge outcomes. */
  address_status: "bounced" | "delivered" | "replied" | "pending" | null;
}

export async function serverFacts(email: string, first?: string | null, last?: string | null, linkedin?: string | null): Promise<ServerFacts> {
  const domain = email.split("@")[1] || "";
  const [info, outcomes] = await Promise.all([memo(`intel:${domain}`, () => analyzeDomain(domain)).catch(() => null), memo(`out:${domain}`, () => getDomainOutcomes(domain))]);
  const slug = linkedin ? normalizeLinkedIn(linkedin) : null;
  const pattern = derivePattern(email, first, last, slug);
  const gw = info ? mailGateway(info.mx_records || []) : null;
  return {
    mx_provider: info?.has_mx ? info.provider : null,
    mail_gateway: gw?.name ?? null,
    domain_catch_all: info ? info.is_catch_all : null,
    bad_domain: isBadMailDomain(outcomes),
    pattern,
    pattern_tier: pattern ? patternTier(outcomes.patterns.get(pattern)) : null,
    address_status: (outcomes.addresses.get(email)?.status as ServerFacts["address_status"]) ?? null,
  };
}

/** Per-domain reads, reused for 10 minutes: a list has many people per company. */
const memoStore = new Map<string, { at: number; p: Promise<any> }>();
function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.p;
  const p = fn();
  memoStore.set(key, { at: Date.now(), p });
  if (memoStore.size > 5000) memoStore.delete(memoStore.keys().next().value as string);
  p.catch(() => memoStore.delete(key));
  return p;
}

/**
 * Expected bounce for this verdict + facts, from the 2026-10-08 audit
 * (Clientes-Improvitz/infraestructura-outbound/rebotes-y-finder.md):
 * valid by an SMTP verifier 2.9–5.5%; catch_all by pattern 26.8%; catch_all on
 * Google Workspace 52%; pattern with ≥2 deliveries and no bounce 6.4%; a
 * pattern that bounced 50%; Mimecast 63%, Barracuda 32%.
 */
export const EXTRA_EVIDENCE = {
  catch_all_unconfirmed: { expected_bounce: 0.27, recommendation: "risky" },
  catch_all_google: { expected_bounce: 0.52, recommendation: "do_not_send" },
  bad_mail_domain: { expected_bounce: 0.9, recommendation: "do_not_send" },
  verdict_invalid: { expected_bounce: 0.95, recommendation: "do_not_send" },
  verdict_unknown: { expected_bounce: 0.35, recommendation: "risky" },
} as const satisfies Record<string, { expected_bounce: number; recommendation: SendRecommendation }>;

export function evidenceFor(verdict: Verdict, f: ServerFacts): { tier: string; expected_bounce: number; recommendation: SendRecommendation } {
  const pick = (tier: string, e: { expected_bounce: number; recommendation: SendRecommendation }) => ({ tier, expected_bounce: e.expected_bounce, recommendation: e.recommendation });
  let out;
  if (f.address_status === "bounced") out = pick("address_bounced", EVIDENCE.address_bounced);
  else if (f.address_status === "delivered" || f.address_status === "replied") out = pick("address_confirmed", EVIDENCE.address_confirmed);
  else if (verdict === "invalid") out = pick("verdict_invalid", EXTRA_EVIDENCE.verdict_invalid);
  else if (f.bad_domain) out = pick("bad_mail_domain", EXTRA_EVIDENCE.bad_mail_domain);
  else if (f.pattern_tier === "pattern_contradicted") out = pick("pattern_contradicted", EVIDENCE.pattern_contradicted);
  else if (verdict === "valid") out = pick("smtp_verified", EVIDENCE.smtp_verified);
  else if (f.pattern_tier === "pattern_confirmed") out = pick("pattern_confirmed", EVIDENCE.pattern_confirmed);
  else if (f.pattern_tier === "pattern_mostly_ok") out = pick("pattern_mostly_ok", EVIDENCE.pattern_mostly_ok);
  else if (verdict === "catch_all") out = f.mx_provider === "google_workspace" ? pick("catch_all_google", EXTRA_EVIDENCE.catch_all_google) : pick("catch_all_unconfirmed", EXTRA_EVIDENCE.catch_all_unconfirmed);
  else out = pick("verdict_unknown", EXTRA_EVIDENCE.verdict_unknown);
  // A gateway rejects cold mail by policy whatever the spelling: Mimecast 63%, Barracuda 32%.
  if (f.mail_gateway === "mimecast") out = { ...out, expected_bounce: Math.max(out.expected_bounce, 0.63), recommendation: "do_not_send" as SendRecommendation };
  else if (f.mail_gateway === "barracuda" && out.recommendation === "send") out = { ...out, expected_bounce: Math.max(out.expected_bounce, 0.32), recommendation: "risky" as SendRecommendation };
  return out;
}

// ─── Policy ─────────────────────────────────────────────────

export const POLICIES = ["strict", "moderate", "permissive"] as const;
export type Policy = (typeof POLICIES)[number];
export type Decision = { decision: "accept" | "discard" | "revalidate"; reason: string | null };

export function defaultPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const p = String(env.EMAIL_ACCEPT_POLICY || "").trim().toLowerCase();
  return (POLICIES as readonly string[]).includes(p) ? (p as Policy) : "moderate";
}

/**
 * The decision table (README → "Política de aceptación"):
 *
 * | verdict / evidence                         | strict     | moderate   | permissive |
 * |--------------------------------------------|------------|------------|------------|
 * | invalid                                    | descarta   | descarta   | descarta   |
 * | address bounced before                     | descarta   | descarta   | descarta   |
 * | valid                                      | pasa*      | pasa       | pasa       |
 * | catch_all + address/pattern confirmed      | pasa       | pasa       | pasa       |
 * | catch_all, no evidence either way          | descarta   | pasa       | pasa       |
 * | catch_all + bad domain / pattern bounced / Mimecast | descarta | descarta | pasa  |
 * | unknown                                    | revalidar  | revalidar  | pasa       |
 * | risky (disposable / role)                  | descarta   | revalidar  | pasa       |
 * (*) strict also discards a valid with negative evidence (bad domain, pattern bounced, Mimecast).
 */
export function decide(policy: Policy, verdict: Verdict, f: ServerFacts): Decision {
  if (verdict === "invalid") return { decision: "discard", reason: "invalido" };
  if (f.address_status === "bounced") return { decision: "discard", reason: "rebote_previo" };
  if (policy === "permissive") return { decision: "accept", reason: null };

  const negative = f.bad_domain ? "dominio_solo_rebotes" : f.pattern_tier === "pattern_contradicted" ? "patron_reboto" : f.mail_gateway === "mimecast" ? "gateway_mimecast" : null;
  const positive = f.address_status === "delivered" || f.address_status === "replied" || f.pattern_tier === "pattern_confirmed";

  if (verdict === "valid") {
    if (policy === "strict" && negative) return { decision: "discard", reason: negative };
    return { decision: "accept", reason: null };
  }
  if (verdict === "catch_all") {
    if (policy === "strict") return positive && !negative ? { decision: "accept", reason: null } : { decision: "discard", reason: negative ?? "catch_all_sin_evidencia" };
    return negative && !positive ? { decision: "discard", reason: `catch_all_${negative}` } : { decision: "accept", reason: null };
  }
  if (verdict === "risky" && policy === "strict") return { decision: "discard", reason: "riesgoso" };
  return { decision: "revalidate", reason: `sin_veredicto_${verdict}` };
}

// ─── Validate + qualify ─────────────────────────────────────

export interface FullVerification {
  provider: string | null;
  verdict: Verdict;
  checked_at: string;
  confidence: number | null;
}

export interface Qualification {
  verification: FullVerification;
  /** The validator's raw answer (email_validator_response). */
  validator_response: unknown;
  facts: ServerFacts;
  evidence: string;
  expected_bounce: number;
  send_recommendation: SendRecommendation;
  policy: Policy;
  decision: Decision["decision"];
  reason: string | null;
  cost_usd: number;
  /** True when a validator was actually called now. */
  validated_now: boolean;
}

export interface QualifyDeps {
  validators: Validator[];
  breaker: Breaker & { onValidatorTrip?: (id: string, next: string | null) => void };
  facts?: typeof serverFacts;
}

export function revalidateDays(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.EMAIL_REVALIDATE_DAYS, 30) || 30;
}

const CONCLUSIVE = new Set<Verdict>(["valid", "catch_all", "invalid", "risky"]);

/** A stored verdict good enough to reuse without paying: conclusive, by a real verifier, recent. */
export function reusableVerification(v: any, now = new Date()): FullVerification | null {
  if (!v || typeof v !== "object" || !v.provider || !CONCLUSIVE.has(v.verdict)) return null;
  const at = new Date(v.checked_at || 0);
  if (Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > revalidateDays() * 86_400_000) return null;
  return { provider: String(v.provider), verdict: v.verdict, checked_at: at.toISOString(), confidence: typeof v.confidence === "number" ? v.confidence : null };
}

/** Walk the validators (breaker-aware). Nobody available → unknown, provider null. */
export async function validate(email: string, deps: QualifyDeps): Promise<{ verification: FullVerification; raw: unknown; cost: number; called: boolean }> {
  for (const v of deps.validators) {
    if (!v.configured()) continue;
    if (await deps.breaker.isExhausted(v.id as any)) continue;
    const out = await v.verify(email).catch((e: any) => ({ kind: "error" as const, detail: String(e?.message || e) }));
    if (out.kind === "verdict") {
      return { verification: { provider: v.id === "findymail_verify" ? "findymail" : v.id, verdict: out.verdict, checked_at: new Date().toISOString(), confidence: out.confidence }, raw: out.raw, cost: v.costUsd(), called: true };
    }
    if (out.kind === "no_credits") {
      await deps.breaker.trip(v.id as any, out.reason, out.detail, {});
    }
    // error → the next validator tries.
  }
  return { verification: { provider: null, verdict: "unknown", checked_at: new Date().toISOString(), confidence: null }, raw: null, cost: 0, called: false };
}

export async function qualify(
  email: string,
  person: { first_name?: string | null; last_name?: string | null; linkedin_url?: string | null },
  prior: unknown,
  policy: Policy,
  deps: QualifyDeps
): Promise<Qualification> {
  const reuse = reusableVerification(prior);
  const [v, facts] = await Promise.all([
    reuse ? Promise.resolve({ verification: reuse, raw: (prior as any)?.raw ?? null, cost: 0, called: false }) : validate(email, deps),
    (deps.facts ?? serverFacts)(email, person.first_name, person.last_name, person.linkedin_url).catch(
      (): ServerFacts => ({ mx_provider: null, mail_gateway: null, domain_catch_all: null, bad_domain: false, pattern: null, pattern_tier: null, address_status: null })
    ),
  ]);
  if (v.verification.verdict === "catch_all") facts.domain_catch_all = true;
  const ev = evidenceFor(v.verification.verdict, facts);
  const d = decide(policy, v.verification.verdict, facts);
  return {
    verification: v.verification,
    validator_response: v.raw,
    facts,
    evidence: ev.tier,
    expected_bounce: ev.expected_bounce,
    send_recommendation: ev.recommendation,
    policy,
    decision: d.decision,
    reason: d.reason,
    cost_usd: v.cost,
    validated_now: v.called,
  };
}
