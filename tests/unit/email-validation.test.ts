import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/prisma", () => ({ default: {} }));

import { decide, debounceVerifier, elvVerifier, evidenceFor, findymailVerifier, qualify, reusableVerification, ServerFacts, validate, Validator, defaultPolicy } from "../../src/services/email-cascade/verify";
import { findEmailCascade, CascadeDeps } from "../../src/services/email-cascade/cascade";
import { CascadeProvider } from "../../src/services/email-cascade/providers";
import { applyCascade } from "../../src/services/email-cascade/rows";
import { toUpsertRow } from "../../src/services/table-rows";

const facts = (f: Partial<ServerFacts> = {}): ServerFacts => ({ mx_provider: "office365", mail_gateway: null, domain_catch_all: null, bad_domain: false, pattern: "first.last", pattern_tier: null, address_status: null, ...f });
const fetchOf = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

function memBreaker() {
  const open = new Map<string, any>();
  const trips: string[] = [];
  return { open, trips, isExhausted: async (id: string) => open.get(id) ?? null, trip: async (id: string, reason: any) => (open.has(id) ? false : (open.set(id, reason), trips.push(id), true)) };
}

describe("validators", () => {
  it("Findymail verify: verified → valid, not verified → invalid, 402 → no credits", async () => {
    expect(await findymailVerifier(fetchOf(200, { email: "a@x.mx", verified: true, provider: "Google" }), () => "k").verify("a@x.mx")).toMatchObject({ kind: "verdict", verdict: "valid", raw: { provider: "Google" } });
    expect(await findymailVerifier(fetchOf(200, { email: "a@x.mx", verified: false, provider: "Google" }), () => "k").verify("a@x.mx")).toMatchObject({ kind: "verdict", verdict: "invalid" });
    expect(await findymailVerifier(fetchOf(402, { error: "no credits" }), () => "k").verify("a@x.mx")).toMatchObject({ kind: "no_credits", reason: "sin_creditos" });
  });

  it("DeBounce reads the code (4 = catch_all); ELV says error_credit when empty", async () => {
    expect(await debounceVerifier(fetchOf(200, { debounce: { code: "4", result: "Risky" }, success: "1" }), () => "k").verify("a@x.mx")).toMatchObject({ verdict: "catch_all" });
    expect(await debounceVerifier(fetchOf(200, { debounce: { code: "5" } }), () => "k").verify("a@x.mx")).toMatchObject({ verdict: "valid" });
    expect(await elvVerifier(fetchOf(200, "error_credit"), () => "k").verify("a@x.mx")).toMatchObject({ kind: "no_credits" });
    expect(await elvVerifier(fetchOf(200, "ok_for_all"), () => "k").verify("a@x.mx")).toMatchObject({ verdict: "catch_all" });
  });

  it("Findymail out of verifier credits → breaker opens once and DeBounce answers; next time Findymail isn't called", async () => {
    const fm = findymailVerifier(fetchOf(402, {}), () => "k");
    const dbFetch = fetchOf(200, { debounce: { code: "4" } });
    const br = memBreaker();
    const deps = { validators: [fm, debounceVerifier(dbFetch, () => "k")], breaker: br as any };
    const r1 = await validate("a@x.mx", deps);
    expect(r1.verification).toMatchObject({ provider: "debounce", verdict: "catch_all" });
    expect(br.trips).toEqual(["findymail_verify"]);
    const spy = vi.spyOn(fm, "verify");
    await validate("b@x.mx", deps);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no validator left → unknown with provider null (awaits revalidation, not discarded)", async () => {
    const br = memBreaker();
    br.open.set("findymail_verify", "sin_creditos");
    const r = await validate("a@x.mx", { validators: [findymailVerifier(fetchOf(200, {}), () => "k")], breaker: br as any });
    expect(r).toMatchObject({ verification: { provider: null, verdict: "unknown" }, called: false });
  });

  it("a recent conclusive verdict by a real verifier is reused; old or unknown ones are not", () => {
    const now = new Date("2026-10-09T00:00:00Z");
    expect(reusableVerification({ provider: "debounce", verdict: "catch_all", checked_at: "2026-10-01T00:00:00Z" }, now)).toBeTruthy();
    expect(reusableVerification({ provider: "debounce", verdict: "catch_all", checked_at: "2026-08-01T00:00:00Z" }, now)).toBeNull();
    expect(reusableVerification({ provider: null, verdict: "valid", checked_at: "2026-10-08T00:00:00Z" }, now)).toBeNull();
    expect(reusableVerification({ provider: "x", verdict: "unknown", checked_at: "2026-10-08T00:00:00Z" }, now)).toBeNull();
  });
});

describe("acceptance policy", () => {
  it("invalid and previously bounced addresses are discarded under every policy", () => {
    for (const p of ["strict", "moderate", "permissive"] as const) {
      expect(decide(p, "invalid", facts()).decision).toBe("discard");
      expect(decide(p, "valid", facts({ address_status: "bounced" })).decision).toBe("discard");
    }
  });

  it("moderate (default): catch_all passes unless there is concrete negative evidence", () => {
    expect(defaultPolicy({})).toBe("moderate");
    expect(decide("moderate", "catch_all", facts())).toEqual({ decision: "accept", reason: null });
    expect(decide("moderate", "catch_all", facts({ mx_provider: "google_workspace" })).decision).toBe("accept");
    expect(decide("moderate", "catch_all", facts({ bad_domain: true }))).toEqual({ decision: "discard", reason: "catch_all_dominio_solo_rebotes" });
    expect(decide("moderate", "catch_all", facts({ pattern_tier: "pattern_contradicted" }))).toEqual({ decision: "discard", reason: "catch_all_patron_reboto" });
    expect(decide("moderate", "catch_all", facts({ mail_gateway: "mimecast" }))).toEqual({ decision: "discard", reason: "catch_all_gateway_mimecast" });
    // Positive evidence about this exact address outweighs the domain's history.
    expect(decide("moderate", "catch_all", facts({ mail_gateway: "mimecast", address_status: "delivered" })).decision).toBe("accept");
    expect(decide("moderate", "valid", facts({ mail_gateway: "mimecast" })).decision).toBe("accept");
    expect(decide("moderate", "unknown", facts()).decision).toBe("revalidate");
    expect(decide("moderate", "risky", facts()).decision).toBe("revalidate");
  });

  it("strict: only valid, or catch_all with a confirmed pattern/address", () => {
    expect(decide("strict", "catch_all", facts())).toEqual({ decision: "discard", reason: "catch_all_sin_evidencia" });
    expect(decide("strict", "catch_all", facts({ pattern_tier: "pattern_confirmed" })).decision).toBe("accept");
    expect(decide("strict", "valid", facts({ bad_domain: true })).decision).toBe("discard");
    expect(decide("strict", "risky", facts()).decision).toBe("discard");
    expect(decide("strict", "unknown", facts()).decision).toBe("revalidate");
  });

  it("permissive: everything but invalid and known bounces", () => {
    expect(decide("permissive", "catch_all", facts({ bad_domain: true, mail_gateway: "mimecast" })).decision).toBe("accept");
    expect(decide("permissive", "unknown", facts()).decision).toBe("accept");
  });

  it("expected bounce follows the audit", () => {
    expect(evidenceFor("valid", facts())).toMatchObject({ tier: "smtp_verified", expected_bounce: 0.04, recommendation: "send" });
    expect(evidenceFor("catch_all", facts())).toMatchObject({ tier: "catch_all_unconfirmed", expected_bounce: 0.27 });
    expect(evidenceFor("catch_all", facts({ mx_provider: "google_workspace" }))).toMatchObject({ tier: "catch_all_google", expected_bounce: 0.52 });
    expect(evidenceFor("catch_all", facts({ pattern_tier: "pattern_confirmed" }))).toMatchObject({ tier: "pattern_confirmed", recommendation: "send" });
    expect(evidenceFor("valid", facts({ mail_gateway: "mimecast" }))).toMatchObject({ expected_bounce: 0.63, recommendation: "do_not_send" });
  });
});

describe("cascade + validation", () => {
  const ana = { linkedin_url: "https://www.linkedin.com/in/ana", first_name: "Ana", last_name: "López", company_domain: "acme.mx" };
  const finder = (id: any, email: string): CascadeProvider & { n: number } => {
    const p: any = { id, label: id, n: 0, configured: () => true, costUsd: () => 0.05, find: async () => (p.n++, { kind: "found", email, verification: null }) };
    return p;
  };
  const verdicts = (map: Record<string, any>): Validator => ({
    id: "findymail_verify", label: "fm", configured: () => true, costUsd: () => 0.005,
    verify: vi.fn(async (e: string) => ({ kind: "verdict" as const, verdict: map[e], confidence: 0.9, raw: { verified: map[e] === "valid" } })),
  });
  function deps(providers: CascadeProvider[], v: Validator, f: Partial<ServerFacts> = {}, cache: any = null) {
    const saved: any[] = [];
    const records: any[] = [];
    const d: CascadeDeps = {
      lookup: async () => cache,
      save: async (_p, found, q) => void saved.push({ found, q }),
      qualify: (email, person, prior, policy) => qualify(email, person, prior, policy, { validators: [v], breaker: memBreaker() as any, facts: async () => facts(f) }),
      attempts: { prior: async () => [], record: async (_k, _p, _c, w) => void records.push(w), closePending: async () => 0 },
      breaker: memBreaker() as any,
      providers,
    };
    return { d, saved, records };
  }

  it("an invalid find is discarded and the next finder is tried", async () => {
    const bz = finder("blitzapi", "ana@acme.mx");
    const pz = finder("prospeo", "a.lopez@acme.mx");
    const m = deps([bz, pz], verdicts({ "ana@acme.mx": "invalid", "a.lopez@acme.mx": "valid" }));
    const r = await findEmailCascade(ana, m.d, { policy: "moderate" });
    expect(r).toMatchObject({ found: true, email: "a.lopez@acme.mx", email_source: "prospeo", email_verification: { provider: "findymail", verdict: "valid" } });
    expect(m.saved.map((s) => s.q.verification.verdict)).toEqual(["invalid", "valid"]);
    expect(m.records.map((w) => [w.provider, w.status])).toEqual([["blitzapi", "found"], ["verify", "not_found"], ["prospeo", "found"]]);
  });

  it("a cached address with a recent verdict is not validated again", async () => {
    const v = verdicts({});
    const cache = { found: true, email: "ana@acme.mx", email_source: "icypeas", email_verification: { provider: "debounce", verdict: "catch_all", checked_at: new Date().toISOString() }, email_found_via: "clay_get_email_external" };
    const m = deps([], v, {}, cache);
    const r = await findEmailCascade(ana, m.d, { policy: "moderate" });
    expect(v.verify).not.toHaveBeenCalled();
    expect(r).toMatchObject({ found: true, from_cache: true, email_source: "icypeas", qualification: { decision: "accept", verification: { provider: "debounce", verdict: "catch_all" } } });
  });

  it("catch_all on a Mimecast domain (moderate) goes to Email Found with its reason, and the row carries the server facts", async () => {
    const m = deps([finder("prospeo", "ana@acme.mx")], verdicts({ "ana@acme.mx": "catch_all" }), { mail_gateway: "mimecast", mx_provider: "other" });
    const r = await findEmailCascade(ana, m.d, { policy: "moderate" });
    expect(r).toMatchObject({ found: false, candidate: { email: "ana@acme.mx", qualification: { decision: "discard", reason: "catch_all_gateway_mimecast" } } });
    const row = applyCascade({ first_name: "Ana", domain: "acme.mx", linkedin_url: ana.linkedin_url }, r);
    expect(row).toMatchObject({ email_found: "ana@acme.mx", email_status: "descartado", discard_reason: "catch_all_gateway_mimecast", email_verdict: "catch_all", mail_gateway: "mimecast", domain_catch_all: "si", send_recommendation: "do_not_send" });
    expect(row.email).toBeUndefined();
    const mapped = toUpsertRow("people", row, 0, { enforceProvenance: true });
    expect(mapped.data).toMatchObject({ "Email Found": "ana@acme.mx", "Email Verdict": "catch_all", "Mail Gateway": "mimecast", "Discard Reason": "catch_all_gateway_mimecast" });
  });

  it("an accepted address lands in Email with verifier, verdict, date, confidence and the validator's raw answer", async () => {
    const m = deps([finder("blitzapi", "ana@acme.mx")], verdicts({ "ana@acme.mx": "valid" }), { mx_provider: "google_workspace" });
    const r = await findEmailCascade(ana, m.d, {});
    const row = applyCascade({ domain: "acme.mx", linkedin_url: ana.linkedin_url }, r);
    const mapped = toUpsertRow("people", row, 0, { enforceProvenance: true });
    expect(mapped.data).toMatchObject({ Email: "ana@acme.mx", "Email Source": "blitzapi", "Email Verifier": "findymail", "Email Verdict": "valid", "Email Confidence": 0.9, "MX Provider": "google_workspace", "Email Validator Response": "{\"verified\":true}" });
    expect(mapped.data["Email Checked At"]).toBeTruthy();
    expect(mapped.sources).toMatchObject({ Email: "blitzapi", "Email Verdict": "findymail" });
  });

  it("unknown (moderate) waits for revalidation: pending 'verify', not discarded", async () => {
    const m = deps([finder("prospeo", "ana@acme.mx")], verdicts({ "ana@acme.mx": "unknown" }));
    const r = await findEmailCascade(ana, m.d, { policy: "moderate" });
    expect(r).toMatchObject({ found: false, pending: [{ provider: "verify", reason: "revalidar" }], candidate: { email: "ana@acme.mx" } });
    expect(m.records.find((w) => w.provider === "verify")).toMatchObject({ status: "pending", reason: "revalidar", email: "ana@acme.mx" });
  });
});
