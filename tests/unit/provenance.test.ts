import { describe, it, expect } from "vitest";
import {
  PROVIDER_RE,
  callerGaveDate,
  deriveProvenance,
  deterministicId,
  ingestEntry,
  isFreshFact,
  legacyProvenance,
  normalizeProvider,
  normalizeVerdict,
  provenanceEnforced,
  provenanceFields,
  splitIngestFields,
  storedProvenance,
  toEvidenceRows,
  validateIngestProvenance,
  ProvenanceEntry,
} from "../../src/email-finder/provenance";
import { EmailStatus, VerificationMethod, VerificationResult } from "../../src/email-finder/types";

const NOW = new Date("2026-10-09T12:00:00.000Z");

function res(over: Partial<VerificationResult>): VerificationResult {
  return {
    email: "ana@acme.com", status: EmailStatus.valid, confidence: 0.9, method: VerificationMethod.emaillistverify,
    pattern: null, domain_info: null, serp_info: null, permutations_tried: 0, cost_usd: 0.004, duration_ms: 1, ...over,
  };
}

describe("normalizeVerdict", () => {
  it("maps this service's statuses to the five verdicts, like MailBridge does for clay_cache", () => {
    expect(normalizeVerdict("valid")).toBe("valid");
    expect(normalizeVerdict("disposable")).toBe("risky");
    expect(normalizeVerdict("no_mx")).toBe("invalid");
    expect(normalizeVerdict("role_account")).toBe("risky");
    expect(normalizeVerdict("catch_all")).toBe("catch_all");
  });
  it("accepts provider spellings and tolerates case, spaces and dashes", () => {
    expect(normalizeVerdict("Safe to Send")).toBe("valid");
    expect(normalizeVerdict("Accept-All")).toBe("catch_all");
    expect(normalizeVerdict("valido")).toBe("valid");
  });
  it("returns null for a word it doesn't know (the caller decides: 400 on ingest, 'unknown' on a pipeline answer)", () => {
    expect(normalizeVerdict("maybe")).toBeNull();
    expect(normalizeVerdict(undefined)).toBeNull();
  });
});

describe("normalizeProvider", () => {
  it("matches MailBridge's provider regex", () => {
    expect(PROVIDER_RE.test("clay_cache")).toBe(true);
    expect(normalizeProvider(" FindyMail ")).toBe("findymail");
    expect(normalizeProvider("x")).toBeNull(); // too short
    expect(normalizeProvider("Blitz API!")).toBeNull();
    expect(normalizeProvider("-bad")).toBeNull();
    expect(normalizeProvider("a".repeat(61))).toBeNull();
    expect(normalizeProvider(3)).toBeNull();
  });
});

describe("isFreshFact / deriveProvenance", () => {
  it("a paid provider verification is a fresh fact; the same method at zero cost is a cache echo", () => {
    expect(isFreshFact(res({ cost_usd: 0.004 }))).toBe(true);
    expect(isFreshFact(res({ cost_usd: 0 }))).toBe(false);
  });
  it("pattern guesses are fresh; refusals, known_email and MailBridge's own verdicts are never facts", () => {
    expect(isFreshFact(res({ method: VerificationMethod.domain_pattern, cost_usd: 0 }))).toBe(true);
    for (const m of [VerificationMethod.known_email, VerificationMethod.mailbridge_outcome, VerificationMethod.domain_muted, VerificationMethod.local_dns, VerificationMethod.domain_bounces]) {
      expect(isFreshFact(res({ method: m }))).toBe(false);
    }
    expect(isFreshFact(res({ email: null }))).toBe(false);
  });

  it("/find verified by a provider: this cache spelled it (finder clay_cache), the provider verified it", () => {
    const p = deriveProvenance(res({}), { op: "find", now: NOW });
    expect(p).toMatchObject({ finder: "clay_cache", verifier: "emaillistverify", verdict: "valid", method: "emaillistverify", raw_status: "valid", checked_at: NOW.toISOString() });
  });
  it("/find by pattern guess: finder clay_cache, nobody verified", () => {
    const p = deriveProvenance(res({ method: VerificationMethod.domain_pattern, status: EmailStatus.catch_all, cost_usd: 0 }), { op: "find", now: NOW });
    expect(p).toMatchObject({ finder: "clay_cache", verifier: null, verdict: "catch_all", method: "domain_pattern" });
  });
  it("/find whose address a SERP hit spelled exactly: finder serper", () => {
    const serp = { used: true, emails_found: 1, patterns_detected: [], direct_match: "ana@acme.com" };
    expect(deriveProvenance(res({ serp_info: serp }), { op: "find", now: NOW }).finder).toBe("serper");
  });
  it("/verify of a bare address has no known finder; known_email takes the provider recorded at ingest", () => {
    expect(deriveProvenance(res({}), { op: "verify", now: NOW }).finder).toBeNull();
    const known = res({ method: VerificationMethod.known_email, cost_usd: 0 });
    expect(deriveProvenance(known, { op: "verify", profileSource: "findymail", now: NOW }).finder).toBe("findymail");
    expect(deriveProvenance(known, { op: "verify", now: NOW }).finder).toBeNull();
    expect(deriveProvenance(known, { op: "find", now: NOW }).finder).toBe("clay_cache");
  });
  it("an answer served from cache says when it was really verified, not now", () => {
    const cachedAt = new Date("2026-09-20T00:00:00Z");
    const p = deriveProvenance(res({ cost_usd: 0 }), { op: "verify", cachedAt, now: NOW });
    expect(p.checked_at).toBe(cachedAt.toISOString());
  });
  it("normalizes odd statuses and says unknown for an answer with no email", () => {
    expect(deriveProvenance(res({ status: EmailStatus.no_mx, method: null }), { op: "find", now: NOW }).verdict).toBe("invalid");
    expect(deriveProvenance(res({ email: null, status: EmailStatus.unknown, method: null }), { op: "find", now: NOW })).toMatchObject({ finder: null, verifier: null, verdict: "unknown" });
  });
  it("a MailBridge hard bounce surfaces as verdict invalid plus the hard_bounced flag", () => {
    const bounced = res({ status: EmailStatus.invalid, method: VerificationMethod.mailbridge_outcome, cost_usd: 0 });
    expect(provenanceFields({ ...bounced, verdict: "invalid" })).toMatchObject({ verdict: "invalid", hard_bounced: true });
    expect(provenanceFields(res({ verdict: "valid" })).hard_bounced).toBe(false);
  });
});

describe("validateIngestProvenance", () => {
  const good = { email_source: "findymail", email_verification: { provider: "emaillistverify", verdict: "valid", confidence: 0.9, checked_at: "2026-10-01T00:00:00Z" } };

  it("accepts the nested form and normalizes it", () => {
    const r = validateIngestProvenance(good);
    expect(r).toEqual({ ok: true, provenance: { finder: "findymail", verifier: "emaillistverify", verdict: "valid", confidence: 0.9, checked_at: "2026-10-01T00:00:00.000Z" } });
  });
  it("accepts a null verifier (nobody verified) but still requires the verdict, 'unknown' being explicit", () => {
    const r = validateIngestProvenance({ email_source: "blitzapi", email_verification: { provider: null, verdict: "unknown" } });
    expect(r.ok && r.provenance.verifier).toBeNull();
    expect(r.ok && r.provenance.verdict).toBe("unknown");
  });
  it("accepts the flat form Clay columns find easier", () => {
    const r = validateIngestProvenance({ email_source: "Findymail", email_verifier: "DeBounce", email_verdict: "Safe to Send" });
    expect(r.ok && r.provenance).toMatchObject({ finder: "findymail", verifier: "debounce", verdict: "valid" });
  });
  it("lists every missing field in the message", () => {
    const r = validateIngestProvenance({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(["email_source", "email_verification.verdict"]);
      expect(r.message).toContain("missing: email_source, email_verification.verdict");
      expect(r.message).toContain('"verdict": "unknown"');
    }
  });
  it("a source with no verdict is still a 400: silence is not an answer", () => {
    const r = validateIngestProvenance({ email_source: "findymail" });
    expect(!r.ok && r.missing).toEqual(["email_verification.verdict"]);
  });
  it("names each invalid value", () => {
    const r = validateIngestProvenance({ email_source: "Blitz API!", email_verification: { provider: "x", verdict: "maybe", confidence: 2, checked_at: "yesterday" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/email_source 'Blitz API!' is not a provider id/);
      expect(r.message).toMatch(/verdict 'maybe' is not one of/);
      expect(r.message).toMatch(/provider 'x' is not a provider id/);
      expect(r.message).toMatch(/confidence must be a number between 0 and 1/);
      expect(r.message).toMatch(/checked_at 'yesterday' is not a date/);
    }
  });
  it("rejects an email_verification that is not an object", () => {
    const r = validateIngestProvenance({ email_source: "findymail", email_verification: "valid" });
    expect(!r.ok && r.message).toMatch(/must be an object/);
  });
});

describe("enforcement switch", () => {
  it("is off unless PROVENANCE_ENFORCE says so", () => {
    expect(provenanceEnforced({})).toBe(false);
    expect(provenanceEnforced({ PROVENANCE_ENFORCE: "false" })).toBe(false);
    expect(provenanceEnforced({ PROVENANCE_ENFORCE: "true" })).toBe(true);
    expect(provenanceEnforced({ PROVENANCE_ENFORCE: "1" })).toBe(true);
  });
});

describe("ingest helpers", () => {
  it("splits provenance fields from the profile's own data", () => {
    const { fields, rest } = splitIngestFields({ first_name: "Ana", email_source: "x1", email_verifier: "debounce", job_title: "CEO" });
    expect(fields).toEqual({ email_source: "x1", email_verifier: "debounce" });
    expect(rest).toEqual({ first_name: "Ana", job_title: "CEO" });
    expect(callerGaveDate({ email_verification: { checked_at: "2026-01-01" } })).toBe(true);
    expect(callerGaveDate({ email_checked_at: "" })).toBe(false);
  });
  it("stores a fixed shape in the profile's data", () => {
    const r = validateIngestProvenance({ email_source: "findymail", email_verdict: "valid" });
    expect(r.ok && storedProvenance(r.provenance)).toMatchObject({ email_source: "findymail", email_verification: { provider: null, verdict: "valid" } });
  });
  it("re-posting the same claim yields the same fact id (no duplicate evidence), a new claim a new one", () => {
    const p = { finder: "findymail", verifier: null, verdict: "valid" as const, confidence: null, checked_at: "2026-10-09T00:00:00.000Z" };
    expect(ingestEntry("a@b.com", p, false).id).toBe(ingestEntry("a@b.com", { ...p, checked_at: "2026-10-10T00:00:00.000Z" }, false).id);
    expect(ingestEntry("a@b.com", p, true).id).not.toBe(ingestEntry("a@b.com", { ...p, checked_at: "2026-10-10T00:00:00.000Z" }, true).id);
    expect(ingestEntry("a@b.com", p, false).id).not.toBe(ingestEntry("a@b.com", { ...p, verdict: "invalid" }, false).id);
    expect(deterministicId("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("legacy rows map method to verifier/finder", () => {
    expect(legacyProvenance("backfill_search", "debounce", "invalid")).toMatchObject({ finder: "clay_cache", verifier: "debounce", verdict: "invalid" });
    expect(legacyProvenance("backfill_cache", "emaillistverify", "disposable")).toMatchObject({ finder: null, verifier: "emaillistverify", verdict: "risky", raw_status: "disposable" });
    expect(legacyProvenance("backfill_cache", "domain_pattern", "catch_all")).toMatchObject({ finder: "clay_cache", verifier: null });
  });
});

describe("toEvidenceRows (MailBridge POST /email-evidence)", () => {
  const entry: ProvenanceEntry = {
    id: "11111111-1111-4111-8111-111111111111", email: "ana@acme.com", finder: "clay_cache", verifier: "emaillistverify",
    verdict: "valid", raw_status: "valid", confidence: 0.9, method: "emaillistverify", origin: "find", checked_at: NOW.toISOString(),
  };
  it("sends the finder's claim as `found` and the verifier's as `verified`, with stable refs", () => {
    const [found, verified] = toEvidenceRows(entry);
    expect(found).toMatchObject({ kind: "found", provider: "clay_cache", sourceRef: `ccache:find:${entry.id}`, occurredAt: NOW.toISOString() });
    expect(found.verdict).toBeUndefined(); // the verdict is the verifier's
    expect(verified).toMatchObject({ kind: "verified", provider: "emaillistverify", verdict: "valid", confidence: 0.9, sourceRef: `ccache:verify:${entry.id}` });
    expect(toEvidenceRows(entry)).toEqual([found, verified]);
  });
  it("with no verifier the verdict rides on the `found` row", () => {
    const rows = toEvidenceRows({ ...entry, verifier: null, verdict: "catch_all", confidence: 0.6 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "found", provider: "clay_cache", verdict: "catch_all", confidence: 0.6 });
  });
  it("a /verify with no known finder sends only `verified`", () => {
    const rows = toEvidenceRows({ ...entry, finder: null, origin: "verify" });
    expect(rows.map((r) => r.kind)).toEqual(["verified"]);
  });
  it("never sends a provider MailBridge would reject", () => {
    expect(toEvidenceRows({ ...entry, finder: "Bad Name", verifier: null })).toEqual([]);
  });
  it("ingest facts use their own stem", () => {
    expect(toEvidenceRows({ ...entry, origin: "ingest", verifier: null })[0].sourceRef).toBe(`ccache:ingest:${entry.id}`);
  });
});
