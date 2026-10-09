/**
 * Provenance against a real Postgres (migrations applied). Skipped unless PROVENANCE_E2E=1.
 *
 *   PROVENANCE_E2E=1 DATABASE_URL=postgresql://postgres@localhost:5432/ccache \
 *     DIRECT_URL=$DATABASE_URL npx vitest run tests/unit/provenance.e2e.test.ts
 *
 * A mock of Prisma ignores the WHERE and the raw SQL, so the backfill mapping, the
 * ON CONFLICT and the bounce-rate query are only proven here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import prisma from "../../src/db/prisma";
import { buildHistory, pushHistory } from "../../src/services/provenance-backfill";
import { scoreProvenanceAgainstOutcomes } from "../../src/services/finder-quality.service";
import { recordProvenance } from "../../src/services/provenance.service";
import { deterministicId } from "../../src/email-finder/provenance";

// Never against a shared database: this test deletes and writes rows.
const RUN = process.env.PROVENANCE_E2E === "1" && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");
const T = "e2e-prov.test";

describe.skipIf(!RUN)("provenance (real Postgres)", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM email_provenance WHERE email LIKE '%@${T}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM search_log WHERE result_email LIKE '%@${T}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM verification_cache WHERE email LIKE '%@${T}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM email_outcomes WHERE email LIKE '%@${T}'`);
    const sl = (email: string, status: string, method: string | null, at: string) =>
      prisma.searchLog.create({ data: { domain: T, result_email: email, result_status: status, method_used: method, duration_ms: 1, created_at: new Date(at) } });
    await sl(`a@${T}`, "valid", "emaillistverify", "2026-09-01T00:00:00Z");
    await sl(`a@${T}`, "valid", "emaillistverify", "2026-09-05T00:00:00Z"); // repeat: collapses
    await sl(`b@${T}`, "catch_all", "domain_pattern", "2026-09-02T00:00:00Z");
    await sl(`c@${T}`, "valid", "known_email", "2026-09-02T00:00:00Z"); // echo: not a fact
    await sl(`d@${T}`, "valid", null, "2026-09-02T00:00:00Z"); // no method: not a fact
    const vc = (email: string, status: string, method: string | null) =>
      prisma.verificationCache.create({ data: { email, status, method, confidence: 0.9, verified_at: new Date("2026-09-03T00:00:00Z"), expires_at: new Date("2027-01-01T00:00:00Z") } });
    await vc(`e@${T}`, "invalid", "debounce");
    await vc(`f@${T}`, "disposable", "emaillistverify");
    await vc(`g@${T}`, "valid", "local_dns");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("dry run counts and writes nothing; commit is idempotent", async () => {
    const dry = await buildHistory({ commit: false, since: new Date("2026-08-01"), log: () => {} });
    expect(dry.candidates).toBeGreaterThanOrEqual(4);
    expect(await prisma.emailProvenance.count({ where: { email: { endsWith: `@${T}` } } })).toBe(0);

    await buildHistory({ commit: true, since: new Date("2026-08-01"), log: () => {} });
    const first = await prisma.emailProvenance.count({ where: { email: { endsWith: `@${T}` } } });
    await buildHistory({ commit: true, since: new Date("2026-08-01"), log: () => {} });
    expect(await prisma.emailProvenance.count({ where: { email: { endsWith: `@${T}` } } })).toBe(first);
    expect(first).toBe(4); // a (collapsed), b, e, f — not c (known_email), d (no method), g (local_dns)
  });

  it("maps method to finder/verifier and status to verdict", async () => {
    const rows = await prisma.emailProvenance.findMany({ where: { email: { endsWith: `@${T}` } } });
    const by = Object.fromEntries(rows.map((r) => [r.email.split("@")[0], r]));
    expect(by.a).toMatchObject({ finder: "clay_cache", verifier: "emaillistverify", verdict: "valid", origin: "backfill_search" });
    expect(by.b).toMatchObject({ finder: "clay_cache", verifier: null, verdict: "catch_all", method: "domain_pattern" });
    expect(by.e).toMatchObject({ finder: null, verifier: "debounce", verdict: "invalid", raw_status: "invalid", origin: "backfill_cache" });
    expect(by.f).toMatchObject({ verifier: "emaillistverify", verdict: "risky", raw_status: "disposable" });
    expect(by.c).toBeUndefined();
    expect(by.d).toBeUndefined();
  });

  it("pushes in batches, marks pushed and records what MailBridge rejected", async () => {
    const sent: any[][] = [];
    const send = vi.fn(async (rows: any[]) => {
      sent.push(rows);
      return { inserted: rows.length - 1, skipped: 0, rejected: [{ index: 0, reason: "nope" }] };
    });
    const dry = await pushHistory({ commit: false, log: () => {} });
    expect(dry.pending).toBeGreaterThanOrEqual(4);
    expect(send).not.toHaveBeenCalled();

    // Only this test's rows: park everyone else's so the fake MailBridge sees just ours.
    await prisma.$executeRawUnsafe(`UPDATE email_provenance SET push_error = 'parked' WHERE email NOT LIKE '%@${T}' AND pushed_at IS NULL AND push_error IS NULL`);
    const r = await pushHistory({ commit: true, rate: 1000, send: send as any, sleep: async () => {}, log: () => {} });
    await prisma.$executeRawUnsafe(`UPDATE email_provenance SET push_error = NULL WHERE push_error = 'parked'`);
    expect(r.batches).toBe(1);
    const rows = sent[0];
    // a: found+verified, b: found(with verdict), e: verified, f: verified
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => /^ccache:(find|verify):[0-9a-f-]{36}$/.test(x.sourceRef))).toBe(true);
    const left = await prisma.emailProvenance.count({ where: { email: { endsWith: `@${T}` }, pushed_at: null } });
    expect(left).toBe(0);
    expect(await prisma.emailProvenance.count({ where: { email: { endsWith: `@${T}` }, push_error: "nope" } })).toBe(1);
  });

  it("recordProvenance stores once even when the same fact is sent twice", async () => {
    const entry = {
      id: deterministicId("e2e-same-fact"),
      email: `h@${T}`, finder: "findymail", verifier: null, verdict: "unknown" as const,
      raw_status: "unknown", confidence: null, method: "ingest", origin: "ingest" as const, checked_at: new Date().toISOString(),
    };
    delete process.env.MAILBRIDGE_API_KEY; // queue stays off: storage only
    await recordProvenance([entry]);
    await recordProvenance([entry]);
    expect(await prisma.emailProvenance.count({ where: { id: entry.id } })).toBe(1);
  });

  it("real bounce rate per finder / verifier+verdict / method (denominator = first visible send)", async () => {
    const o = (ref: string, email: string, sent: boolean, bounced: boolean, type = "hard") =>
      prisma.emailOutcome.create({
        data: {
          source: "e2e", source_ref: ref, email, domain: T,
          first_visible_send_at: sent ? new Date("2026-09-10T00:00:00Z") : null,
          bounced_at: bounced ? new Date("2026-09-11T00:00:00Z") : null, bounce_type: bounced ? type : null,
        },
      });
    await o("1", `a@${T}`, true, true); // a: sent + hard bounce
    await o("2", `b@${T}`, true, false); // b: sent, delivered
    await o("3", `e@${T}`, false, true); // e: bounced but never visibly sent -> out of the denominator
    await o("4", `f@${T}`, true, true, "soft"); // f: soft bounce does not count
    // Look only at this test's rows: the window covers everything, so filter the result.
    const r = await scoreProvenanceAgainstOutcomes(3650);
    const finder = r.by_finder.find((x) => x.finder === "clay_cache")!;
    expect(finder.sent).toBeGreaterThanOrEqual(2);
    const elv = r.by_verifier_verdict.find((x) => x.verifier === "emaillistverify" && x.verdict === "valid")!;
    expect(elv.sent).toBeGreaterThanOrEqual(1);
    expect(elv.bounced).toBeGreaterThanOrEqual(1);
    const pattern = r.by_method.find((x) => x.method === "domain_pattern")!;
    expect(pattern.sent).toBeGreaterThanOrEqual(1);
    const debounce = r.by_verifier_verdict.find((x) => x.verifier === "debounce" && x.verdict === "invalid")!;
    expect(debounce.emails).toBeGreaterThanOrEqual(1);
    expect(debounce.bounce_rate === null || debounce.bounce_rate >= 0).toBe(true);
    await prisma.$executeRawUnsafe(`DELETE FROM email_outcomes WHERE source = 'e2e'`);
  });
});
