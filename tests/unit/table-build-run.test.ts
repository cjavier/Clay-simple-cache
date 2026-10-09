import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake Blitz with 3 pages of 25 companies, 2 people each, every other person with an email.
const companies = Array.from({ length: 75 }, (_, i) => ({ name: `E${i}`, domain: `e${i}.mx`, linkedin_url: `https://www.linkedin.com/company/e${i}` }));
const calls = { pages: [] as Array<string | null>, emails: 0, failAtPage: -1 };
vi.mock("../../src/services/blitz.client", () => ({
  blitzConfigured: () => true,
  BlitzError: class extends Error { constructor(m: string, public status: number) { super(m); } },
  Blitz: class {
    recordsUsed = 0;
    async init() { return this; }
    async countCompanies() { this.recordsUsed++; return 75; }
    async countPeople() { this.recordsUsed++; return 150; }
    async companiesPage(_c: object, size: number, cursor: string | null) {
      const start = cursor ? Number(cursor) : 0;
      if (calls.failAtPage === start) throw new Error("Blitz down");
      calls.pages.push(cursor);
      const results = companies.slice(start, start + size);
      const next = start + size < companies.length ? String(start + size) : null;
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
vi.mock("../../src/services/table-job.service", () => ({
  tableJobService: { enqueue: vi.fn(async (_id: string, kind: string, rows: unknown[]) => { enqueued.push({ kind, n: rows.length }); return []; }) },
}));

import { run, buildSummary } from "../../src/services/table-build.service";
import { blitzProvider, CascadeProvider } from "../../src/services/email-cascade/providers";
import type { CascadeDeps } from "../../src/services/email-cascade/cascade";

/** Cascade with no cache hits and in-memory bookkeeping; Blitz is the mock above. */
function deps(extra: CascadeProvider[] = []): CascadeDeps & { rows: any[] } {
  const rows: any[] = [];
  return {
    rows,
    lookup: async () => null,
    save: async () => undefined,
    attempts: { prior: async () => [], record: async (k, _p, ctx, w) => { rows.push({ k, ...ctx, ...w }); }, closePending: async () => 0 },
    breaker: { isExhausted: async () => null, trip: async () => true },
    providers: [blitzProvider(), ...extra],
  };
}
let d: ReturnType<typeof deps>;
const runJob = (id: string) => run(id, d);

beforeEach(() => {
  calls.pages = []; calls.emails = 0; calls.failAtPage = -1; enqueued.length = 0;
  d = deps();
  job = { id: "j1", build_status: "queued", build_state: {}, build: { company: { x: 1 }, people: {}, max_companies: 50000, find_emails: true, needed: 100 } };
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
    expect(calls.pages).toEqual([null, "25"]);
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

describe("background build with the email cascade", () => {
  const prospeo = (calls: { n: number }): CascadeProvider => ({
    id: "prospeo", label: "Prospeo", configured: () => true, costUsd: () => 0.05,
    async find(p) { calls.n++; return { kind: "found", email: `${String(p.linkedin_url).split("/").pop()}@prospeo.mx`, verification: { provider: "prospeo", verdict: "valid" } }; },
  });

  it("Prospeo picks up who Blitz missed, and the rows say so", async () => {
    const calls = { n: 0 };
    d = deps([prospeo(calls)]);
    await runJob("j1");
    expect(job.build_status).toBe("done");
    expect(calls.n).toBe(75); // only the 75 Blitz missed
    expect(job.build_state).toMatchObject({ emails_valid: 150, emails_by_source: { blitzapi: 75, prospeo: 75 }, email_spend_usd: 3.75 });
  });

  it("stops paying at email_budget_usd; the rest are pending (presupuesto), reported in the summary", async () => {
    const calls = { n: 0 };
    d = deps([prospeo(calls)]);
    job.build.email_budget_usd = 1;
    await runJob("j1");
    expect(calls.n).toBe(20); // $1 / $0.05
    expect(job.build_state.email_spend_usd).toBeCloseTo(1);
    expect(job.build_state).toMatchObject({ emails_valid: 95, emails_pending: 55, emails_pending_by_reason: { presupuesto: 55 }, budget_exhausted: true });
    const pending = d.rows.filter((r) => r.status === "pending");
    expect(pending.every((r) => r.provider === "prospeo" && r.reason === "presupuesto" && r.called === false && r.job_id === "j1")).toBe(true);
    const sum = buildSummary(job.build_status, job.build_state, job.build, null)!;
    expect(sum.emails).toMatchObject({ budget_usd: 1, budget_exhausted: true, pending: { persons: 55, by_reason: { presupuesto: 55 } } });
    const people = enqueued.filter((e) => e.kind === "people").reduce((s, e) => s + e.n, 0);
    expect(people).toBe(150); // pending people still get their row, without an email
  });
});
