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

/**
 * What this cache knows about an address WITHOUT paying anyone: the
 * recipient's server (MX provider, security gateway, catch-all — DNS +
 * domain intel) and this domain's real mail history (bounces/deliveries per
 * pattern, from MailBridge outcomes). Served free at POST /emails/facts.
 *
 * The paid search and validation of emails moved to MailBridge's people
 * tables (spec 109 there: one column per step, cost recorded per provider).
 * MailBridge asks this module for the facts, applies the acceptance policy
 * and sends back each email and verdict (POST /emails/results).
 */

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
 * | catch_all + bad domain / pattern bounced  | descarta   | descarta   | pasa       |
 * | unknown                                    | revalidar  | revalidar  | pasa       |
 * | risky (disposable / role)                  | descarta   | revalidar  | pasa       |
 * (*) strict also discards a valid with negative evidence (bad domain, pattern bounced).
 */
export function decide(policy: Policy, verdict: Verdict, f: ServerFacts): Decision {
  if (verdict === "invalid") return { decision: "discard", reason: "invalido" };
  if (f.address_status === "bounced") return { decision: "discard", reason: "rebote_previo" };
  if (policy === "permissive") return { decision: "accept", reason: null };

  // Mimecast is no longer negative evidence (Javier, 2026-10-09): it stays in
  // mail_gateway and send_recommendation, but it does not discard. Same rule as
  // MailBridge's decideEmail().
  const negative = f.bad_domain ? "dominio_solo_rebotes" : f.pattern_tier === "pattern_contradicted" ? "patron_reboto" : null;
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

// ─── Verifications ───────────────────────────────────────────

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
  /** The policy MailBridge applied, when it sends one. */
  policy?: Policy | null;
  decision?: Decision["decision"] | null;
  reason?: string | null;
}

/** Days a conclusive verdict is reused without paying another validation (MailBridge uses the same 30). */
export const REVALIDATE_DAYS = 30;

const CONCLUSIVE = new Set<Verdict>(["valid", "catch_all", "invalid", "risky"]);

/** A stored verdict good enough to reuse without paying: conclusive, by a real verifier, recent. */
export function reusableVerification(v: any, now = new Date()): FullVerification | null {
  if (!v || typeof v !== "object" || !v.provider || !CONCLUSIVE.has(v.verdict)) return null;
  const at = new Date(v.checked_at || 0);
  if (Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > REVALIDATE_DAYS * 86_400_000) return null;
  return { provider: String(v.provider), verdict: v.verdict, checked_at: at.toISOString(), confidence: typeof v.confidence === "number" ? v.confidence : null };
}


export const EMPTY_FACTS: ServerFacts = {
  mx_provider: null,
  mail_gateway: null,
  domain_catch_all: null,
  bad_domain: false,
  pattern: null,
  pattern_tier: null,
  address_status: null,
};
