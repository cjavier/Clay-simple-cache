import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/prisma", () => ({ default: {} }));

import { decide, evidenceFor, reusableVerification, ServerFacts } from "../../src/services/email-cascade/facts";

const facts = (f: Partial<ServerFacts> = {}): ServerFacts => ({ mx_provider: "office365", mail_gateway: null, domain_catch_all: null, bad_domain: false, pattern: "first.last", pattern_tier: null, address_status: null, ...f });

/**
 * The cache no longer validates or decides for a list (MailBridge's email
 * columns do, spec 109 there). `decide` stays for the one free decision the
 * build still makes — whether a cached address with a recent verdict goes
 * straight to Email — and it must match MailBridge's decideEmail().
 */
describe("reusable verdicts", () => {
  it("a recent conclusive verdict by a real verifier is reused; old, unknown or verifier-less ones are not", () => {
    const now = new Date("2026-10-09T00:00:00Z");
    expect(reusableVerification({ provider: "debounce", verdict: "valid", checked_at: "2026-10-01T00:00:00Z" }, now)?.verdict).toBe("valid");
    expect(reusableVerification({ provider: "debounce", verdict: "valid", checked_at: "2026-08-01T00:00:00Z" }, now)).toBeNull();
    expect(reusableVerification({ provider: "debounce", verdict: "unknown", checked_at: "2026-10-01T00:00:00Z" }, now)).toBeNull();
    expect(reusableVerification({ provider: null, verdict: "valid", checked_at: "2026-10-01T00:00:00Z" }, now)).toBeNull();
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
    expect(decide("moderate", "catch_all", facts())).toEqual({ decision: "accept", reason: null });
    expect(decide("moderate", "catch_all", facts({ mx_provider: "google_workspace" })).decision).toBe("accept");
    expect(decide("moderate", "catch_all", facts({ bad_domain: true }))).toEqual({ decision: "discard", reason: "catch_all_dominio_solo_rebotes" });
    expect(decide("moderate", "catch_all", facts({ pattern_tier: "pattern_contradicted" }))).toEqual({ decision: "discard", reason: "catch_all_patron_reboto" });
    // Mimecast no longer discards (Javier, 2026-10-09); it stays in the recommendation.
    expect(decide("moderate", "catch_all", facts({ mail_gateway: "mimecast" }))).toEqual({ decision: "accept", reason: null });
    expect(decide("strict", "valid", facts({ mail_gateway: "mimecast" })).decision).toBe("accept");
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

