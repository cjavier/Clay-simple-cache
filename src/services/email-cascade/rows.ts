import type { CacheHit } from "./cache";
import { decide, EMPTY_FACTS, reusableVerification } from "./facts";

/**
 * What the list build puts in a people row about the email (canonical names;
 * see table-rows.ts for the headers). The build only reads the cache and asks
 * Blitz (free); everything paid happens in MailBridge's columns afterwards:
 *
 * - cache hit with a conclusive verdict of ≤30 days that the moderate policy
 *   accepts → `email`, with its ORIGINAL source and verification;
 * - cache hit without one → only `email_found`, status `pendiente`
 *   (`sin_verificar`): MailBridge's "Cache (Clay)" column finds it for free and
 *   "Verificación" validates it;
 * - Blitz hit → `email` (Blitz verifies; legacy "valido"), as always;
 * - nothing → `no_encontrado`: MailBridge's Prospeo / Findymail columns search.
 */
export type BuildEmail =
  | { kind: "cache"; hit: CacheHit }
  | { kind: "blitz"; email: string; all_emails: string[] }
  | { kind: "none" }
  | { kind: "error"; error: string };

export function cacheHitAccepted(hit: CacheHit, now = new Date()): boolean {
  const v = reusableVerification(hit.email_verification, now);
  return Boolean(v && decide("moderate", v.verdict, EMPTY_FACTS).decision === "accept");
}

/** Row fields for a cache hit (Blitz and misses go through personRow as before). */
export function cacheRowFields(hit: CacheHit, now = new Date()): Record<string, unknown> {
  const accepted = cacheHitAccepted(hit, now);
  const v = hit.email_verification as Record<string, unknown> | null;
  return {
    ...(accepted ? { email: hit.email } : {}),
    email_found: hit.email,
    email_source: hit.email_source || "clay_cache",
    email_status: accepted ? "valido" : "pendiente",
    ...(accepted ? {} : { discard_reason: "sin_verificar" }),
    ...(v && v.verdict ? { email_verification: { provider: v.provider ?? null, verdict: v.verdict, ...(v.checked_at ? { checked_at: v.checked_at } : {}) } } : {}),
  };
}

/** Apply a cache hit to a people row (drops the empty email fields personRow left). */
export function applyCacheHit(row: Record<string, unknown>, hit: CacheHit, now = new Date()): Record<string, unknown> {
  for (const k of ["email", "email_source", "email_status", "email_found", "discard_reason", "domain_match", "other_emails", "email_verification"]) delete row[k];
  Object.assign(row, cacheRowFields(hit, now));
  const companyDomain = String(row.domain || "").toLowerCase();
  row.domain_match = companyDomain && hit.email.split("@")[1].toLowerCase().endsWith(companyDomain) ? "si" : "no";
  return row;
}
