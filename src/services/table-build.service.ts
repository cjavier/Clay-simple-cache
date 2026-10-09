import prisma from "../db/prisma";
import { companyRow, currentExperience, normLi, personRow } from "./table-build";
import { tableJobService } from "./table-job.service";
import { rowRef, toUpsertRow } from "./table-rows";
import { CacheHit, lookupCachedEmail, saveFoundEmail } from "./email-cascade/cache";
import { applyCacheHit, BuildEmail, cacheHitAccepted } from "./email-cascade/rows";
import { blitzClient, CascadePerson, usable } from "./email-cascade/blitz";

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
 * Emails: only what costs nothing. The cache of profiles first (keeps the
 * original email_source), then Blitz (flat plan). Nothing paid runs here: the
 * people the build leaves without an email are searched and verified by the
 * email-cascade columns of the MailBridge table (Cache (Clay) → Prospeo →
 * Findymail → Verificación → Email), where each provider's cost is recorded
 * (Javier, 2026-10-09; MailBridge spec 109).
 */

export interface BuildConfig {
  company: Record<string, unknown>;
  people: Record<string, unknown>;
  /** Stop after this many companies (default: all, up to Blitz's 50k). */
  max_companies: number;
  /** Stop after this many people (default: no cap). Cuts inside the last chunk; companies left without people are not sent. */
  max_people?: number | null;
  find_emails: boolean;
  /** contacts/month × months, to judge coverage like the skill does. */
  needed?: number | null;
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
  /** Where the emails came from (cache keeps the original email_source). */
  emails_from_cache?: number;
  emails_by_source?: Record<string, number>;
  /** In the cache but without a recent verdict: left for MailBridge's Verificación column. */
  emails_cache_unverified?: number;
  /** Nobody free had them: left for MailBridge's Prospeo / Findymail columns. */
  emails_not_found?: number;
  /** Legacy fields of builds made while the cache paid for emails (kept for old jobs' summaries). */
  email_spend_usd?: number;
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
export interface BuildEmailDeps {
  lookup(person: CascadePerson): Promise<CacheHit | null>;
  /** Blitz by LinkedIn: free. */
  blitz(linkedinUrl: string): Promise<{ found: boolean; email?: string | null; all_emails?: string[] } | null>;
  save: typeof saveFoundEmail;
}

/** cache → Blitz, nothing else. Exported for tests. */
export async function freeEmail(person: CascadePerson, deps: BuildEmailDeps): Promise<BuildEmail> {
  try {
    const hit = await deps.lookup(person);
    if (hit) return { kind: "cache", hit };
    if (!person.linkedin_url) return { kind: "none" };
    const em = await deps.blitz(person.linkedin_url);
    const email = em?.found ? usable(em.email) : null;
    if (!email) return { kind: "none" };
    // Into the cache (free), so the next lookup of this person answers.
    await deps.save(person, { email, source: "blitzapi", verification: null });
    return { kind: "blitz", email, all_emails: (em?.all_emails || []).filter((x): x is string => typeof x === "string") };
  } catch (e: any) {
    return { kind: "error", error: String(e?.message || e).slice(0, 300) };
  }
}

export async function run(jobId: string, deps?: BuildEmailDeps): Promise<void> {
  const job = await prisma.tableJob.findUnique({ where: { id: jobId } });
  if (!job || !job.build || !["queued", "running"].includes(job.build_status || "")) return;
  const cfg = job.build as unknown as BuildConfig;
  const state: BuildState = { ...(job.build_state as BuildState) };
  const baseRecords = state.records_used || 0;

  try {
    const bz = await blitzClient();
    const emailDeps: BuildEmailDeps = deps ?? { lookup: lookupCachedEmail, blitz: (li) => bz.findEmail(li), save: saveFoundEmail };
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
      const peopleRoom = cfg.max_people ? cfg.max_people - (state.people || 0) : Infinity;
      if (peopleRoom <= 0) break;

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
      const cut = people.length > peopleRoom;
      if (cut) {
        people.length = peopleRoom;
        const kept = new Set(people.map((x) => x.companyLi));
        for (const li of [...companies.keys()]) if (!kept.has(li)) companies.delete(li);
      }

      // 3. Emails: cache → Blitz, both free. The rest is for MailBridge's columns.
      const results: Array<BuildEmail | null> = cfg.find_emails
        ? await mapPool(people, EMAIL_CONCURRENCY, async ({ p, exp, companyLi }) => {
            const c = companies.get(companyLi) || {};
            return freeEmail(
              {
                linkedin_url: p.linkedin_url,
                first_name: p.first_name,
                last_name: p.last_name,
                full_name: p.full_name,
                company_domain: c.domain || exp?.company_domain,
                company_name: c.name || exp?.company_name,
              },
              emailDeps
            );
          })
        : people.map(() => null);
      for (const r of results) {
        if (!r) continue;
        if (r.kind === "cache") {
          state.emails_from_cache = (state.emails_from_cache || 0) + 1;
          if (!cacheHitAccepted(r.hit)) state.emails_cache_unverified = (state.emails_cache_unverified || 0) + 1;
          const src = r.hit.email_source || "clay_cache";
          state.emails_by_source = { ...state.emails_by_source, [src]: (state.emails_by_source?.[src] || 0) + 1 };
        } else if (r.kind === "blitz") {
          state.emails_by_source = { ...state.emails_by_source, blitzapi: (state.emails_by_source?.blitzapi || 0) + 1 };
        } else if (r.kind === "none") {
          state.emails_not_found = (state.emails_not_found || 0) + 1;
        }
      }

      // 4. Rows → MailBridge (through the same queue as POST /tables/:id/rows).
      const perCompany = new Map<string, [number, number]>();
      const personRows = people.map(({ p, exp, companyLi }, i) => {
        const r = results[i];
        const em = !r ? null : r.kind === "error" ? { found: false, error: r.error } : r.kind === "blitz" ? { found: true, email: r.email, all_emails: r.all_emails } : r.kind === "none" ? { found: false } : null;
        let row = personRow(p, exp, companies.get(companyLi) || {}, em);
        if (r?.kind === "cache") row = applyCacheHit(row, r.hit);
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
      await save(jobId, state);

      if (cut || !cursor || page.length === 0) break;
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
      target_people: cfg?.max_people ?? null,
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
          // Free only (cache + Blitz). Paid search and verification: the MailBridge table's email columns.
          from_cache: state.emails_from_cache || 0,
          cache_unverified: state.emails_cache_unverified || 0,
          by_source: state.emails_by_source || {},
          not_found: state.emails_not_found || 0,
          next_step: "MailBridge: corre las columnas de la cascada de correo (Cache (Clay) → Prospeo → Findymail → Verificación → Email) en las filas sin correo",
          ...(state.email_spend_usd ? { legacy_spent_usd: state.email_spend_usd } : {}),
        },
    started_at: state.started_at ?? null,
    finished_at: state.finished_at ?? null,
  };
}
