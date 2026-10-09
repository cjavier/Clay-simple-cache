import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory prisma: profiles (lookup), outcomes, provider state ─────────
const db = {
  profiles: [] as Array<{ id: string; email: string | null; linkedin_slug: string | null; data: any }>,
  bounced: new Set<string>(),
  state: new Map<string, any>(),
};
vi.mock("../../src/db/prisma", () => ({
  default: {
    profile: {
      findUnique: vi.fn(async ({ where }: any) => db.profiles.find((p) => (where.linkedin_slug ? p.linkedin_slug === where.linkedin_slug : p.email === where.email)) ?? null),
    },
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, domain: string) =>
      db.profiles.filter((p) => p.email && p.email.split("@")[1] === domain)
    ),
    emailOutcome: {
      findMany: vi.fn(async ({ where }: any) =>
        where.email.in.filter((e: string) => db.bounced.has(e)).map((email: string) => ({ email, bounced_at: new Date(), bounce_type: "hard" }))
      ),
    },
    emailProviderState: {
      findUnique: vi.fn(async ({ where }: any) => db.state.get(where.provider) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const cur = db.state.get(where.provider);
        const next = cur ? { ...cur, ...update } : { ...create };
        db.state.set(where.provider, next);
        return next;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const next = { ...db.state.get(where.provider), ...data };
        db.state.set(where.provider, next);
        return next;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const cur = db.state.get(where.provider);
        if (!cur) return { count: 0 };
        const wantsNull = where.exhausted_at === null;
        const isNull = !cur.exhausted_at;
        if (wantsNull !== isNull) return { count: 0 };
        db.state.set(where.provider, { ...cur, ...data });
        return { count: 1 };
      }),
      findMany: vi.fn(async () => [...db.state.values()].filter((s) => s.exhausted_at)),
    },
    emailAttempt: { findMany: vi.fn(async () => []) },
    tableJob: { findMany: vi.fn(async () => []) },
  },
}));

import { Budget, CascadeDeps, findEmailCascade, alreadyAnswered, PriorAttempt } from "../../src/services/email-cascade/cascade";
import { CascadePerson, CascadeProvider, ProviderOutcome, prospeoProvider, findymailProvider, unitCost } from "../../src/services/email-cascade/providers";
import { lookupCachedEmail, personKey } from "../../src/services/email-cascade/cache";
import { emailRow, processGroups, PendingGroup } from "../../src/services/email-cascade/pending";
import { hourlyTick } from "../../src/services/email-cascade/schedule";
import { parseRetry } from "../../src/controllers/emails.controller";
import { tripMessage } from "../../src/services/email-cascade/store";
import { toUpsertRow } from "../../src/services/table-rows";

// ─── Fakes ──────────────────────────────────────────────────

function fakeProvider(id: "blitzapi" | "prospeo" | "findymail", answer: (p: CascadePerson) => ProviderOutcome, cost = 0.05) {
  const calls: CascadePerson[] = [];
  const provider: CascadeProvider = {
    id,
    label: id,
    configured: () => true,
    costUsd: () => cost,
    async find(p) {
      calls.push(p);
      return answer(p);
    },
  };
  return { provider, calls };
}

function memoryDeps(providers: CascadeProvider[], opts: { cache?: Record<string, any>; prior?: PriorAttempt[] } = {}) {
  const records: any[] = [];
  const saved: any[] = [];
  const closed: any[] = [];
  const open = new Map<string, "sin_creditos" | "sin_acceso">();
  const trips: string[] = [];
  const deps: CascadeDeps = {
    lookup: async (p) => (p.linkedin_url && opts.cache?.[p.linkedin_url]) || null,
    save: async (p, f) => void saved.push({ p, f }),
    attempts: {
      prior: async () => opts.prior ?? [],
      record: async (k, _p, ctx, w) => void records.push({ k, ...ctx, ...w }),
      closePending: async (k, job, reason, email) => (closed.push({ k, job, reason, email }), 1),
    },
    breaker: {
      isExhausted: async (id) => open.get(id) ?? null,
      trip: async (id, reason) => {
        if (open.has(id)) return false;
        open.set(id, reason);
        trips.push(id);
        return true;
      },
    },
    providers,
  };
  return { deps, records, saved, closed, open, trips };
}

const ana: CascadePerson = { linkedin_url: "https://www.linkedin.com/in/ana-lopez", first_name: "Ana", last_name: "López", company_domain: "acme.mx", company_name: "Acme" };
const beto: CascadePerson = { linkedin_url: "https://mx.linkedin.com/in/beto-ruiz/", first_name: "Beto", last_name: "Ruiz", company_domain: "acme.mx" };

beforeEach(() => {
  db.profiles = [];
  db.bounced = new Set();
  db.state = new Map();
});

describe("findEmailCascade — cache first", () => {
  it("a cached address is used with its ORIGINAL source and nobody is called", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "found", email: "x@acme.mx", verification: null }));
    const m = memoryDeps([pz.provider], {
      cache: { [ana.linkedin_url!]: { found: true, email: "ana@acme.mx", email_source: "icypeas", email_verification: { provider: "debounce", verdict: "catch_all" }, email_found_via: "clay_get_email_external" } },
    });
    const r = await findEmailCascade(ana, m.deps);
    expect(r).toMatchObject({ found: true, email: "ana@acme.mx", email_source: "icypeas", from_cache: true, cost_usd: 0 });
    expect(pz.calls).toHaveLength(0);
    expect(m.records).toHaveLength(0);
  });

  it("Blitz → Prospeo → Findymail, stopping at the first find, which goes to the cache with its provenance", async () => {
    const bz = fakeProvider("blitzapi", () => ({ kind: "not_found" }), 0);
    const pz = fakeProvider("prospeo", () => ({ kind: "found", email: "ana@acme.mx", verification: { provider: "prospeo", verdict: "valid" } }));
    const fm = fakeProvider("findymail", () => ({ kind: "found", email: "nope@acme.mx", verification: null }));
    const m = memoryDeps([bz.provider, pz.provider, fm.provider]);
    const r = await findEmailCascade(ana, m.deps, { ctx: { job_id: "j1" } });
    expect(r).toMatchObject({ found: true, email: "ana@acme.mx", email_source: "prospeo", email_verification: { provider: "prospeo", verdict: "valid" }, cost_usd: 0.05 });
    expect(fm.calls).toHaveLength(0);
    expect(m.saved[0].f).toEqual({ email: "ana@acme.mx", source: "prospeo", verification: { provider: "prospeo", verdict: "valid" } });
    expect(m.records.map((x) => [x.provider, x.status])).toEqual([["blitzapi", "not_found"], ["prospeo", "found"]]);
    expect(m.closed).toEqual([{ k: "li:ana-lopez", job: "j1", reason: "encontrado", email: "ana@acme.mx" }]);
  });
});

describe("circuit breaker", () => {
  it("the first 402 opens it once; later people skip that provider, go on to the next and stay pending for it", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "no_credits", reason: "sin_creditos", detail: "HTTP 402" }));
    const fm = fakeProvider("findymail", (p) => (p === beto ? { kind: "found", email: "beto@acme.mx", verification: null } : { kind: "not_found" }));
    const m = memoryDeps([pz.provider, fm.provider]);

    const r1 = await findEmailCascade(ana, m.deps);
    const r2 = await findEmailCascade(beto, m.deps);

    expect(pz.calls).toHaveLength(1); // Beto never reached Prospeo
    expect(m.trips).toEqual(["prospeo"]);
    expect(r1).toMatchObject({ found: false, pending: [{ provider: "prospeo", reason: "sin_creditos" }], not_found: ["findymail"] });
    expect(r2).toMatchObject({ found: true, email_source: "findymail", email_verification: null });
    const betoProspeo = m.records.find((x) => x.k === "li:beto-ruiz" && x.provider === "prospeo");
    expect(betoProspeo).toMatchObject({ status: "pending", reason: "sin_creditos", called: false });
  });

  it("the Slack line names the provider, the people waiting and the campaigns", () => {
    expect(tripMessage("prospeo", "sin_creditos", "HTTP 402", { persons: 12, campaigns: ["CK001", "IMP007"] })).toContain("*Prospeo sin créditos*; 12 personas pendientes (CK001, IMP007)");
  });
});

describe("not found ≠ couldn't look", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("a real not_found isn't bought again for 90 days; found never; pending always", () => {
    const prior: PriorAttempt[] = [
      { provider: "prospeo", status: "not_found", resolved_at: days(10), updated_at: days(10) },
      { provider: "findymail", status: "not_found", resolved_at: days(100), updated_at: days(100) },
      { provider: "blitzapi", status: "found", resolved_at: days(400), updated_at: days(400) },
    ];
    expect(alreadyAnswered(prior, "prospeo", now)).toBe(true);
    expect(alreadyAnswered(prior, "findymail", now)).toBe(false);
    expect(alreadyAnswered(prior, "blitzapi", now)).toBe(true);
    expect(alreadyAnswered([{ provider: "prospeo", status: "pending", resolved_at: null, updated_at: days(1) }], "prospeo", now)).toBe(false);
  });

  it("the cascade skips who already answered and retries who couldn't look", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "found", email: "ana@acme.mx", verification: null }));
    const fm = fakeProvider("findymail", () => ({ kind: "found", email: "ana2@acme.mx", verification: null }));
    const m = memoryDeps([pz.provider, fm.provider], { prior: [{ provider: "prospeo", status: "not_found", resolved_at: new Date(), updated_at: new Date() }] });
    const r = await findEmailCascade(ana, m.deps);
    expect(pz.calls).toHaveLength(0);
    expect(r).toMatchObject({ found: true, email_source: "findymail" });
  });

  it("rate limits and errors leave the person pending, not 'not found'", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "rate_limit", detail: "HTTP 429" }));
    const fm = fakeProvider("findymail", () => {
      throw new Error("socket hang up");
    });
    const m = memoryDeps([pz.provider, fm.provider]);
    const r = await findEmailCascade(ana, m.deps);
    expect(r).toMatchObject({ found: false, pending: [{ provider: "prospeo", reason: "rate_limit" }, { provider: "findymail", reason: "error" }], not_found: [] });
  });
});

describe("budget", () => {
  it("reserves before calling, charges only finds, and refuses past the cap", () => {
    const b = new Budget(0.1);
    expect(b.tryReserve(0.05)).toBe(true);
    expect(b.tryReserve(0.05)).toBe(true);
    expect(b.tryReserve(0.05)).toBe(false); // two in flight already fill it
    expect(b.exhausted).toBe(true);
    b.settle(0.05, false); // a miss costs nothing
    expect(b.tryReserve(0.05)).toBe(true);
    b.settle(0.05, true);
    b.settle(0.05, true);
    expect(b.spentUsd).toBeCloseTo(0.1);
    expect(b.tryReserve(0)).toBe(true); // free providers (Blitz) are never blocked
  });

  it("over budget → pending 'presupuesto' without calling", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "found", email: "a@acme.mx", verification: null }));
    const m = memoryDeps([pz.provider]);
    const r = await findEmailCascade(ana, m.deps, { budget: new Budget(0.01) });
    expect(pz.calls).toHaveLength(0);
    expect(r).toMatchObject({ found: false, pending: [{ provider: "prospeo", reason: "presupuesto" }] });
  });

  it("unit costs are configurable", () => {
    expect(unitCost("prospeo", {})).toBe(0.05);
    expect(unitCost("blitzapi", {})).toBe(0);
    expect(unitCost("findymail", { EMAIL_COST_FINDYMAIL_USD: "0.08" })).toBe(0.08);
  });
});

describe("retrying pending people", () => {
  const group = (p: CascadePerson, providers: any[] = ["prospeo"]): PendingGroup => ({
    person_key: personKey(p)!,
    job_id: "j1",
    row_ref: `li:${p.linkedin_url!.replace(/^https?:\/\/(www\.|mx\.)?/, "").replace(/\/$/, "")}`,
    person: p,
    providers,
  });

  it("someone Clay's function already found is closed from the cache without paying, and their row is resent", async () => {
    const pz = fakeProvider("prospeo", () => ({ kind: "found", email: "paid@acme.mx", verification: null }));
    const m = memoryDeps([pz.provider], {
      cache: { [ana.linkedin_url!]: { found: true, email: "ana@acme.mx", email_source: "icypeas", email_verification: { provider: "debounce", verdict: "valid" }, email_found_via: "clay_get_email_external" } },
    });
    const sent: any[] = [];
    const s = await processGroups([group(ana), group(beto)], { trigger: "manual", budgetUsd: 20, deps: m.deps, send: async (job, rows) => (sent.push({ job, rows }), rows.length) });

    expect(pz.calls.map((p) => p.first_name)).toEqual(["Beto"]); // Ana cost nothing
    expect(m.closed).toContainEqual({ k: "li:ana-lopez", job: "j1", reason: "cache", email: "ana@acme.mx" });
    expect(s).toMatchObject({ persons: 2, found: 2, from_cache: 1, still_pending: 0, sent_to_mailbridge: 2, spent_usd: 0.05, by_source: { icypeas: 1, prospeo: 1 } });
    const anaRow = sent[0].rows.find((r: any) => r.email === "ana@acme.mx");
    expect(anaRow).toMatchObject({ ref: "li:linkedin.com/in/ana-lopez", email_source: "icypeas", email_status: "valido", email_verification: { provider: "debounce", verdict: "valid" } });
    // MailBridge gets the same ref → upsert of the existing row.
    const mapped = toUpsertRow("people", anaRow, 0, { enforceProvenance: true });
    expect(mapped.ref).toBe("li:linkedin.com/in/ana-lopez");
    expect(mapped.data).toMatchObject({ Email: "ana@acme.mx", "Email Source": "icypeas", "Email Verdict": "valid" });
  });

  it("only the providers the person is pending for are retried", async () => {
    const bz = fakeProvider("blitzapi", () => ({ kind: "found", email: "b@acme.mx", verification: null }), 0);
    const fm = fakeProvider("findymail", () => ({ kind: "not_found" }));
    const m = memoryDeps([bz.provider, fm.provider]);
    const s = await processGroups([group(ana, ["findymail"])], { trigger: "manual", budgetUsd: 20, deps: m.deps, send: async () => 0 });
    expect(bz.calls).toHaveLength(0);
    expect(fm.calls).toHaveLength(1);
    expect(s).toMatchObject({ found: 0, still_pending: 1 });
  });

  it("a row for an address with no verdict says 'unknown', never inherits 'valido' as valid", () => {
    const row = emailRow({ row_ref: "li:x", person: ana }, { found: true, email: "a@acme.mx", email_source: "findymail", email_verification: null, from_cache: false, provider: "findymail", cost_usd: 0.05 });
    expect(row.email_verification).toEqual({ provider: null, verdict: "unknown" });
    const blitz = emailRow({ row_ref: "li:x", person: ana }, { found: true, email: "a@acme.mx", email_source: "blitzapi", email_verification: null, from_cache: false, provider: "blitzapi", cost_usd: 0 });
    expect(blitz.email_verification).toBeUndefined();
  });

  it("retry filters are validated", () => {
    expect(parseRetry({ provider: "apollo" })).toMatch(/provider/);
    expect(parseRetry({ reason: "x" })).toMatch(/reason/);
    expect(parseRetry({ since: "ayer" })).toMatch(/since/);
    const ok = parseRetry({ provider: "prospeo", reason: "sin_creditos", since: "2026-10-01", budget_usd: 5 });
    expect(ok).toMatchObject({ filter: { provider: "prospeo", reason: "sin_creditos" }, budgetUsd: 5 });
  });
});

describe("POST /emails/lookup — the cache read", () => {
  it("by LinkedIn slug, whatever the URL's spelling", async () => {
    db.profiles.push({ id: "p1", email: "ana@acme.mx", linkedin_slug: "ana-lopez", data: { email_source: "prospeo", email_verification: { provider: "prospeo", verdict: "valid" } } });
    const hit = await lookupCachedEmail({ linkedin_url: "linkedin.com/in/Ana-Lopez/?trk=x" });
    expect(hit).toMatchObject({ found: true, email: "ana@acme.mx", email_source: "prospeo", matched_by: "linkedin" });
  });

  it("by name + domain (accents and maternal surnames tolerated)", async () => {
    db.profiles.push({ id: "p2", email: "javier@improvitz.com", linkedin_slug: null, data: { first_name: "Javier", last_name: "García Ruiz", email_source: "icypeas", email_found_via: "clay_get_email_external" } });
    const hit = await lookupCachedEmail({ linkedin_url: "", first_name: "Javier", last_name: "Garcia", company_domain: "https://www.improvitz.com/" });
    expect(hit).toMatchObject({ email: "javier@improvitz.com", email_source: "icypeas", email_found_via: "clay_get_email_external", matched_by: "name_domain" });
    expect(await lookupCachedEmail({ first_name: "Pedro", last_name: "Garcia", company_domain: "improvitz.com" })).toBeNull();
  });

  it("a hard-bounced or invalid address is not an answer", async () => {
    db.profiles.push({ id: "p3", email: "old@acme.mx", linkedin_slug: "beto-ruiz", data: {} });
    db.bounced.add("old@acme.mx");
    expect(await lookupCachedEmail(beto)).toBeNull();
    db.profiles.push({ id: "p4", email: "bad@acme.mx", linkedin_slug: "ana-lopez", data: { email_verification: { verdict: "invalid" } } });
    expect(await lookupCachedEmail(ana)).toBeNull();
  });

  it("the endpoint answers the MailBridge contract, free", async () => {
    db.profiles.push({ id: "p1", email: "ana@acme.mx", linkedin_slug: "ana-lopez", data: { email_source: "prospeo", email_verification: { provider: "prospeo", verdict: "valid" } } });
    const { emailsController } = await import("../../src/controllers/emails.controller");
    const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    await emailsController.lookup({ body: { linkedin_url: "https://www.linkedin.com/in/ana-lopez" } } as any, res);
    expect(res.body).toEqual({ found: true, email: "ana@acme.mx", email_source: "prospeo", email_verification: { provider: "prospeo", verdict: "valid" }, email_found_via: null });
    await emailsController.lookup({ body: { linkedin_url: "https://www.linkedin.com/in/nadie" } } as any, res);
    expect(res.body).toEqual({ found: false, email: null, email_source: null, email_verification: null, email_found_via: null });
    await emailsController.lookup({ body: { first_name: "Ana" } } as any, res);
    expect(res.code).toBe(400);
  });
});

describe("provider adapters", () => {
  const fetchOf = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("Prospeo: verified hit, NO_MATCH, out of credits", async () => {
    const hit = await prospeoProvider(fetchOf(200, { error: false, person: { email: { email: "Ana@Acme.mx", status: "VERIFIED" } } }), () => "k").find(ana);
    expect(hit).toMatchObject({ kind: "found", email: "ana@acme.mx", verification: { provider: "prospeo", verdict: "valid" } });
    expect(await prospeoProvider(fetchOf(400, { error: true, error_code: "NO_MATCH" }), () => "k").find(ana)).toMatchObject({ kind: "not_found" });
    expect(await prospeoProvider(fetchOf(400, { error: true, error_code: "INSUFFICIENT_CREDITS" }), () => "k").find(ana)).toMatchObject({ kind: "no_credits", reason: "sin_creditos" });
    expect(await prospeoProvider(fetchOf(200, { person: { email: { email: "info@acme.mx" } } }), () => "k").find(ana)).toMatchObject({ kind: "not_found", detail: "descartado" });
  });

  it("Findymail: 402 = no credits, 404 = not found, no verification flag = unknown", async () => {
    expect(await findymailProvider(fetchOf(402, { error: "Not enough credits" }), () => "k").find(ana)).toMatchObject({ kind: "no_credits", reason: "sin_creditos" });
    expect(await findymailProvider(fetchOf(404, {}), () => "k").find(ana)).toMatchObject({ kind: "not_found" });
    expect(await findymailProvider(fetchOf(200, { contact: { email: "ana@acme.mx" } }), () => "k").find(ana)).toMatchObject({
      kind: "found",
      verification: { provider: null, verdict: "unknown" },
    });
  });

  it("free balance checks", async () => {
    expect(await prospeoProvider(fetchOf(200, { error: false, response: { remaining_credits: 13382 } }), () => "k").balance!()).toMatchObject({ balance: 13382, error: null });
    expect(await findymailProvider(fetchOf(200, { credits: 0, has_capacity: false }), () => "k").balance!()).toMatchObject({ balance: 0, error: null });
  });
});

describe("hourly check", () => {
  const withBalance = (id: "prospeo" | "findymail", balance: number): CascadeProvider => ({
    id, label: id, configured: () => true, costUsd: () => 0.05, find: async () => ({ kind: "not_found" }), balance: async () => ({ balance, error: null }),
  });

  it("an exhausted provider with credits again is reactivated and its pending people are retried", async () => {
    db.state.set("prospeo", { provider: "prospeo", exhausted_at: new Date("2026-10-09T10:00:00Z"), exhausted_reason: "sin_creditos" });
    const retry = vi.fn(async () => ({ persons: 7, pending_rows: 7 }));
    const notify = vi.fn(async () => undefined);
    const r = await hourlyTick({ providers: [withBalance("prospeo", 5000)], retry: retry as any, notify, now: () => new Date("2026-10-09T12:00:00Z") });
    expect(r[0]).toMatchObject({ action: "reactivated", queued: 7 });
    expect(db.state.get("prospeo").exhausted_at).toBeNull();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ provider: "prospeo", reasons: ["sin_creditos", "error"] }), expect.anything());
    expect(notify.mock.calls[0][0]).toContain("Prospeo reactivado");
  });

  it("a provider at 0 is opened before anyone gets a 402; a low balance warns once a day", async () => {
    const notify = vi.fn(async () => undefined);
    const retry = vi.fn(async () => ({ persons: 0, pending_rows: 0 }));
    const now = () => new Date("2026-10-09T15:00:00Z");
    const r = await hourlyTick({ providers: [withBalance("findymail", 0), withBalance("prospeo", 120)], retry: retry as any, notify, now });
    expect(r.map((x) => x.action)).toEqual(["tripped", "low"]);
    expect(db.state.get("findymail").exhausted_at).toBeTruthy();
    await hourlyTick({ providers: [withBalance("findymail", 0), withBalance("prospeo", 110)], retry: retry as any, notify, now });
    const texts = notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(texts.filter((t) => t.includes("saldo bajo"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Findymail") || t.includes("findymail"))).toHaveLength(1);
  });
});
