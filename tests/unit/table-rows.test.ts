import { describe, it, expect } from "vitest";
import { rowRef, tableNames, toUpsertRow, RowError } from "../../src/services/table-rows";

describe("toUpsertRow — people", () => {
  it("maps canonical fields to MailBridge headers and tags the email with its source", () => {
    const row = toUpsertRow("people", {
      first_name: "Ana",
      email: "ana@flete.mx",
      email_source: "BlitzAPI",
      linkedin_url: "https://www.linkedin.com/in/ana/",
      job_title: "CEO",
      score_icp: 8,
    }, 0);
    expect(row).toEqual({
      ref: "li:linkedin.com/in/ana",
      data: {
        "First Name": "Ana",
        Email: "ana@flete.mx",
        "Email Source": "blitzapi",
        "LinkedIn Profile": "https://www.linkedin.com/in/ana/",
        "Job Title": "CEO",
        score_icp: 8, // unknown fields pass through under their own name
      },
      sources: { Email: "blitzapi" },
    });
  });

  it("refuses an email without a source — every email must be traceable to its provider", () => {
    expect(() => toUpsertRow("people", { first_name: "Ana", email: "ana@flete.mx" }, 3)).toThrow(RowError);
    expect(() => toUpsertRow("people", { email: "ana@flete.mx" }, 3)).toThrow(/rows\[3\].*email_source/);
  });

  it("refuses a source that isn't a provider id", () => {
    expect(() => toUpsertRow("people", { email: "a@b.mx", email_source: "Blitz API!" }, 0)).toThrow(/provider id/);
  });

  it("a person without an email needs no source", () => {
    const row = toUpsertRow("people", { first_name: "Beto", linkedin_url: "linkedin.com/in/beto", email: "" }, 0);
    expect(row.sources).toBeUndefined();
    expect(row.data.Email).toBe("");
  });

  it("does not mutate the caller's object", () => {
    const input = { email: "a@b.mx", email_source: "BLITZAPI" };
    toUpsertRow("people", input, 0);
    expect(input.email_source).toBe("BLITZAPI");
  });

  it("rejects non-objects and empty rows", () => {
    expect(() => toUpsertRow("people", null, 0)).toThrow(RowError);
    expect(() => toUpsertRow("people", [1], 0)).toThrow(RowError);
    expect(() => toUpsertRow("people", { ref: "x" }, 0)).toThrow(/no fields/);
  });
});

describe("toUpsertRow — companies", () => {
  it("uses the company headers, so linkedin_url is the Company LinkedIn", () => {
    const row = toUpsertRow("companies", { company: "Fletes MX", domain: "WWW.Fletes.mx", linkedin_url: "linkedin.com/company/fletes" }, 0);
    expect(row.data).toEqual({ Company: "Fletes MX", Domain: "WWW.Fletes.mx", "Company LinkedIn": "linkedin.com/company/fletes" });
    expect(row.sources).toBeUndefined();
  });
});

describe("rowRef — stable identity for the upsert", () => {
  it("prefers an explicit ref, then LinkedIn, then email/domain", () => {
    expect(rowRef("people", { ref: " mine ", linkedin_url: "x" })).toBe("mine");
    expect(rowRef("people", { linkedin_url: "HTTPS://www.LinkedIn.com/in/Ana/?trk=1" })).toBe("li:linkedin.com/in/ana");
    expect(rowRef("people", { email: " Ana@Flete.MX " })).toBe("email:ana@flete.mx");
    expect(rowRef("companies", { domain: "https://www.fletes.mx/contacto" })).toBe("domain:fletes.mx");
  });

  it("falls back to a content hash that doesn't depend on key order", () => {
    const a = rowRef("people", { first_name: "Ana", city: "MTY" });
    expect(a).toMatch(/^hash:[0-9a-f]{32}$/);
    expect(rowRef("people", { city: "MTY", first_name: "Ana" })).toBe(a);
  });
});

describe("tableNames", () => {
  it("first pair has no version; source and date never go in the name", () => {
    expect(tableNames(new Set(), "CK001", "autotransporte MX", ["companies", "people"])).toEqual({
      companies: "CK001 — Empresas autotransporte MX",
      people: "CK001 — Personas autotransporte MX",
    });
  });

  it("a collision versions both tables of the pair together", () => {
    const existing = new Set([
      "CK001 — Personas autotransporte MX",
      "CK001 — Empresas autotransporte MX v2",
    ]);
    expect(tableNames(existing, "CK001", "autotransporte MX", ["companies", "people"])).toEqual({
      companies: "CK001 — Empresas autotransporte MX v3",
      people: "CK001 — Personas autotransporte MX v3",
    });
  });
});

describe("toUpsertRow — email verdict (provenance)", () => {
  const base = { first_name: "Ana", email: "ana@flete.mx", email_source: "blitzapi" };
  const enforce = { enforceProvenance: true };

  it("enforced: an email with a source but no verdict is rejected with an actionable message", () => {
    expect(() => toUpsertRow("people", base, 2, enforce)).toThrow(/rows\[2\].*missing: email_verification\.verdict.*"verdict": "unknown"/);
  });

  it("not enforced (default): the same row is accepted unchanged, so current callers keep working", () => {
    const row = toUpsertRow("people", base, 0, { enforceProvenance: false });
    expect(row.data["Email Verdict"]).toBeUndefined();
    expect(row.sources).toEqual({ Email: "blitzapi" });
  });

  it("nested email_verification becomes columns MailBridge keeps as variables, and the verifier is the verdict's source", () => {
    const row = toUpsertRow("people", { ...base, email_verification: { provider: "debounce", verdict: "valid", confidence: 0.9, checked_at: "2026-10-01T00:00:00Z" } }, 0, enforce);
    expect(row.data).toMatchObject({
      Email: "ana@flete.mx", "Email Source": "blitzapi", "Email Verifier": "debounce", "Email Verdict": "valid",
      "Email Checked At": "2026-10-01T00:00:00.000Z", "Email Confidence": 0.9,
    });
    expect(row.data.email_verification).toBeUndefined();
    expect(row.sources).toEqual({ Email: "blitzapi", "Email Verdict": "debounce" });
  });

  it("an unverified address says so explicitly: verdict unknown, no verifier", () => {
    const row = toUpsertRow("people", { ...base, email_verification: { provider: null, verdict: "unknown" } }, 0, enforce);
    expect(row.data["Email Verdict"]).toBe("unknown");
    expect(row.data["Email Verifier"]).toBeUndefined();
    expect(row.sources).toEqual({ Email: "blitzapi" });
  });

  it("the legacy email_status 'valido' (what create_table.py and the Blitz build send) counts as a valid verdict", () => {
    const row = toUpsertRow("people", { ...base, email_status: "valido" }, 0, enforce);
    expect(row.data["Email Verdict"]).toBe("valid");
    expect(row.data["Email Status"]).toBe("valido");
  });

  it("a bad verdict is rejected even though the source is fine", () => {
    expect(() => toUpsertRow("people", { ...base, email_verdict: "maybe" }, 0, enforce)).toThrow(/'maybe' is not one of/);
  });

  it("a person without an email needs no verdict", () => {
    expect(() => toUpsertRow("people", { first_name: "Beto", linkedin_url: "linkedin.com/in/beto" }, 0, enforce)).not.toThrow();
  });
});

import { personRow } from "../../src/services/table-build";

describe("Blitz list build vs enforced provenance", () => {
  it("every row the background build emits already satisfies the mandatory rule", () => {
    const withEmail = personRow({ first_name: "Ana", linkedin_url: "https://linkedin.com/in/ana" }, {}, { domain: "flete.mx" }, { found: true, email: "ana@flete.mx" });
    expect(withEmail.email).toBe("ana@flete.mx");
    expect(() => toUpsertRow("people", withEmail, 0, { enforceProvenance: true })).not.toThrow();
    const noEmail = personRow({ first_name: "Beto", linkedin_url: "https://linkedin.com/in/beto" }, {}, { domain: "flete.mx" }, { found: false });
    expect(() => toUpsertRow("people", noEmail, 0, { enforceProvenance: true })).not.toThrow();
  });
});
