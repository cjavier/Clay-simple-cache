import prisma from "../db/prisma";
import { identifyPatternForSurnames } from "./permutator";
import { resolveIdentity, slugFromLinkedIn } from "./identity";

/**
 * What actually happened when an address was mailed.
 *
 * Until October 2026 the finder graded itself against `profiles` — "does
 * another provider agree with us?" — and never saw a bounce. Crossing 122,784
 * sent addresses from MailBridge against this service (2026-10-08) showed what
 * that hid:
 *
 *  - `profiles` held 10,954 addresses that had already bounced, and the finder
 *    served them back as `known_email` at 0.95 confidence: 70 of the 92
 *    `known_email` bounces had bounced before the search ran.
 *  - `catch_all` answered from the domain pattern bounced 25–32%, and 52% on
 *    Google Workspace. DeBounce and EmailListVerify cannot help there: on a
 *    240-address sample of Google "catch-all" domains both answered accept-all
 *    for 116 of 120 addresses that bounced and 115 of 120 that were delivered.
 *  - What *does* separate them is our own history at the same domain. On
 *    Google catch-all domains an address whose pattern had already been
 *    delivered twice with no bounce bounced 6.4%; one whose pattern had bounced
 *    at least as often as it was delivered bounced 50%.
 *
 * So this module is the ground truth, and the evidence ladder below is what the
 * finder uses to pick a pattern and to tell the caller whether to send.
 *
 * Signals (all reported by MailBridge, see `ingestOutcomes`):
 *  - **bounced**: a hard bounce. A soft bounce (mailbox full, greylisted) is
 *    not evidence the mailbox is missing, so it is ignored here.
 *  - **replied**: a human reply, a positive reply, or an out-of-office. Any of
 *    them proves the mailbox exists. MailBridge's raw `replied_at` is NOT used:
 *    it includes threads classified `missed_bounce`.
 *  - **delivered**: sent from a mailbox whose bounces we can see, at least
 *    `DELIVERED_AFTER_HOURS` ago, and no bounce since. Maildoso mailboxes filter
 *    their bounces before MailBridge sees them, so a Maildoso send is never
 *    evidence of delivery — only a reply is.
 */

export const DELIVERED_AFTER_HOURS = 72;

export type OutcomeStatus = "bounced" | "replied" | "delivered" | "pending";

export interface OutcomeRowInput {
  source: string;
  source_ref: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  linkedin_url?: string | null;
  bounced_at?: string | Date | null;
  bounce_type?: string | null;
  replied_at?: string | Date | null;
  positive_at?: string | Date | null;
  auto_replied?: boolean | null;
  first_visible_send_at?: string | Date | null;
}

export interface EmailOutcomeSummary {
  email: string;
  status: OutcomeStatus;
  pattern: string | null;
  first_name: string | null;
  last_name: string | null;
  linkedin_slug: string | null;
  positive: boolean;
}

interface StoredRow {
  email: string;
  pattern: string | null;
  first_name: string | null;
  last_name: string | null;
  linkedin_slug: string | null;
  bounced_at: Date | null;
  bounce_type: string | null;
  replied_at: Date | null;
  positive_at: Date | null;
  auto_replied: boolean;
  first_visible_send_at: Date | null;
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isHard(bounceType: string | null): boolean {
  return (bounceType || "hard").toLowerCase() !== "soft";
}

/**
 * Collapse every report about one address into a single verdict.
 *
 * MailBridge keeps one contact per client, so the same address can be reported
 * several times. The latest decisive event wins: someone who replied in May and
 * hard-bounced in September has left the company.
 */
export function summarize(rows: StoredRow[], now: Date = new Date()): EmailOutcomeSummary | null {
  if (rows.length === 0) return null;
  const latest = (pick: (r: StoredRow) => Date | null) =>
    rows.reduce<Date | null>((acc, r) => {
      const d = pick(r);
      return d && (!acc || d > acc) ? d : acc;
    }, null);

  const hardBounce = latest((r) => (r.bounced_at && isHard(r.bounce_type) ? r.bounced_at : null));
  const reply = latest((r) => r.replied_at || r.positive_at);
  const autoReplied = rows.some((r) => r.auto_replied);
  const firstVisibleSend = rows.reduce<Date | null>((acc, r) => {
    const d = r.first_visible_send_at;
    return d && (!acc || d < acc) ? d : acc;
  }, null);

  let status: OutcomeStatus = "pending";
  if (hardBounce && (!reply || hardBounce > reply)) status = "bounced";
  else if (reply || autoReplied) status = "replied";
  else if (
    firstVisibleSend &&
    now.getTime() - firstVisibleSend.getTime() >= DELIVERED_AFTER_HOURS * 3600 * 1000
  )
    status = "delivered";

  const named = rows.find((r) => r.first_name || r.linkedin_slug) || rows[0];
  return {
    email: rows[0].email,
    status,
    pattern: rows.find((r) => r.pattern)?.pattern ?? null,
    first_name: named.first_name,
    last_name: named.last_name,
    linkedin_slug: named.linkedin_slug,
    positive: rows.some((r) => r.positive_at),
  };
}

/** The mailbox convention this address follows, read off the person's name. */
export function derivePattern(
  email: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  linkedinSlug: string | null | undefined
): string | null {
  const identity = resolveIdentity({
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    linkedin_slug: linkedinSlug || undefined,
  });
  if (!identity.first || identity.surnames.length === 0) return null;
  return identifyPatternForSurnames(email, identity.first, identity.surnames);
}

/**
 * Upsert a batch of reports. Idempotent: the same report twice, or out of
 * order, leaves the row exactly as the latest report describes it — MailBridge
 * sends the contact's current state, not a delta.
 *
 * Written as one `INSERT … SELECT unnest(…)` per chunk rather than a Prisma
 * upsert per row: the history backfill is ~200k rows, and a round trip each
 * to the pooled Supabase connection would take the better part of an hour.
 */
export async function ingestOutcomes(
  rows: OutcomeRowInput[],
  chunkSize: number = 1000
): Promise<{ upserted: number; skipped: number }> {
  let skipped = 0;
  const prepared: {
    source: string; source_ref: string; email: string; domain: string;
    first_name: string | null; last_name: string | null; linkedin_slug: string | null;
    pattern: string | null; bounced_at: string | null; bounce_type: string | null;
    replied_at: string | null; positive_at: string | null; auto_replied: boolean;
    first_visible_send_at: string | null;
  }[] = [];

  // Last report wins within a batch too, so a chunk never carries the same key twice
  // (Postgres refuses ON CONFLICT DO UPDATE touching one row twice in a statement).
  const byKey = new Map<string, OutcomeRowInput>();
  for (const row of rows) byKey.set(`${row.source}\u0000${row.source_ref}`, row);

  for (const row of byKey.values()) {
    const email = (row.email || "").trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (!row.source || !row.source_ref || at < 1 || at === email.length - 1) {
      skipped++;
      continue;
    }
    const slug = row.linkedin_url ? slugFromLinkedIn(row.linkedin_url) : null;
    const iso = (v: string | Date | null | undefined) => toDate(v)?.toISOString() ?? null;
    prepared.push({
      source: row.source,
      source_ref: String(row.source_ref),
      email,
      domain: email.slice(at + 1),
      first_name: row.first_name || null,
      last_name: row.last_name || null,
      linkedin_slug: slug,
      pattern: derivePattern(email, row.first_name, row.last_name, slug),
      bounced_at: iso(row.bounced_at),
      bounce_type: row.bounce_type || null,
      replied_at: iso(row.replied_at),
      positive_at: iso(row.positive_at),
      auto_replied: !!row.auto_replied,
      first_visible_send_at: iso(row.first_visible_send_at),
    });
  }

  for (let i = 0; i < prepared.length; i += chunkSize) {
    const c = prepared.slice(i, i + chunkSize);
    const col = <K extends keyof (typeof c)[number]>(k: K) => c.map((r) => r[k]);
    await prisma.$executeRaw`
      INSERT INTO email_outcomes (source, source_ref, email, domain, first_name, last_name,
        linkedin_slug, pattern, bounced_at, bounce_type, replied_at, positive_at,
        auto_replied, first_visible_send_at, updated_at)
      SELECT u.source, u.source_ref, u.email, u.domain, u.first_name, u.last_name,
        u.linkedin_slug, u.pattern, u.bounced_at, u.bounce_type, u.replied_at, u.positive_at,
        u.auto_replied, u.first_visible_send_at, now()
      FROM unnest(
        ${col("source")}::text[], ${col("source_ref")}::text[], ${col("email")}::text[],
        ${col("domain")}::text[], ${col("first_name")}::text[], ${col("last_name")}::text[],
        ${col("linkedin_slug")}::text[], ${col("pattern")}::text[],
        ${col("bounced_at")}::timestamptz[], ${col("bounce_type")}::text[],
        ${col("replied_at")}::timestamptz[], ${col("positive_at")}::timestamptz[],
        ${col("auto_replied")}::boolean[], ${col("first_visible_send_at")}::timestamptz[]
      ) AS u(source, source_ref, email, domain, first_name, last_name, linkedin_slug, pattern,
             bounced_at, bounce_type, replied_at, positive_at, auto_replied, first_visible_send_at)
      ON CONFLICT (source, source_ref) DO UPDATE SET
        email = EXCLUDED.email, domain = EXCLUDED.domain,
        first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
        linkedin_slug = EXCLUDED.linkedin_slug, pattern = EXCLUDED.pattern,
        bounced_at = EXCLUDED.bounced_at, bounce_type = EXCLUDED.bounce_type,
        replied_at = EXCLUDED.replied_at, positive_at = EXCLUDED.positive_at,
        auto_replied = EXCLUDED.auto_replied,
        first_visible_send_at = EXCLUDED.first_visible_send_at,
        updated_at = now()
    `;
  }
  return { upserted: prepared.length, skipped };
}

const SELECT_FIELDS = {
  email: true,
  pattern: true,
  first_name: true,
  last_name: true,
  linkedin_slug: true,
  bounced_at: true,
  bounce_type: true,
  replied_at: true,
  positive_at: true,
  auto_replied: true,
  first_visible_send_at: true,
} as const;

function groupByEmail(rows: StoredRow[], now: Date): Map<string, EmailOutcomeSummary> {
  const grouped = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.email) || [];
    list.push(r);
    grouped.set(r.email, list);
  }
  const out = new Map<string, EmailOutcomeSummary>();
  for (const [email, list] of grouped) {
    const s = summarize(list, now);
    if (s) out.set(email, s);
  }
  return out;
}

/** Verdicts for specific addresses. Never throws: no evidence is a valid answer. */
export async function getOutcomesForEmails(emails: string[]): Promise<Map<string, EmailOutcomeSummary>> {
  if (emails.length === 0) return new Map();
  try {
    const rows = await prisma.emailOutcome.findMany({
      where: { email: { in: emails.map((e) => e.toLowerCase()) } },
      select: SELECT_FIELDS,
    });
    return groupByEmail(rows as StoredRow[], new Date());
  } catch {
    return new Map();
  }
}

export interface PatternOutcome {
  /** Delivered or replied at this domain with this pattern. */
  ok: number;
  /** Hard-bounced at this domain with this pattern. */
  bad: number;
}

export interface DomainOutcomes {
  addresses: Map<string, EmailOutcomeSummary>;
  patterns: Map<string, PatternOutcome>;
  ok: number;
  bounced: number;
}

export const EMPTY_DOMAIN_OUTCOMES: DomainOutcomes = {
  addresses: new Map(),
  patterns: new Map(),
  ok: 0,
  bounced: 0,
};

export function buildDomainOutcomes(addresses: Map<string, EmailOutcomeSummary>): DomainOutcomes {
  const patterns = new Map<string, PatternOutcome>();
  let ok = 0;
  let bounced = 0;
  for (const s of addresses.values()) {
    if (s.status === "pending") continue;
    const good = s.status === "replied" || s.status === "delivered";
    if (good) ok++;
    else bounced++;
    if (!s.pattern) continue;
    const p = patterns.get(s.pattern) || { ok: 0, bad: 0 };
    if (good) p.ok++;
    else p.bad++;
    patterns.set(s.pattern, p);
  }
  return { addresses, patterns, ok, bounced };
}

/** Everything we know about how this domain's mail behaved. One indexed query. */
export async function getDomainOutcomes(domain: string, limit: number = 2000): Promise<DomainOutcomes> {
  try {
    const rows = await prisma.emailOutcome.findMany({
      where: { domain },
      select: SELECT_FIELDS,
      take: limit,
    });
    return buildDomainOutcomes(groupByEmail(rows as StoredRow[], new Date()));
  } catch {
    return EMPTY_DOMAIN_OUTCOMES;
  }
}

// ─── The evidence ladder ────────────────────────────────────────────────────

export type SendRecommendation = "send" | "risky" | "do_not_send";

/**
 * Evidence tiers, from strongest to weakest, with the bounce rate each one
 * showed on catch-all domains in the 2026-10-08 audit. The recommendation is
 * derived from that measured rate: under ~7% send, under ~25% risky, else don't.
 */
export const EVIDENCE = {
  /** This exact address was delivered or answered. */
  address_confirmed: { expected_bounce: 0.01, recommendation: "send" },
  /** Verified by an SMTP provider on a domain that answers SMTP honestly. 3–5%. */
  smtp_verified: { expected_bounce: 0.04, recommendation: "send" },
  /**
   * Already in `profiles` for this person and never bounced. 8.5% before
   * bounced addresses were filtered out; 2% of what remains after.
   */
  known_address: { expected_bounce: 0.03, recommendation: "send" },
  /** ≥2 deliveries with this pattern at this domain, no bounce. 2–6%. */
  pattern_confirmed: { expected_bounce: 0.05, recommendation: "send" },
  /** More deliveries than bounces with this pattern. 4–17%. */
  pattern_mostly_ok: { expected_bounce: 0.14, recommendation: "risky" },
  /** No mail history, but ≥10 addresses in profiles follow this pattern. 14–18%. */
  profiles_strong: { expected_bounce: 0.16, recommendation: "risky" },
  /** 3–9 addresses in profiles. 22–25%. */
  profiles_moderate: { expected_bounce: 0.23, recommendation: "risky" },
  /** 1–2 addresses in profiles, or a SERP glimpse. 35%. */
  profiles_weak: { expected_bounce: 0.35, recommendation: "do_not_send" },
  /** Nothing tells this spelling apart from any other. 49%. */
  no_evidence: { expected_bounce: 0.49, recommendation: "do_not_send" },
  /** This pattern bounced at least as often as it was delivered here. 50–70%. */
  pattern_contradicted: { expected_bounce: 0.6, recommendation: "do_not_send" },
  /** This exact address hard-bounced. */
  address_bounced: { expected_bounce: 1, recommendation: "do_not_send" },
} as const satisfies Record<string, { expected_bounce: number; recommendation: SendRecommendation }>;

export type EvidenceTier = keyof typeof EVIDENCE;

/** Where a pattern stands on this domain's mail history alone. */
export function patternTier(stats: PatternOutcome | undefined): EvidenceTier | null {
  if (!stats) return null;
  if (stats.bad >= 1 && stats.bad >= stats.ok) return "pattern_contradicted";
  if (stats.ok >= 2 && stats.bad === 0) return "pattern_confirmed";
  if (stats.ok > stats.bad) return "pattern_mostly_ok";
  return null;
}

/** Tier for a guess backed only by how many `profiles` addresses share the pattern. */
export function profilesTier(sampleCount: number): EvidenceTier {
  if (sampleCount >= 10) return "profiles_strong";
  if (sampleCount >= 3) return "profiles_moderate";
  if (sampleCount >= 1) return "profiles_weak";
  return "no_evidence";
}

export interface RankedPattern {
  pattern: string;
  tier: EvidenceTier;
}

const TIER_ORDER: EvidenceTier[] = [
  "pattern_confirmed",
  "pattern_mostly_ok",
  "profiles_strong",
  "profiles_moderate",
  "profiles_weak",
  "no_evidence",
  "pattern_contradicted",
];

/**
 * Order the domain's candidate patterns by how safe they are to send, so the
 * guess on a catch-all domain uses the pattern mail history supports, not the
 * one `profiles` happens to hold most of — `profiles` was the source of the
 * contamination this whole module exists to correct.
 */
export function rankPatterns(
  profilePatterns: { pattern: string; sample_count: number }[],
  outcomes: DomainOutcomes
): RankedPattern[] {
  const tiers = new Map<string, EvidenceTier>();
  for (const [pattern, stats] of outcomes.patterns) {
    const t = patternTier(stats);
    if (t) tiers.set(pattern, t);
  }
  for (const p of profilePatterns) {
    if (!tiers.has(p.pattern)) tiers.set(p.pattern, profilesTier(p.sample_count));
  }
  const samples = new Map(profilePatterns.map((p) => [p.pattern, p.sample_count]));
  const okOf = (p: string) => outcomes.patterns.get(p)?.ok ?? 0;
  return [...tiers.entries()]
    .map(([pattern, tier]) => ({ pattern, tier }))
    .sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
        okOf(b.pattern) - okOf(a.pattern) ||
        (samples.get(b.pattern) ?? 0) - (samples.get(a.pattern) ?? 0)
    );
}

// ─── Mail gateways ──────────────────────────────────────────────────────────

/**
 * Security gateways in front of the recipient's mailbox. Measured bounce rate
 * across all sends in the audit: Mimecast 63% (257 of 329 domains bounced at
 * least once), Barracuda 32%, Sophos 26%; against 7% for Google and 9% for
 * Office 365. Most of that is policy rejection of cold mail rather than a wrong
 * address, so no spelling fixes it — the caller should know before sending.
 */
const GATEWAYS: { match: RegExp; name: string; recommendation: SendRecommendation }[] = [
  { match: /mimecast/i, name: "mimecast", recommendation: "do_not_send" },
  { match: /barracuda/i, name: "barracuda", recommendation: "risky" },
  { match: /sophos/i, name: "sophos", recommendation: "risky" },
];

export function mailGateway(
  mxRecords: string[]
): { name: string; recommendation: SendRecommendation } | null {
  for (const g of GATEWAYS) {
    if (mxRecords.some((mx) => g.match.test(mx))) return { name: g.name, recommendation: g.recommendation };
  }
  return null;
}

const RANK: Record<SendRecommendation, number> = { send: 0, risky: 1, do_not_send: 2 };

/** The more cautious of two recommendations. */
export function stricter(a: SendRecommendation, b: SendRecommendation): SendRecommendation {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * A domain whose mail keeps coming back and never lands is not this person's
 * mail domain: `lear.net`, `backus.com`, `hyatt.net` are a website or a legacy
 * domain, and 45% of all bounces in the audit came from domains where every
 * single send bounced. No spelling can fix that, so the finder refuses up front.
 */
export const BAD_DOMAIN_MIN_BOUNCES = 3;

export function isBadMailDomain(outcomes: DomainOutcomes): boolean {
  return outcomes.ok === 0 && outcomes.bounced >= BAD_DOMAIN_MIN_BOUNCES;
}
