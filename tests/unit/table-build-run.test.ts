import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake Blitz with 75 companies (employees_on_linkedin = its index), 2 people each, every other person with an email.
// Searches honor `employee_count` so a TAM can be split; `countBy` overrides the count (no filter) to fake a big TAM.
const companies = Array.from({ length: 75 }, (_, i) => ({ name: `E${i}`, domain: `e${i}.mx`, linkedin_url: `https://www.linkedin.com/company/e${i}`, employees_on_linkedin: i }));
const calls = { pages: [] as Array<string | null>, filters: [] as unknown[], emails: 0, failAtPage: -1 };
const inRange = (company: any) => (c: { employees_on_linkedin: number }) => {
  const r = company?.employee_count || {};
  return (r.min === undefined || c.employees_on_linkedin >= r.min) && (r.max === undefined || c.employees_on_linkedin <= r.max);
};
vi.mock("../../src/services/blitz.client", () => ({
  blitzConfigured: () => true,
  BlitzError: class extends Error { constructor(m: string, public status: number) { super(m); } },
  Blitz: class {
    recordsUsed = 0;
    async init() { return this; }
    async countCompanies(company: any) { this.recordsUsed++; return companies.filter(inRange(company)).length; }
    async countPeople() { this.recordsUsed++; return 150; }
    async companiesPage(company: any, size: number, cursor: string | null) {
      const start = cursor ? Number(cursor) : 0;
      if (calls.failAtPage === start) throw new Error("Blitz down");
      calls.pages.push(cursor);
      calls.filters.push(company);
      const all = companies.filter(inRange(company));
      const results = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return { results, cursor: next };
    }
    async allPeople(company: { linkedin_url: string[] }) {
      return company.linkedin_url.flatMap((u, i) => [0, 1].map((k) => ({
        first_name: `P${k}`, linkedin_url: `${u.replace("company", "in")}-${k}`,
        experiences: [{ job_is_current: true, company_linkedin_url: u, job_title: "CEO" }],
      })));
    }
    async findEmail(li: string) {
      calls.emails++;
      return li.endsWith("-0") ? { found: true, email: `${li.split("/").pop()}@x.mx` } : { found: false };
    }
  },
}));

let job: any;
vi.mock("../../src/db/prisma", () => ({
  default: {
    tableJob: {
      findUnique: vi.fn(async () => job),
      update: vi.fn(async ({ data }: any) => { job = { ...job, ...data }; return job; }),
    },
  },
}));
const enqueued: Array<{ kind: string; n: number }> = [];
const sentRefs: string[] = [];
vi.mock("../../src/services/table-job.service", () => ({
  tableJobService: {
    enqueue: vi.fn(async (_id: string, kind: string, rows: any[]) => { enqueued.push({ kind, n: rows.length }); sentRefs.push(...rows.filter(() => kind === "companies").map((r) => r.ref)); return []; }),
    sentRefs: vi.fn(async () => new Set(sentRefs)),
  },
}));

import { run, buildSummary, freeEmail, planSegments, BuildEmailDeps } from "../../src/services/table-build.service";
import { Blitz } from "../../src/services/blitz.client";
import type { CacheHit } from "../../src/services/email-cascade/cache";

/** cache → Blitz with the mock above; nothing paid exists any more. */
function deps(hits: Record<string, CacheHit> = {}): BuildEmailDeps & { saved: string[] } {
  const saved: string[] = [];
  const bz = new Blitz() as any;
  return {
    saved,
    lookup: async (p) => hits[String(p.linkedin_url)] ?? null,
    blitz: (li) => bz.findEmail(li),
    save: async (_p, found) => { saved.push(found.email); },
  };
}
let d: ReturnType<typeof deps>;
const runJob = (id: string) => run(id, d);

beforeEach(() => {
  calls.pages = []; calls.filters = []; calls.emails = 0; calls.failAtPage = -1; enqueued.length = 0; sentRefs.length = 0;
  d = deps();
  job = { id: "j1", build_status: "queued", build_state: {}, build: { company: { x: 1 }, people: {}, max_companies: null, find_emails: true, needed: 100 } };
});

describe("background Blitz build", () => {
  it("walks the whole TAM in chunks of 50 and queues every row", async () => {
    await runJob("j1");
    expect(job.build_status).toBe("done");
    expect(job.build_state).toMatchObject({ companies_total: 75, people_total: 150, companies: 75, people: 150, emails_valid: 75, chunks: 2, cursor: null });
    expect(enqueued.filter((e) => e.kind === "companies").reduce((s, e) => s + e.n, 0)).toBe(75);
    expect(enqueued.filter((e) => e.kind === "people").reduce((s, e) => s + e.n, 0)).toBe(150);
    const sum = buildSummary(job.build_status, job.build_state, job.build, null)!;
    expect(sum.coverage).toMatchObject({ email_rate: 0.5, reachable_estimate: 75, needed: 100, verdict: "INSUFICIENTE" });
  });

  it("stops at max_companies", async () => {
    job.build.max_companies = 30;
    await runJob("j1");
    expect(job.build_state.companies).toBe(30);
    expect(calls.pages).toEqual([null]);
  });

  it("pages of 50: Blitz's 1,000-page limit is 50,000 companies, not 25,000", async () => {
    await runJob("j1");
    expect(calls.pages).toEqual([null, "50"]);
  });

  it("a TAM above one search's cap is split by employee_count and every company is walked once", async () => {
    await run("j1", d, { searchCap: 20 });
    expect(job.build_status).toBe("done");
    const segments = job.build_state.segments as Array<{ filter: any; total: number }>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((s) => s.total <= 20)).toBe(true);
    expect(segments.reduce((sum, s) => sum + s.total, 0)).toBe(75);
    expect(segments[0].filter.employee_count).not.toHaveProperty("min");
    expect(job.build_state).toMatchObject({ companies: 75, people: 150, uncovered: 0, segment: segments.length });
    expect(enqueued.filter((e) => e.kind === "companies").reduce((s, e) => s + e.n, 0)).toBe(75);
    expect(buildSummary(job.build_status, job.build_state, job.build, null)!.searches).toMatchObject({ count: segments.length, uncovered: 0 });
  });

  it("a search that cannot be split stops at its last page Blitz serves instead of asking for one more", async () => {
    // Cap 50 = one page per search: a single employee count above it is truncated, walked one page, and the build ends.
    job.build.company = { employee_count: { min: 10, max: 10 } };
    companies.push(...Array.from({ length: 60 }, (_, i) => ({ name: `T${i}`, domain: `t${i}.mx`, linkedin_url: `https://www.linkedin.com/company/t${i}`, employees_on_linkedin: 10 })));
    try {
      await run("j1", d, { searchCap: 50 });
    } finally {
      companies.length = 75;
    }
    expect(job.build_status).toBe("done");
    expect(calls.pages).toEqual([null]);
    expect(job.build_state).toMatchObject({ companies: 50, uncovered: 11, segment: 1 });
  });

  it("a build started before segments resumes its cursor with pages of 25, as it was walking", async () => {
    job.build_status = "running";
    job.build_state = { companies_total: 75, people_total: 150, companies: 25, people: 50, emails_valid: 25, emails_searched: 50, chunks: 1, cursor: "25" };
    await run("j1", d, { searchCap: 20 });
    expect(job.build_status).toBe("done");
    expect(calls.pages).toEqual(["25", "50"]);
    expect(calls.filters.every((f) => f === job.build.company)).toBe(true);
    expect(job.build_state).toMatchObject({ companies: 75, segments: [{ total: 75, legacy_page_size: 25 }] });
  });

  it("a build continued with a narrower filter and no cursor is planned afresh, keeping its counters", async () => {
    job.build_status = "queued";
    job.build.company = { employee_count: { max: 30 } };
    job.build_state = { companies_total: 75, people_total: 150, companies: 44, people: 88, emails_valid: 44, emails_searched: 88, chunks: 2, cursor: null };
    await run("j1", d, { searchCap: 20 });
    expect(job.build_status).toBe("done");
    const segments = job.build_state.segments as Array<{ filter: any; total: number; legacy_page_size?: number }>;
    expect(segments.reduce((sum, x) => sum + x.total, 0)).toBe(31); // employees 0..30
    expect(segments.every((x) => x.legacy_page_size === undefined && x.filter.employee_count.max <= 30)).toBe(true);
    expect(job.build_state.companies).toBe(44 + 31);
  });

  it("re-walking a cut build with skip_sent_companies pays the people search only for companies not queued before", async () => {
    // A legacy walk stopped after 40 companies (pages of 25), as Blitz's page limit did at ~25k.
    job.build.max_companies = 40;
    await runJob("j1");
    expect(job.build_state.companies).toBe(40);
    const emailsBefore = calls.emails;
    // Re-walk the same job, no cap, no cursor, skipping what it already queued.
    Object.assign(job.build, { max_companies: null, skip_sent_companies: true });
    job.build_status = "queued";
    job.build_state = { ...job.build_state, cursor: null, segments: undefined };
    enqueued.length = 0;
    await run("j1", d, { searchCap: 20 });
    expect(job.build_status).toBe("done");
    expect(job.build_state).toMatchObject({ companies_skipped: 40, companies: 75 });
    expect(calls.emails - emailsBefore).toBe(35 * 2);
    expect(enqueued.filter((e) => e.kind === "companies").reduce((s, e) => s + e.n, 0)).toBe(35);
  });

  it("a split resumes inside its current search after a failure", async () => {
    await run("j1", d, { searchCap: 40 });
    const total = job.build_state.companies;
    expect(total).toBe(75);
    // Rerun from the middle: second search, first page.
    job.build_status = "running";
    job.build_state = { ...job.build_state, segment: 1, cursor: null, companies: job.build_state.segments[0].total };
    enqueued.length = 0;
    await run("j1", d, { searchCap: 40 });
    expect(job.build_state.companies).toBe(75);
    expect(enqueued.filter((e) => e.kind === "companies").reduce((s, e) => s + e.n, 0)).toBe(75 - job.build_state.segments[0].total);
  });

  it("stops at max_people, cutting inside the chunk and dropping companies left without people", async () => {
    job.build.max_people = 7;
    await runJob("j1");
    expect(job.build_status).toBe("done");
    expect(job.build_state).toMatchObject({ people: 7, companies: 4, chunks: 1 });
    expect(calls.emails).toBe(7); // only the kept people are searched
    expect(enqueued).toEqual([{ kind: "companies", n: 4 }, { kind: "people", n: 7 }]);
  });

  it("a failure keeps the cursor of the last finished chunk, and a rerun resumes there", async () => {
    calls.failAtPage = 50;
    await runJob("j1");
    expect(job.build_status).toBe("failed");
    expect(job.build_error).toContain("Blitz down");
    expect(job.build_state).toMatchObject({ companies: 50, cursor: "50", chunks: 1 });

    calls.failAtPage = -1; calls.pages = [];
    job.build_status = "running";
    await runJob("j1");
    expect(job.build_status).toBe("done");
    expect(calls.pages).toEqual(["50"]); // did not start over
    expect(job.build_state).toMatchObject({ companies: 75, people: 150, chunks: 2 });
  });

  it("does nothing for a job already done", async () => {
    job.build_status = "done";
    await runJob("j1");
    expect(calls.pages).toEqual([]);
  });
});

describe("planSegments", () => {
  const counter = (n: (f: any) => number) => ({ async countCompanies(f: object) { return n(f); } });

  it("one search when the TAM fits", async () => {
    expect(await planSegments(counter(() => 0), { a: 1 }, 50_000)).toEqual({ segments: [{ filter: { a: 1 }, total: 50_000 }], uncovered: 0, warning: null });
  });

  it("intersects with an employee_count the filter already carries", async () => {
    const counts = (f: any) => {
      const lo = f.employee_count?.min ?? 0, hi = f.employee_count?.max ?? 1_000_000;
      return Math.max(0, Math.min(hi, 400) - Math.max(lo, 100) + 1) * 1_000;
    };
    const plan = await planSegments(counter(counts), { employee_count: { min: 100, max: 400 } }, 301_000);
    expect(plan.uncovered).toBe(0);
    expect(plan.segments.every((s) => s.filter.employee_count.min >= 100 && s.filter.employee_count.max <= 400)).toBe(true);
    expect(plan.segments.reduce((s, x) => s + x.total, 0)).toBe(301_000);
  });

  it("a single employee count above the cap is walked up to the cap and the rest reported", async () => {
    // 80k companies with 0 employees on LinkedIn, 10k with 5.
    const counts = (f: any) => {
      const lo = f.employee_count?.min ?? 0, hi = f.employee_count?.max ?? 1_000_000;
      return (lo <= 0 && 0 <= hi ? 80_000 : 0) + (lo <= 5 && 5 <= hi ? 10_000 : 0);
    };
    const plan = await planSegments(counter(counts), {}, 90_000);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]).toMatchObject({ total: 80_000, truncated: true });
    expect(plan.segments[0].filter.employee_count).toEqual({ max: 1 });
    expect(plan.segments[1]).toMatchObject({ total: 10_000 });
    expect(plan.uncovered).toBe(30_000);
    expect(plan.warning).toMatch(/30000/);
  });

  it("does not trust a split that doesn't add up", async () => {
    const plan = await planSegments(counter(() => 60_000), {}, 100_000);
    expect(plan.segments).toEqual([{ filter: {}, total: 100_000, truncated: true }]);
    expect(plan.uncovered).toBe(50_000);
    expect(plan.warning).toMatch(/added up/);
  });
});

describe("emails in the build: only cache and Blitz (free)", () => {
  const hit = (email: string, verification: Record<string, unknown> | null): CacheHit => ({
    found: true, email, email_source: "icypeas", email_verification: verification, email_found_via: null, profile_id: "p", matched_by: "linkedin",
  });

  it("Blitz hits go to Email and into the cache; misses are left for MailBridge's columns", async () => {
    await runJob("j1");
    expect(job.build_state).toMatchObject({ emails_valid: 75, emails_by_source: { blitzapi: 75 }, emails_not_found: 75 });
    expect(d.saved).toHaveLength(75);
    const sum = buildSummary(job.build_status, job.build_state, job.build, null)!;
    expect(sum.emails).toMatchObject({ from_cache: 0, not_found: 75 });
    expect(sum.emails).not.toHaveProperty("budget_usd");
  });

  it("a cache hit with a recent conclusive verdict goes to Email with its original source; without one it waits for Verificación", async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const ok = await freeEmail({ linkedin_url: "li-a" }, deps({ "li-a": hit("ana@acme.mx", { provider: "debounce", verdict: "valid", checked_at: recent }) }));
    expect(ok).toMatchObject({ kind: "cache" });
    const { applyCacheHit } = await import("../../src/services/email-cascade/rows");
    const accepted = applyCacheHit({ domain: "acme.mx" }, (ok as any).hit);
    expect(accepted).toMatchObject({ email: "ana@acme.mx", email_source: "icypeas", email_status: "valido", domain_match: "si" });
    const old = applyCacheHit({ domain: "acme.mx" }, hit("ana@acme.mx", { provider: "debounce", verdict: "valid", checked_at: "2025-01-01T00:00:00Z" }));
    expect(old).toMatchObject({ email_found: "ana@acme.mx", email_status: "pendiente", discard_reason: "sin_verificar" });
    expect(old).not.toHaveProperty("email");
    const ca = applyCacheHit({ domain: "acme.mx" }, hit("ana@acme.mx", { provider: "debounce", verdict: "catch_all", checked_at: recent }));
    expect(ca).toMatchObject({ email: "ana@acme.mx", email_status: "valido_catch_all", email_catch_all: "si", send_recommendation: "risky" });
  });

  it("junk or personal addresses from Blitz are not used", async () => {
    const r = await freeEmail({ linkedin_url: "li-x" }, { lookup: async () => null, blitz: async () => ({ found: true, email: "x@gmail.com" }), save: async () => undefined });
    expect(r).toEqual({ kind: "none" });
  });

  it("the old paid knobs are rejected, not silently ignored", async () => {
    const { parseBuild } = await import("../../src/controllers/tables.controller");
    expect(parseBuild({ company: { x: 1 }, email_budget_usd: 5 })).toMatch(/removed/);
  });
});
