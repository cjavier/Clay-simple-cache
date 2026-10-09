import prisma from "../db/prisma";
import { companyRow, currentExperience, normLi, personRow } from "./table-build";
import { tableJobService } from "./table-job.service";
import { rowRef, toUpsertRow } from "./table-rows";
import { Budget, CascadeDeps, CascadeResult, findEmailCascade } from "./email-cascade/cascade";
import { defaultBudgetUsd, defaultDeps } from "./email-cascade/pending";
import { applyCascade } from "./email-cascade/rows";
import { defaultPolicy, Policy } from "./email-cascade/verify";
import { blitzClient } from "./email-cascade/providers";

/**
 * The full list build, in the background: the whole TAM of a recipe, not a
 * sample. The skill (/create-table) calibrates the recipe interactively with
 * counts and a 100-company sample; once it's right, it hands the translated
 * Blitz filters here and walks away.
 *
 * Works in chunks of up to 50 companies (two pages of Blitz's company search):
 * people of those companies → their emails → rows queued for MailBridge. The
 * Blitz cursor and the counters are saved after every chunk, so a deploy only
 * repeats the chunk in flight — and repeating is harmless, because MailBridge
 * upserts each row by its LinkedIn.
 *
 * No cap of contacts per company (Javier, 2026-10-05).
 *
 * Emails go through the cascade (src/services/email-cascade): the cache of
 * profiles first (free, keeps the original email_source), then Blitz →
 * Prospeo → Findymail, capped by `email_budget_usd` per job. People a
 * provider couldn't look up (no credits, rate limit, budget) are `pendiente`,
 * not "no encontrado", and are retried later onto the same MailBridge row.
 */

export interface BuildConfig {
  company: Record<string, unknown>;
  people: Record<string, unknown>;
  /** Stop after this many companies (default: all, up to Blitz's 50k). */
  max_companies: number;
  find_emails: boolean;
  /** contacts/month × months, to judge coverage like the skill does. */
  needed?: number | null;
  /** USD cap for paid email finders in this job (default EMAIL_BUDGET_DEFAULT_USD, 20). */
  email_budget_usd?: number;
  /** Acceptance policy for found addresses: strict | moderate | permissive (default EMAIL_ACCEPT_POLICY, moderate). */
  email_policy?: Policy;
}

export interface BuildState {
  cursor?: string | null;
  companies_total?: number;
  people_total?: number;
  companies?: number;
  people?: number;
  emails_valid?: number;
  emails_searched?: number;
  chunks?: number;
  records_used?: number;
  /** Email cascade bookkeeping. */
  email_spend_usd?: number;
  emails_from_cache?: number;
  emails_by_source?: Record<string, number>;
  /** People without an email because a provider couldn't look (not "not found"). */
  emails_pending?: number;
  emails_pending_by_reason?: Record<string, number>;
  /** Found but discarded by the policy (invalid, catch-all with negative evidence…). */
  emails_discarded?: number;
  /** Found, awaiting a conclusive validation (unknown/risky under moderate). */
  emails_revalidate?: number;
  budget_exhausted?: boolean;
  started_at?: string;
  finished_at?: string;
}

const CHUNK_PAGES = 2;
const PAGE_SIZE = 25;
const EMAIL_CONCURRENCY = Number(process.env.BLITZ_EMAIL_CONCURRENCY || 20);
const STALE_AFTER_MS = 10 * 60 * 1000;
export const MAX_COMPANIES = 50_000;

const running = new Set<string>();

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function save(jobId: string, state: BuildState, extra: Record<string, unknown> = {}) {
  await prisma.tableJob.update({ where: { id: jobId }, data: { build_state: state as object, ...extra } });
}

export const tableBuildService = {
  start(jobId: string) {
    if (running.has(jobId)) return;
    running.add(jobId);
    void run(jobId)
      .catch((e) => console.error(`[table-build] ${jobId} crashed:`, e))
      .finally(() => running.delete(jobId));
  },

  /** On boot: builds a deploy interrupted pick up from their last saved chunk. */
  async resume(): Promise<number> {
    const stale = await prisma.tableJob.findMany({
      where: { build_status: { in: ["queued", "running"] }, updated_at: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      select: { id: true },
    });
    // Right after a deploy nothing is stale yet; look again once the window has passed.
    setTimeout(() => void tableBuildService.resume().catch(() => undefined), STALE_AFTER_MS + 30_000).unref();
    for (const j of stale) this.start(j.id);
    return stale.length;
  },
};

/** Exported for tests; production goes through tableBuildService.start(). */
export async function run(jobId: string, deps?: CascadeDeps): Promise<void> {
  const job = await prisma.tableJob.findUnique({ where: { id: jobId } });
  if (!job || !job.build || !["queued", "running"].includes(job.build_status || "")) return;
  const cfg = job.build as unknown as BuildConfig;
  const state: BuildState = { ...(job.build_state as BuildState) };
  const baseRecords = state.records_used || 0;

  try {
    const bz = await blitzClient();
    const cascade = deps ?? defaultDeps();
    const peopleTable = ((job.tables as any)?.people?.table_id as string) || null;
    const budget = new Budget(cfg.email_budget_usd ?? defaultBudgetUsd(), state.email_spend_usd || 0);
    const before = bz.recordsUsed;
    const used = () => baseRecords + (bz.recordsUsed - before);

    if (state.companies_total === undefined) {
      state.companies_total = await bz.countCompanies(cfg.company);
      state.people_total = await bz.countPeople(cfg.company, cfg.people);
      state.started_at = new Date().toISOString();
      Object.assign(state, { companies: 0, people: 0, emails_valid: 0, emails_searched: 0, chunks: 0, cursor: null });
    }
    await save(jobId, { ...state, records_used: used() }, { build_status: "running", build_error: null });

    for (;;) {
      const room = cfg.max_companies - (state.companies || 0);
      if (room <= 0) break;

      // 1. Up to 50 companies.
      let cursor = state.cursor ?? null;
      const page: any[] = [];
      for (let i = 0; i < CHUNK_PAGES && page.length < room; i++) {
        const r = await bz.companiesPage(cfg.company, Math.min(PAGE_SIZE, room - page.length), cursor);
        page.push(...r.results);
        cursor = r.cursor;
        if (!cursor || r.results.length === 0) break;
      }
      const companies = new Map<string, any>();
      for (const c of page) {
        const li = normLi(c?.linkedin_url);
        if (!companies.has(li)) companies.set(li, c);
      }

      // 2. Their people, matched to a company of this chunk.
      const lis = [...companies.keys()].filter(Boolean);
      const urls = lis.map((li) => companies.get(li).linkedin_url);
      const found = urls.length ? await bz.allPeople({ linkedin_url: urls }, cfg.people) : [];
      const lotSet = new Set(lis);
      const seen = new Set<string>();
      const people: Array<{ p: any; exp: any; companyLi: string }> = [];
      for (const p of found) {
        const li = normLi(p?.linkedin_url);
        if (!li || seen.has(li)) continue;
        seen.add(li);
        const exp = currentExperience(p, lotSet);
        people.push({ p, exp, companyLi: normLi(exp?.company_linkedin_url) });
      }

      // 3. Emails: cache → Blitz → Prospeo → Findymail (misses cost nothing; finds count against the budget).
      const results: Array<CascadeResult | { error: string } | null> = cfg.find_emails
        ? await mapPool(people, EMAIL_CONCURRENCY, async ({ p, exp, companyLi }) => {
            const c = companies.get(companyLi) || {};
            try {
              return await findEmailCascade(
                {
                  linkedin_url: p.linkedin_url,
                  first_name: p.first_name,
                  last_name: p.last_name,
                  full_name: p.full_name,
                  company_domain: c.domain || exp?.company_domain,
                  company_name: c.name || exp?.company_name,
                },
                cascade,
                { budget, policy: cfg.email_policy, ctx: { job_id: jobId, mb_table_id: peopleTable, row_ref: p.linkedin_url ? rowRef("people", { linkedin_url: p.linkedin_url }) : null } }
              );
            } catch (e: any) {
              return { error: e?.message || String(e) };
            }
          })
        : people.map(() => null);
      for (const r of results) {
        if (!r || "error" in r) continue;
        if (r.found) {
          state.emails_by_source = { ...state.emails_by_source, [r.email_source]: (state.emails_by_source?.[r.email_source] || 0) + 1 };
          if (r.from_cache) state.emails_from_cache = (state.emails_from_cache || 0) + 1;
        } else if (r.candidate) {
          const k = r.candidate.qualification.decision === "revalidate" ? "emails_revalidate" : "emails_discarded";
          state[k] = (state[k] || 0) + 1;
        } else if (r.pending.length) {
          state.emails_pending = (state.emails_pending || 0) + 1;
          const reasons = { ...state.emails_pending_by_reason };
          for (const reason of new Set(r.pending.map((x) => x.reason))) reasons[reason] = (reasons[reason] || 0) + 1;
          state.emails_pending_by_reason = reasons;
        }
      }

      // 4. Rows → MailBridge (through the same queue as POST /tables/:id/rows).
      const perCompany = new Map<string, [number, number]>();
      const personRows = people.map(({ p, exp, companyLi }, i) => {
        const r = results[i];
        let row = personRow(p, exp, companies.get(companyLi) || {}, r && "error" in r ? { found: false, error: r.error } : null);
        if (r && !("error" in r)) row = applyCascade(row, r);
        const s = perCompany.get(companyLi) || [0, 0];
        s[0] += 1;
        if (row.email) s[1] += 1;
        perCompany.set(companyLi, s);
        return row;
      });
      const companyRows = [...companies.entries()].map(([li, c]) => {
        const [n, withEmail] = perCompany.get(li) || [0, 0];
        return companyRow(c, n, withEmail);
      });
      if (companyRows.length) {
        await tableJobService.enqueue(jobId, "companies", companyRows.map((r, i) => toUpsertRow("companies", r, i)));
      }
      if (personRows.length) {
        await tableJobService.enqueue(jobId, "people", personRows.map((r, i) => toUpsertRow("people", r, i)));
      }

      state.cursor = cursor;
      state.chunks = (state.chunks || 0) + 1;
      state.companies = (state.companies || 0) + companies.size;
      state.people = (state.people || 0) + people.length;
      state.emails_searched = (state.emails_searched || 0) + (cfg.find_emails ? people.length : 0);
      state.emails_valid = (state.emails_valid || 0) + personRows.filter((r) => r.email).length;
      state.records_used = used();
      state.email_spend_usd = budget.spentUsd;
      state.budget_exhausted = budget.exhausted || undefined;
      await save(jobId, state);

      if (!cursor || page.length === 0) break;
    }

    state.finished_at = new Date().toISOString();
    await save(jobId, state, { build_status: "done" });
  } catch (err: any) {
    state.records_used = state.records_used ?? baseRecords;
    await save(jobId, state, { build_status: "failed", build_error: String(err?.message || err).slice(0, 1000) });
  }
}

/** What GET /tables/:id shows about the build, including the coverage verdict. */
export function buildSummary(status: string | null, state: BuildState, cfg: BuildConfig | null, error: string | null) {
  if (!status) return null;
  const rate = state.emails_searched ? (state.emails_valid || 0) / state.emails_searched : null;
  const reachable = rate !== null && state.people_total !== undefined ? Math.round(state.people_total * rate) : null;
  const needed = cfg?.needed ?? null;
  return {
    status,
    error,
    tam: { companies: state.companies_total ?? null, people: state.people_total ?? null },
    progress: {
      companies: state.companies || 0,
      people: state.people || 0,
      emails_valid: state.emails_valid || 0,
      chunks: state.chunks || 0,
      target_companies: cfg ? Math.min(cfg.max_companies, state.companies_total ?? cfg.max_companies) : null,
    },
    coverage: rate === null
      ? null
      : {
          email_rate: Math.round(rate * 1000) / 1000,
          reachable_estimate: reachable,
          needed,
          verdict: needed && reachable !== null
            ? reachable >= needed * 3 ? "HOLGADO" : reachable >= needed ? "AJUSTADO" : "INSUFICIENTE"
            : null,
        },
    records_used: state.records_used || 0,
    emails: cfg?.find_emails === false
      ? null
      : {
          budget_usd: cfg?.email_budget_usd ?? defaultBudgetUsd(),
          spent_usd: state.email_spend_usd || 0,
          budget_exhausted: Boolean(state.budget_exhausted),
          from_cache: state.emails_from_cache || 0,
          by_source: state.emails_by_source || {},
          // People with no email because a provider couldn't look; they are retried, unlike "no encontrado".
          pending: { persons: state.emails_pending || 0, by_reason: state.emails_pending_by_reason || {} },
          policy: cfg?.email_policy ?? defaultPolicy(),
          discarded: state.emails_discarded || 0,
          awaiting_revalidation: state.emails_revalidate || 0,
        },
    started_at: state.started_at ?? null,
    finished_at: state.finished_at ?? null,
  };
}
