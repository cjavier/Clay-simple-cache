import prisma from "../../db/prisma";
import { normalizeEmail, normalizeLinkedIn } from "../normalization";
import { normalizeName } from "../../email-finder/permutator";
import { namePartsFromSlug } from "../../email-finder/identity";
import { getOutcomesForEmails } from "../../email-finder/outcomes";
import { ingestEntry, IngestProvenance, normalizeProvider, normalizeVerdict, ProvenanceEntry } from "../../email-finder/provenance";
import type { Qualification } from "./facts";
import { recordProvenance } from "../provenance.service";
import { bareDomain, CascadePerson } from "./blitz";

export interface EmailVerification {
  provider: string | null;
  verdict: "valid" | "invalid" | "catch_all" | "unknown" | "risky";
}

/**
 * The cache of profiles, read before anyone pays and written after anyone finds.
 *
 * Lookup: by LinkedIn (normalized to its slug) first; if that misses, by name
 * + domain among the addresses we hold at that domain. A hard-bounced address,
 * or one whose stored verdict is `invalid`, is not an answer.
 */

export interface CacheHit {
  found: true;
  email: string;
  email_source: string | null;
  email_verification: Record<string, unknown> | null;
  email_found_via: string | null;
  /** The last validator's raw answer, if stored. */
  validator_response?: unknown;
  profile_id: string;
  matched_by: "linkedin" | "name_domain";
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The person's identity in `email_attempts`: li:<slug>, or nd:<first>|<last>@<domain>. */
export function personKey(p: CascadePerson): string | null {
  const slug = p.linkedin_url ? normalizeLinkedIn(p.linkedin_url) : null;
  if (slug) return `li:${slug}`;
  const { first, last } = splitName(p);
  const domain = bareDomain(p.company_domain);
  if (first && last && domain) return `nd:${normalizeName(first)}|${normalizeName(last)}@${domain}`;
  return null;
}

/** first/last, from the fields or from full_name ("Ana María López Díaz" → Ana / López Díaz is not attempted: first token / rest). */
export function splitName(p: CascadePerson): { first: string; last: string } {
  let first = (p.first_name || "").trim();
  let last = (p.last_name || "").trim();
  if ((!first || !last) && p.full_name) {
    const parts = p.full_name.trim().split(/\s+/);
    if (!first) first = parts[0] || "";
    if (!last) last = parts.slice(1).join(" ");
  }
  return { first, last };
}

/**
 * Personal mailboxes are never a work email: a finder that returns one (Clay's
 * Wiza step gave cesar@gmx.ch for a CFO, 2026-10-09) matched another person or
 * a private inbox, so the cache does not hand it out.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es", "live.com", "live.com.mx",
  "msn.com", "yahoo.com", "yahoo.com.mx", "yahoo.es", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "gmx.com", "gmx.net", "gmx.de", "gmx.ch", "gmx.es", "web.de", "mail.com", "protonmail.com", "proton.me",
  "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "prodigy.net.mx", "infinitummail.com",
]);

export function isPersonalEmail(email: string | null | undefined): boolean {
  const domain = (email || "").trim().toLowerCase().split("@")[1] || "";
  return PERSONAL_DOMAINS.has(domain);
}

function usableCached(profile: { email: string | null; data: unknown }): boolean {
  if (!profile.email || isPersonalEmail(profile.email)) return false;
  const data = isObj(profile.data) ? profile.data : {};
  const verdict = isObj(data.email_verification) ? normalizeVerdict(data.email_verification.verdict) : null;
  return verdict !== "invalid";
}

function hit(profile: { id: string; email: string | null; data: unknown }, matched_by: CacheHit["matched_by"]): CacheHit {
  const data = isObj(profile.data) ? profile.data : {};
  return {
    found: true,
    email: String(profile.email).toLowerCase(),
    email_source: typeof data.email_source === "string" ? data.email_source : null,
    email_verification: isObj(data.email_verification) ? data.email_verification : null,
    email_found_via: typeof data.email_found_via === "string" ? data.email_found_via : null,
    validator_response: data.email_validator_response ?? null,
    profile_id: profile.id,
    matched_by,
  };
}

/** Same-person test on names, LATAM-aware: given name + any surname token (or the slug's parts). */
function samePerson(row: { first: string; last: string; slug: string | null }, first: string, last: string): boolean {
  const f = normalizeName(first.split(/\s+/)[0] || "");
  const wanted = new Set(last.split(/\s+/).map(normalizeName).filter(Boolean));
  if (!f || wanted.size === 0) return false;
  const slugParts = row.slug ? namePartsFromSlug(row.slug) : [];
  const rowFirst = normalizeName((row.first || "").split(/\s+/)[0] || "");
  if (rowFirst !== f && slugParts[0] !== f) return false;
  const rowNames = new Set([...(row.last || "").split(/\s+/).map(normalizeName), ...slugParts].filter(Boolean));
  for (const w of wanted) if (rowNames.has(w)) return true;
  return false;
}

/** Free: never calls a provider. */
export async function lookupCachedEmail(p: CascadePerson): Promise<CacheHit | null> {
  let candidate: CacheHit | null = null;

  const slug = p.linkedin_url ? normalizeLinkedIn(p.linkedin_url) : null;
  if (slug) {
    const prof = await prisma.profile.findUnique({ where: { linkedin_slug: slug }, select: { id: true, email: true, data: true } });
    if (prof && usableCached(prof)) candidate = hit(prof, "linkedin");
  }

  if (!candidate) {
    const { first, last } = splitName(p);
    const domain = bareDomain(p.company_domain);
    if (first && last && domain) {
      // Backed by profiles_email_domain_idx (split_part(lower(email),'@',2)).
      const rows = await prisma.$queryRaw<{ id: string; email: string; data: unknown; linkedin_slug: string | null }[]>`
        SELECT id, email, data, linkedin_slug
        FROM profiles
        WHERE split_part(lower(email), '@', 2) = ${domain}
        LIMIT 500
      `;
      for (const r of rows) {
        const d = isObj(r.data) ? r.data : {};
        if (!usableCached(r)) continue;
        if (samePerson({ first: String(d.first_name || ""), last: String(d.last_name || ""), slug: r.linkedin_slug }, first, last)) {
          candidate = hit(r, "name_domain");
          break;
        }
      }
    }
  }

  if (!candidate) return null;
  const outcome = (await getOutcomesForEmails([candidate.email])).get(candidate.email);
  if (outcome?.status === "bounced") return null;
  return candidate;
}

export interface FoundEmail {
  email: string;
  /** Provider that found it (blitzapi, or what a MailBridge column reported: prospeo, findymail…). */
  source: string;
  verification: EmailVerification | null;
}

/**
 * Store an address a provider just found, with its provenance, the way
 * POST /profiles would. Never throws: losing the cache write must not lose the row.
 */
/** What a validation adds to the profile's data (and to the row, see rows.ts). */
export function qualificationData(q: Qualification) {
  return {
    email_verification: { provider: q.verification.provider, verdict: q.verification.verdict, checked_at: q.verification.checked_at, confidence: q.verification.confidence },
    email_validator_response: q.validator_response ?? null,
    mx_provider: q.facts.mx_provider,
    mail_gateway: q.facts.mail_gateway,
    domain_catch_all: q.facts.domain_catch_all,
    email_evidence: q.evidence,
    expected_bounce: q.expected_bounce,
    send_recommendation: q.send_recommendation,
    ...(q.policy ? { email_policy: { policy: q.policy, decision: q.decision ?? null, reason: q.reason ?? null } } : {}),
  };
}

export async function saveFoundEmail(p: CascadePerson, found: FoundEmail, q?: Qualification, opts: { foundVia?: string } = {}): Promise<void> {
  const via = opts.foundVia || "clay_cache_cascade";
  try {
    const email = normalizeEmail(found.email);
    const slug = p.linkedin_url ? normalizeLinkedIn(p.linkedin_url) : null;
    const verdict = q?.verification.verdict ?? found.verification?.verdict ?? (found.source === "blitzapi" ? "valid" : "unknown");
    const prov: IngestProvenance = {
      finder: normalizeProvider(found.source) || "clay_cache",
      verifier: q ? q.verification.provider : found.verification ? found.verification.provider : found.source === "blitzapi" ? "blitzapi" : null,
      verdict,
      confidence: q?.verification.confidence ?? null,
      checked_at: q?.verification.checked_at ?? new Date().toISOString(),
    };
    const { first, last } = splitName(p);
    const data: Record<string, unknown> = {
      ...(first ? { first_name: first } : {}),
      ...(last ? { last_name: last } : {}),
      ...(p.full_name ? { full_name: p.full_name } : {}),
      ...(p.company_domain ? { company_domain: bareDomain(p.company_domain) } : {}),
      ...(p.company_name ? { company_name: p.company_name } : {}),
      ...(p.linkedin_url ? { linkedin_url: p.linkedin_url } : {}),
      email_source: prov.finder,
      email_verification: { provider: prov.verifier, verdict: prov.verdict, checked_at: prov.checked_at, confidence: prov.confidence },
      ...(q ? qualificationData(q) : {}),
    };

    const find = async () =>
      (await prisma.profile.findUnique({ where: { email } })) ??
      (slug ? await prisma.profile.findUnique({ where: { linkedin_slug: slug } }) : null);

    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await find();
      try {
        if (existing) {
          const updates: Record<string, unknown> = {};
          const old = existing.email ? existing.email.toLowerCase() : null;
          if (old !== email && old && verdict === "invalid") {
            // An invalid address never replaces the one the person already has: it is
            // remembered (so nobody treats it as new) and only the evidence travels.
            const rejected = [...new Set([...(((existing.data as any)?.rejected_emails as string[]) || []), email])];
            await prisma.profile.update({ where: { id: existing.id }, data: { data: { ...(existing.data as object), rejected_emails: rejected } } });
            break;
          }
          if (old !== email) {
            // Matched by LinkedIn and holding another address: that one was not usable
            // (bounced / invalid), or the cache would have answered and nobody would have paid.
            updates.email = email;
            if (old) data.previous_emails = [...new Set([...(((existing.data as any)?.previous_emails as string[]) || []), old])];
          }
          if (slug && !existing.linkedin_slug) updates.linkedin_slug = slug;
          if (p.linkedin_url && !existing.linkedin_url) updates.linkedin_url = p.linkedin_url;
          // Keep who found it first (e.g. Clay's function) when the address is the same.
          const keepVia = old === email && (existing.data as any)?.email_found_via;
          updates.data = { ...(existing.data as object), ...data, email_found_via: keepVia || via };
          await prisma.profile.update({ where: { id: existing.id }, data: updates });
        } else {
          await prisma.profile.create({ data: { email, linkedin_slug: slug, linkedin_url: p.linkedin_url || null, data: { ...data, email_found_via: via } as object } });
        }
        break;
      } catch (e: any) {
        if (e?.code !== "P2002" || attempt === 1) throw e;
      }
    }
    // Evidence for MailBridge (POST /email-evidence via the provenance outbox), with what the finder knew.
    const entry: ProvenanceEntry = ingestEntry(email, prov, Boolean(q));
    if (q) {
      entry.origin = "find";
      entry.method = "email_cascade";
      entry.meta = {
        send_recommendation: q.send_recommendation,
        evidence_tier: q.evidence,
        expected_bounce: q.expected_bounce,
        mail_gateway: q.facts.mail_gateway,
        mx_provider: q.facts.mx_provider,
        pattern: q.facts.pattern,
        searched_name: { first: splitName(p).first || null, last: splitName(p).last || null },
      };
    }
    void recordProvenance([entry]);
  } catch (e) {
    console.error("[email-cascade] no se pudo guardar en cache:", e);
  }
}
