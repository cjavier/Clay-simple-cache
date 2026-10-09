import type { CascadeResult } from "./cascade";
import type { Qualification } from "./verify";

/**
 * What the cascade puts in a people row for MailBridge (canonical names; see
 * table-rows.ts for the headers). An accepted address goes in `email` with
 * its source and full verification; a discarded one, or one awaiting a
 * conclusive validation, only in `email_found`, with the reason in
 * `discard_reason` — as the build always did for junk.
 */

/**
 * Who verified a found address, as a row's `email_verification`. Blitz rows
 * without a validation keep today's shape (none: their "valido" is the
 * `valid` verdict); any other source without a verdict says `unknown`.
 */
export function rowVerification(r: Extract<CascadeResult, { found: true }>): Record<string, unknown> | null {
  const v = r.email_verification as Record<string, unknown> | null;
  if (v && typeof v === "object" && v.verdict) {
    return {
      provider: v.provider ?? null,
      verdict: v.verdict,
      ...(v.checked_at ? { checked_at: v.checked_at } : {}),
      ...(typeof v.confidence === "number" ? { confidence: v.confidence } : {}),
    };
  }
  return r.email_source === "blitzapi" ? null : { provider: null, verdict: "unknown" };
}

/** Server facts and evidence as flat row fields. */
export function qualificationFields(q: Qualification | undefined): Record<string, unknown> {
  if (!q) return {};
  return {
    email_validator_response: q.validator_response == null ? undefined : typeof q.validator_response === "string" ? q.validator_response : JSON.stringify(q.validator_response),
    mx_provider: q.facts.mx_provider ?? undefined,
    mail_gateway: q.facts.mail_gateway ?? undefined,
    domain_catch_all: q.facts.domain_catch_all === null ? undefined : q.facts.domain_catch_all ? "si" : "no",
    email_evidence: q.evidence,
    expected_bounce: q.expected_bounce,
    send_recommendation: q.send_recommendation,
    email_policy: `${q.policy}:${q.decision}`,
  };
}

export function cascadeRowFields(r: CascadeResult): Record<string, unknown> {
  if (r.found) {
    const v = rowVerification(r);
    return {
      email: r.email,
      email_source: r.email_source,
      email_status: "valido",
      email_found: r.email,
      ...(v ? { email_verification: v } : {}),
      ...qualificationFields(r.qualification),
    };
  }
  const pendingReason = r.pending.map((x) => `${x.provider}:${x.reason}`).join(";");
  if (r.candidate) {
    const q = r.candidate.qualification;
    const awaiting = q.decision === "revalidate";
    return {
      email_found: r.candidate.email,
      email_source: r.candidate.email_source,
      email_status: awaiting ? "pendiente" : "descartado",
      discard_reason: [q.reason, awaiting ? "" : pendingReason].filter(Boolean).join(";"),
      // Flat: the row carries no `email`, so the verdict travels as plain columns.
      email_verifier: q.verification.provider ?? undefined,
      email_verdict: q.verification.verdict,
      email_checked_at: q.verification.checked_at,
      email_confidence: q.verification.confidence ?? undefined,
      ...qualificationFields(q),
    };
  }
  if (r.pending.length) return { email_status: "pendiente", discard_reason: pendingReason };
  return { email_status: "no_encontrado" };
}

/** Apply the cascade's fields to a people row (drops empties; recomputes domain_match). */
export function applyCascade(row: Record<string, unknown>, r: CascadeResult): Record<string, unknown> {
  for (const k of ["email", "email_source", "email_status", "email_found", "discard_reason", "domain_match", "other_emails"]) delete row[k];
  for (const [k, v] of Object.entries(cascadeRowFields(r))) if (v !== undefined && v !== null && v !== "") row[k] = v;
  const found = String(row.email_found || "");
  const companyDomain = String(row.domain || "").toLowerCase();
  if (found.includes("@")) row.domain_match = companyDomain && found.split("@")[1].toLowerCase().endsWith(companyDomain) ? "si" : "no";
  return row;
}
