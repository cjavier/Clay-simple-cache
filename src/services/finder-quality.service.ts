import prisma from "../db/prisma";
import { normalizeName, identifyPatternForSurnames } from "../email-finder/permutator";
import { resolveIdentity } from "../email-finder/identity";
import { namePartsFromSlug } from "../email-finder/identity";

/**
 * Score what the finder actually got right, not how much of it it did.
 *
 * `GET /stats` reported `success_rate = valid / total_searches`. That number
 * says nothing about whether the address was correct, and it hid the gap that
 * mattered: over four weeks the `valid` verdict matched the address another
 * provider found for the same person 95.2% of the time, while `catch_all` — a
 * third of everything we answered — matched 33.3%. Both were counted as wins.
 *
 * Two independent measurements here:
 *
 *  - **agreement**: for answers where `profiles` independently holds an address
 *    for the same person at the same domain, does ours match? Split by verdict,
 *    because the two verdicts are not remotely equal.
 *  - **delivery**: does the address we returned exist in `profiles` at all?
 *    Answers under 30s landed 99.3% of the time and answers over an hour 29.4%,
 *    so this is a direct read on whether callers are still listening.
 */

export interface QualityReport {
  window_days: number;
  sampled: number;
  by_status: Record<
    string,
    {
      answered: number;
      comparable: number;
      agreed: number;
      agreement_rate: number | null;
      delivered: number;
      delivery_rate: number;
    }
  >;
  latency: { p50_ms: number | null; p90_ms: number | null; over_2min_pct: number | null };
  volume: { searches: number; api_calls: number; cost_usd: number };
}

interface AnswerRow {
  first_name: string | null;
  last_name: string | null;
  domain: string | null;
  result_email: string;
  result_status: string;
}

export async function scoreRecentAnswers(
  windowDays: number = 7,
  sampleSize: number = 2000
): Promise<QualityReport> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const answers = await prisma.$queryRaw<AnswerRow[]>`
    SELECT first_name, last_name, domain, lower(result_email) AS result_email, result_status
    FROM search_log
    WHERE created_at >= ${since}
      AND result_email IS NOT NULL
      AND result_status IN ('valid', 'catch_all')
    ORDER BY created_at DESC
    LIMIT ${sampleSize}
  `;

  const domains = [...new Set(answers.map((a) => a.domain).filter(Boolean))] as string[];
  const known = await loadKnownByDomain(domains);

  const by_status: QualityReport["by_status"] = {};
  const bump = (status: string) =>
    (by_status[status] ||= {
      answered: 0,
      comparable: 0,
      agreed: 0,
      agreement_rate: null,
      delivered: 0,
      delivery_rate: 0,
    });

  for (const a of answers) {
    const bucket = bump(a.result_status);
    bucket.answered++;

    const rows = (a.domain && known.get(a.domain)) || [];
    if (rows.some((r) => r.email === a.result_email)) bucket.delivered++;

    // An independent address for this person: one we did NOT produce ourselves.
    const identity = resolveIdentity({
      first_name: a.first_name || undefined,
      last_name: a.last_name || undefined,
    });
    const theirs = findIndependentAddress(rows, identity.first, identity.surnames);
    if (!theirs) continue;

    bucket.comparable++;
    if (theirs === a.result_email) bucket.agreed++;
  }

  for (const bucket of Object.values(by_status)) {
    bucket.agreement_rate =
      bucket.comparable > 0 ? bucket.agreed / bucket.comparable : null;
    bucket.delivery_rate =
      bucket.answered > 0 ? bucket.delivered / bucket.answered : 0;
  }

  const [latency, volume] = await Promise.all([latencyStats(since), volumeStats(since)]);

  return { window_days: windowDays, sampled: answers.length, by_status, latency, volume };
}

/**
 * Write today's numbers down.
 *
 * `scoreRecentAnswers` reads a rolling window, so once the window slides the
 * number is gone. Answering "did the change work?" in a month needs the figure
 * recorded on the day it was true — the same reason `provider_credits` keeps
 * history instead of a single current-state row. Keyed on
 * (measured_on, window_days, status) so re-running a day overwrites rather than
 * duplicating.
 */
export async function persistQualityReport(report: QualityReport): Promise<void> {
  const measuredOn = new Date();
  measuredOn.setUTCHours(0, 0, 0, 0);

  const rows = [
    ...Object.entries(report.by_status).map(([status, b]) => ({
      status,
      answered: b.answered,
      comparable: b.comparable,
      agreed: b.agreed,
      agreement_rate: b.agreement_rate,
      delivered: b.delivered,
      delivery_rate: b.delivery_rate,
      searches: 0,
      api_calls: 0,
      cost_usd: 0,
      p50_ms: null as number | null,
      p90_ms: null as number | null,
      raw: {} as object,
    })),
    // One `_overall` row carries the figures that aren't per-verdict, so a
    // single query can chart cost-per-search and latency over time.
    {
      status: "_overall",
      answered: report.sampled,
      comparable: 0,
      agreed: 0,
      agreement_rate: null,
      delivered: 0,
      delivery_rate: null,
      searches: report.volume.searches,
      api_calls: report.volume.api_calls,
      cost_usd: report.volume.cost_usd,
      p50_ms: report.latency.p50_ms,
      p90_ms: report.latency.p90_ms,
      raw: { over_2min_pct: report.latency.over_2min_pct } as object,
    },
  ];

  for (const row of rows) {
    try {
      await prisma.finderMetric.upsert({
        where: {
          measured_on_window_days_status: {
            measured_on: measuredOn,
            window_days: report.window_days,
            status: row.status,
          },
        },
        update: { ...row, created_at: new Date() },
        create: {
          measured_on: measuredOn,
          window_days: report.window_days,
          ...row,
        },
      });
    } catch (e) {
      console.error(`persistQualityReport(${row.status}) failed:`, e);
    }
  }
}

async function volumeStats(since: Date) {
  try {
    const [row] = await prisma.$queryRaw<
      { searches: number; api_calls: number; cost_usd: number }[]
    >`
      SELECT count(*)::int AS searches,
             COALESCE(sum(api_calls_made), 0)::int AS api_calls,
             COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
      FROM search_log
      WHERE created_at >= ${since}
    `;
    return row || { searches: 0, api_calls: 0, cost_usd: 0 };
  } catch {
    return { searches: 0, api_calls: 0, cost_usd: 0 };
  }
}

interface KnownRow {
  email: string;
  first: string;
  last: string;
  slug_parts: string[];
}

async function loadKnownByDomain(domains: string[]): Promise<Map<string, KnownRow[]>> {
  const out = new Map<string, KnownRow[]>();
  if (domains.length === 0) return out;

  const CHUNK = 200;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const chunk = domains.slice(i, i + CHUNK);
    const rows = await prisma.$queryRaw<
      {
        dom: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        linkedin_slug: string | null;
      }[]
    >`
      SELECT split_part(lower(email), '@', 2) AS dom,
             lower(email) AS email,
             data->>'first_name' AS first_name,
             data->>'last_name'  AS last_name,
             linkedin_slug
      FROM profiles
      WHERE split_part(lower(email), '@', 2) = ANY(${chunk}::text[])
    `;
    for (const r of rows) {
      const list = out.get(r.dom) || [];
      list.push({
        email: r.email,
        first: r.first_name || "",
        last: r.last_name || "",
        slug_parts: r.linkedin_slug ? namePartsFromSlug(r.linkedin_slug) : [],
      });
      out.set(r.dom, list);
    }
  }

  return out;
}

/** The address `profiles` holds for this person, whoever put it there. */
function findIndependentAddress(
  rows: KnownRow[],
  first: string,
  surnames: string[]
): string | null {
  const f = normalizeName(first);
  if (!f) return null;
  const wanted = new Set(
    surnames.flatMap((s) => s.split(/\s+/).map(normalizeName)).filter(Boolean)
  );

  for (const row of rows) {
    const rowFirst = normalizeName((row.first || "").split(/\s+/)[0]);
    const slugFirst = row.slug_parts[0] || "";
    if (rowFirst !== f && slugFirst !== f) continue;

    const names = new Set(
      [...(row.last || "").split(/\s+/).map(normalizeName), ...row.slug_parts].filter(Boolean)
    );
    for (const w of wanted) {
      if (names.has(w)) return row.email;
    }
  }
  return null;
}

async function latencyStats(since: Date) {
  try {
    const [row] = await prisma.$queryRaw<
      { p50: number | null; p90: number | null; slow: number; total: number }[]
    >`
      SELECT
        percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
        percentile_disc(0.9) WITHIN GROUP (ORDER BY duration_ms)::int AS p90,
        count(*) FILTER (WHERE duration_ms > 120000)::int AS slow,
        count(*)::int AS total
      FROM search_log
      WHERE created_at >= ${since}
    `;
    if (!row || !row.total) return { p50_ms: null, p90_ms: null, over_2min_pct: null };
    return {
      p50_ms: row.p50,
      p90_ms: row.p90,
      over_2min_pct: row.slow / row.total,
    };
  } catch {
    return { p50_ms: null, p90_ms: null, over_2min_pct: null };
  }
}

/** Kept exported so the alert job and the stats endpoint agree on the maths. */
export { identifyPatternForSurnames };
