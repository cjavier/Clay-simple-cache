import crypto from "crypto";
import { EmailStatus, VerificationMethod, VerificationResult } from "./types";

/**
 * Where an email address came from and who vouched for it.
 *
 * The cache used to keep one `method` per answer, which mixed two different
 * questions: WHO FOUND the address (a finder: Blitz, Findymail, this cache
 * spelling a name by pattern, a SERP hit) and WHO VERIFIED it (a verifier:
 * EmailListVerify, DeBounce…). MailBridge grades both against real bounces
 * (spec 104), and it can only do that if each fact arrives with its own
 * provider. This module is the single definition of that split:
 *
 *  - `finder`    provider that produced the address ('clay_cache' when this
 *                service guessed it from a name and a pattern).
 *  - `verifier`  provider whose probe gave the verdict; null when nobody probed
 *                (pattern guess, answered from `profiles`, caller-asserted).
 *  - `verdict`   the five-value vocabulary MailBridge stores. The raw status
 *                (`disposable`, `no_mx`, `role_account`…) is kept alongside.
 *  - `method`    the decision path, kept for debugging; no longer the provider.
 */

/** Same pattern MailBridge enforces on `provider`. */
export const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{1,59}$/;

export const VERDICTS = ["valid", "invalid", "catch_all", "unknown", "risky"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What this service calls itself as a finder (pattern guesses). */
export const SELF_FINDER = "clay_cache";

/** Verification methods that are real third-party probes, i.e. a `verifier`. */
const PROVIDER_METHODS = new Set<string>([
  VerificationMethod.emaillistverify,
  VerificationMethod.debounce,
  VerificationMethod.bouncer,
  VerificationMethod.neverbounce,
]);

/** Methods that never describe a new fact about an address: refusals, local checks, echoes of MailBridge. */
const NO_FACT_METHODS = new Set<string>([
  VerificationMethod.local_syntax,
  VerificationMethod.local_dns,
  VerificationMethod.domain_muted,
  VerificationMethod.domain_bounces,
  VerificationMethod.mailbridge_outcome,
  VerificationMethod.known_email,
]);

/** Raw statuses (ours and the providers' vocabularies) → the five verdicts. */
const VERDICT_ALIASES: Record<string, Verdict> = {
  valid: "valid",
  invalid: "invalid",
  catch_all: "catch_all",
  unknown: "unknown",
  risky: "risky",
  // This service's own extra statuses (same mapping MailBridge applies to `clay_cache`).
  disposable: "risky",
  no_mx: "invalid",
  role_account: "risky",
  // Common provider spellings a caller may forward as-is.
  safe: "valid",
  safe_to_send: "valid",
  deliverable: "valid",
  ok: "valid",
  valido: "valid",
  undeliverable: "invalid",
  bounce: "invalid",
  accept_all: "catch_all",
  ok_for_all: "catch_all",
};

const slug = (v: unknown): string =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** The verdict for a raw status, or null when we don't know the word (callers decide: reject or 'unknown'). */
export function normalizeVerdict(raw: unknown): Verdict | null {
  return VERDICT_ALIASES[slug(raw)] ?? null;
}

/** Providers are slugs: lowercase, digits, `_ . -`. Returns the normalized id or null. */
export function normalizeProvider(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().toLowerCase();
  return PROVIDER_RE.test(p) ? p : null;
}

export interface Provenance {
  /** Provider that produced the address; null when unknown (e.g. /verify of a bare address). */
  finder: string | null;
  /** Provider whose probe gave the verdict; null when nobody probed. */
  verifier: string | null;
  verdict: Verdict;
  /** The status as the pipeline or the caller said it, before normalizing. */
  raw_status: string | null;
  confidence: number | null;
  /** The decision path (domain_pattern, known_email…). Not a provider. */
  method: string | null;
  checked_at: string;
}

export interface ProvenanceContext {
  op: "find" | "verify";
  /** Provider recorded when the address was ingested (known_email answers), if any. */
  profileSource?: string | null;
  /** When the cache row we answered from was written, for answers that cost nothing now. */
  cachedAt?: Date | null;
  now?: Date;
}

/** Is this answer a NEW fact (worth recording and pushing), or an echo of one already recorded? */
export function isFreshFact(result: Pick<VerificationResult, "email" | "method" | "cost_usd">): boolean {
  if (!result.email || !result.method) return false;
  if (NO_FACT_METHODS.has(result.method)) return false;
  if (PROVIDER_METHODS.has(result.method)) return (result.cost_usd ?? 0) > 0;
  // domain_pattern / serp_pattern: a fresh guess each time.
  return true;
}

/**
 * The provenance of one /find or /verify answer, derived from what the
 * pipeline returned. Pure: the pipeline is not touched.
 */
export function deriveProvenance(result: VerificationResult, ctx: ProvenanceContext): Provenance {
  const now = ctx.now ?? new Date();
  const method = result.method ?? null;
  const verifier = method && PROVIDER_METHODS.has(method) ? method : null;

  let finder: string | null = null;
  if (result.email) {
    if (method === VerificationMethod.known_email) {
      finder = normalizeProvider(ctx.profileSource) ?? (ctx.op === "find" ? SELF_FINDER : null);
    } else if (ctx.op === "find") {
      finder = result.serp_info?.direct_match === result.email ? "serper" : SELF_FINDER;
    }
  }

  const fresh = isFreshFact(result);
  const checked = fresh ? now : (ctx.cachedAt ?? now);

  return {
    finder,
    verifier,
    verdict: normalizeVerdict(result.status) ?? "unknown",
    raw_status: result.status ?? null,
    confidence: typeof result.confidence === "number" ? result.confidence : null,
    method,
    checked_at: checked.toISOString(),
  };
}

/** The fields every response carries. Spread into the JSON the controllers send. */
export function provenanceFields(result: Partial<VerificationResult>) {
  return {
    finder: result.finder ?? null,
    verifier: result.verifier ?? null,
    verdict: result.verdict ?? null,
    checked_at: result.checked_at ?? null,
    // Set when MailBridge saw this address hard-bounce: verdict is `invalid` whatever any cache says.
    hard_bounced: result.method === VerificationMethod.mailbridge_outcome && result.status === EmailStatus.invalid,
  };
}

// ─── Mandatory provenance on ingest ──────────────────────────────────────────

export interface IngestProvenance {
  finder: string;
  verifier: string | null;
  verdict: Verdict;
  confidence: number | null;
  checked_at: string;
}

export type IngestCheck =
  | { ok: true; provenance: IngestProvenance }
  | { ok: false; missing: string[]; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate the provenance a caller sends along with an email.
 *
 * Accepts the nested form (`email_verification: {provider, verdict, ...}`) and a
 * flat one (`email_verifier`, `email_verdict`, `email_checked_at`,
 * `email_confidence`) because Clay HTTP columns are easier to fill flat.
 * `verdict` is always required — an address nobody verified says
 * `"verdict": "unknown"` explicitly; silence is not an answer.
 */
export function validateIngestProvenance(body: Record<string, unknown>): IngestCheck {
  const problems: string[] = [];
  const missing: string[] = [];

  const finder = normalizeProvider(body.email_source);
  if (body.email_source === undefined || body.email_source === null || body.email_source === "") {
    missing.push("email_source");
  } else if (!finder) {
    problems.push(`email_source '${String(body.email_source)}' is not a provider id (lowercase letters, digits, _ . -; 2-60 chars; e.g. "findymail", "blitzapi", "clay_cache")`);
  }

  const nested = isObj(body.email_verification) ? body.email_verification : null;
  if (body.email_verification !== undefined && body.email_verification !== null && !nested) {
    problems.push("email_verification must be an object: {provider|null, verdict, checked_at?, confidence?}");
  }
  const verdictRaw = nested ? nested.verdict : body.email_verdict;
  const providerRaw = nested ? nested.provider : body.email_verifier;
  const checkedRaw = nested ? nested.checked_at : body.email_checked_at;
  const confidenceRaw = nested ? nested.confidence : body.email_confidence;

  let verdict: Verdict | null = null;
  if (verdictRaw === undefined || verdictRaw === null || verdictRaw === "") {
    missing.push("email_verification.verdict");
  } else {
    verdict = normalizeVerdict(verdictRaw);
    if (!verdict) problems.push(`email_verification.verdict '${String(verdictRaw)}' is not one of ${VERDICTS.join(" | ")}`);
  }

  let verifier: string | null = null;
  if (providerRaw !== undefined && providerRaw !== null && providerRaw !== "") {
    verifier = normalizeProvider(providerRaw);
    if (!verifier) problems.push(`email_verification.provider '${String(providerRaw)}' is not a provider id (or send null when nobody verified it)`);
  }

  let checkedAt = new Date();
  if (checkedRaw !== undefined && checkedRaw !== null && checkedRaw !== "") {
    const d = new Date(String(checkedRaw));
    if (Number.isNaN(d.getTime())) problems.push(`email_verification.checked_at '${String(checkedRaw)}' is not a date (ISO 8601)`);
    else checkedAt = d;
  }

  let confidence: number | null = null;
  if (confidenceRaw !== undefined && confidenceRaw !== null && confidenceRaw !== "") {
    const c = Number(confidenceRaw);
    if (!Number.isFinite(c) || c < 0 || c > 1) problems.push("email_verification.confidence must be a number between 0 and 1");
    else confidence = c;
  }

  if (missing.length === 0 && problems.length === 0) {
    return {
      ok: true,
      provenance: {
        finder: finder as string,
        verifier,
        verdict: verdict as Verdict,
        confidence,
        checked_at: checkedAt.toISOString(),
      },
    };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
  parts.push(...problems);
  return {
    ok: false,
    missing,
    message:
      `A payload with an email must say where it came from and who verified it (${parts.join("; ")}). ` +
      `Send "email_source": "<provider that found it>" and "email_verification": {"provider": "<verifier>" | null, "verdict": "valid|invalid|catch_all|unknown|risky"}. ` +
      `Use "verdict": "unknown" when it was never verified. See /docs/api#provenance.`,
  };
}

/** Enforcement mode. Default `warn`: accept, but say what would be rejected. `PROVENANCE_ENFORCE=true` rejects with 400. */
export function provenanceEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|enforce)$/i.test((env.PROVENANCE_ENFORCE || "").trim());
}

// ─── History rows ────────────────────────────────────────────────────────────

export type ProvenanceOrigin = "find" | "verify" | "ingest" | "backfill_search" | "backfill_cache";

export interface ProvenanceEntry {
  id: string;
  email: string;
  finder: string | null;
  verifier: string | null;
  verdict: Verdict;
  raw_status: string | null;
  confidence: number | null;
  method: string | null;
  origin: ProvenanceOrigin;
  checked_at: string;
  /** What the finder knew; becomes the evidence row's `raw` on MailBridge. */
  meta?: ProvenanceMeta | null;
}

/**
 * The finder's own read of an address, for MailBridge's bounce-risk score
 * (spec 105 reads exactly these keys from `raw`). Null when not known.
 */
export interface ProvenanceMeta {
  send_recommendation: "send" | "risky" | "do_not_send" | null;
  evidence_tier: string | null;
  expected_bounce: number | null;
  mail_gateway: string | null;
  mx_provider: string | null;
  pattern: string | null;
  searched_name: { first: string | null; last: string | null } | null;
}

/** Build the meta of a pipeline answer. `null` when the answer carries none of it. */
export function metaFromResult(
  r: VerificationResult,
  request?: { first_name?: string; last_name?: string; full_name?: string } | null
): ProvenanceMeta | null {
  const first = request?.first_name?.trim() || null;
  const last = request?.last_name?.trim() || null;
  const searched = first || last ? { first, last } : request?.full_name?.trim() ? { first: request.full_name.trim(), last: null } : null;
  const meta: ProvenanceMeta = {
    send_recommendation: r.send_recommendation ?? null,
    evidence_tier: r.evidence ?? null,
    expected_bounce: typeof r.expected_bounce === "number" ? r.expected_bounce : null,
    mail_gateway: r.mail_gateway ?? null,
    mx_provider: r.domain_info?.provider ?? null,
    pattern: r.pattern ?? null,
    searched_name: searched,
  };
  return Object.values(meta).some((v) => v !== null) ? meta : null;
}

/** A stable uuid from a string: re-posting the same claim must not create a second fact. */
export function deterministicId(seed: string): string {
  const h = crypto.createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The id of an ingest fact: same email + finder + verifier + verdict (+ date when the caller gave one). */
export function ingestEntry(email: string, p: IngestProvenance, checkedAtGiven: boolean): ProvenanceEntry {
  const seed = [email, p.finder, p.verifier ?? "", p.verdict, checkedAtGiven ? p.checked_at : ""].join("|");
  return {
    id: deterministicId(`ingest|${seed}`),
    email,
    finder: p.finder,
    verifier: p.verifier,
    verdict: p.verdict,
    raw_status: p.verdict,
    confidence: p.confidence,
    method: "ingest",
    origin: "ingest",
    checked_at: p.checked_at,
  };
}

/** Map a stored (method, status) pair to finder/verifier the way the live path does — used by the backfill. */
export function legacyProvenance(
  origin: "backfill_search" | "backfill_cache",
  method: string | null,
  status: string | null
): Pick<ProvenanceEntry, "finder" | "verifier" | "verdict" | "raw_status" | "method"> {
  const verifier = method && PROVIDER_METHODS.has(method) ? method : null;
  return {
    // A search_log row is a /find: this service spelled the address. A cache row is a bare verification: finder unknown,
    // except pattern guesses, which are ours.
    finder: origin === "backfill_search" ? SELF_FINDER : method === VerificationMethod.domain_pattern ? SELF_FINDER : null,
    verifier,
    verdict: normalizeVerdict(status) ?? "unknown",
    raw_status: status,
    method,
  };
}

// ─── MailBridge evidence rows ────────────────────────────────────────────────

export interface EvidenceRow {
  email: string;
  kind: "found" | "verified";
  provider: string;
  verdict?: Verdict;
  confidence?: number;
  sourceRef: string;
  occurredAt: string;
  raw?: unknown;
}

/**
 * One history entry → the rows MailBridge's POST /email-evidence takes.
 *
 * `found` is the finder's claim, `verified` the verifier's. When nobody verified,
 * the verdict rides on the `found` row (it is the finder's own claim). The
 * source refs are stable: `ccache:find:<id>` / `ccache:verify:<id>`, so sending
 * the same fact twice never duplicates it on the MailBridge side.
 */
export function toEvidenceRows(e: ProvenanceEntry): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const stem = e.origin === "verify" || e.origin === "backfill_cache" ? "verify" : e.origin === "ingest" ? "ingest" : "find";
  const raw = { status: e.raw_status, method: e.method, ...(e.meta ?? {}) };
  // MailBridge reads confidence as "chance this address lands": the finder's
  // measured bounce rate for its evidence beats a provider's self-reported score.
  const eb = e.meta?.expected_bounce;
  const confidence = typeof eb === "number" ? Math.round((1 - eb) * 1000) / 1000 : e.confidence;
  if (e.finder && PROVIDER_RE.test(e.finder)) {
    rows.push({
      email: e.email,
      kind: "found",
      provider: e.finder,
      ...(e.verifier ? {} : { verdict: e.verdict, ...(confidence !== null ? { confidence } : {}) }),
      sourceRef: `ccache:${stem}:${e.id}`,
      occurredAt: e.checked_at,
      raw,
    });
  }
  if (e.verifier && PROVIDER_RE.test(e.verifier)) {
    rows.push({
      email: e.email,
      kind: "verified",
      provider: e.verifier,
      verdict: e.verdict,
      ...(confidence !== null ? { confidence } : {}),
      sourceRef: `ccache:verify:${e.id}`,
      occurredAt: e.checked_at,
      raw,
    });
  }
  return rows;
}

const INGEST_FIELDS = ["email_source", "email_verification", "email_verifier", "email_verdict", "email_checked_at", "email_confidence"] as const;

/** Pull the provenance fields out of a payload; what is left is the profile's own data. */
export function splitIngestFields(body: Record<string, unknown>): { fields: Record<string, unknown>; rest: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if ((INGEST_FIELDS as readonly string[]).includes(k)) fields[k] = v;
    else rest[k] = v;
  }
  return { fields, rest };
}

/** True when the caller dated the verification itself (it then belongs to the fact's identity). */
export function callerGaveDate(fields: Record<string, unknown>): boolean {
  const nested = isObj(fields.email_verification) ? fields.email_verification.checked_at : undefined;
  const v = nested ?? fields.email_checked_at;
  return v !== undefined && v !== null && v !== "";
}

/** What gets stored in the profile's `data` for a valid ingest. */
export function storedProvenance(p: IngestProvenance) {
  return {
    email_source: p.finder,
    email_verification: { provider: p.verifier, verdict: p.verdict, checked_at: p.checked_at, confidence: p.confidence },
  };
}
