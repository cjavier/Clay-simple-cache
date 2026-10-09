import { describe, it, expect, vi, beforeEach } from "vitest";
import { companyRow, currentExperience, emailOutcome, junkReason, personRow } from "../../src/services/table-build";
import { parseBuild } from "../../src/controllers/tables.controller";

describe("junkReason (rule 5)", () => {
  it("flags placeholders, no-reply and generic inboxes; passes a person", () => {
    expect(junkReason("trilles.placeholder@acme.mx")).toBe("basura:placeholder");
    expect(junkReason("no-reply@acme.mx")).toBe("basura:no-reply");
    expect(junkReason("Ventas@acme.mx")).toBe("generico:ventas@");
    expect(junkReason("ana.lopez@acme.mx")).toBe("");
    expect(junkReason("")).toBe("sin_correo");
  });
});

describe("emailOutcome", () => {
  it("valid, not found, discarded, error, not searched", () => {
    expect(emailOutcome({ found: true, email: "ana@acme.mx" }).status).toBe("valido");
    expect(emailOutcome({ found: false }).status).toBe("no_encontrado");
    expect(emailOutcome({ found: true, email: "info@acme.mx" })).toMatchObject({ status: "descartado", reason: "generico:info@" });
    expect(emailOutcome({ found: false, error: "timeout" }).status).toBe("error");
    expect(emailOutcome(null).status).toBe("no_buscado");
  });
});

describe("personRow", () => {
  const company = { name: "Fletes", domain: "fletes.mx", linkedin_url: "https://linkedin.com/company/fletes", industry: "Truck Transportation", hq: { state: "Nuevo León" } };
  const person = { first_name: "Ana", linkedin_url: "https://www.linkedin.com/in/ana", location: { city: "Monterrey", country_code: "MX" } };
  const exp = { job_title: "CEO", company_linkedin_url: company.linkedin_url };

  it("a valid email carries its source and the company data", () => {
    const r = personRow(person, exp, company, { found: true, email: "ana@fletes.mx", all_emails: ["ana@fletes.mx", "a@fletes.mx"] });
    expect(r).toMatchObject({
      first_name: "Ana", job_title: "CEO", company: "Fletes", email: "ana@fletes.mx", email_source: "blitzapi",
      email_status: "valido", domain_match: "si", other_emails: "a@fletes.mx", company_state: "Nuevo León",
    });
  });

  it("a discarded email stays out of Email but keeps its source on Email Found", () => {
    const r = personRow(person, exp, company, { found: true, email: "ventas@fletes.mx" });
    expect(r.email).toBeUndefined();
    expect(r).toMatchObject({ email_found: "ventas@fletes.mx", email_source: "blitzapi", email_status: "descartado" });
  });

  it("no email → no source, no empty fields", () => {
    const r = personRow(person, exp, company, { found: false });
    expect(r.email_source).toBeUndefined();
    expect(Object.values(r)).not.toContain("");
  });

  it("an address on another domain is marked for review", () => {
    expect(personRow(person, exp, company, { found: true, email: "ana@grupo.com" }).domain_match).toBe("no");
  });
});

describe("currentExperience", () => {
  it("prefers the current job at a company of the batch", () => {
    const p = { experiences: [
      { job_is_current: true, company_linkedin_url: "https://linkedin.com/company/otra" },
      { job_is_current: true, company_linkedin_url: "https://www.linkedin.com/company/fletes/" },
    ] };
    expect(currentExperience(p, new Set(["https://www.linkedin.com/company/fletes"])).company_linkedin_url).toContain("fletes");
  });
});

describe("companyRow", () => {
  it("counts contacts and joins specialties", () => {
    expect(companyRow({ name: "Fletes", specialties: ["carga", "refrigerado"] }, 4, 1)).toMatchObject({
      company: "Fletes", specialties: "carga;refrigerado", contacts_found: 4, contacts_with_email: 1,
    });
  });
});

describe("parseBuild", () => {
  it("requires a company filter and bounds max_companies", () => {
    expect(parseBuild({})).toMatch(/company/);
    expect(parseBuild({ company: {}, people: {} })).toMatch(/company/);
    expect(parseBuild({ company: { industry: {} }, max_companies: 0 })).toMatch(/max_companies/);
    expect(parseBuild({ company: { industry: {} }, max_companies: 60000 })).toMatch(/max_companies/);
  });
  it("defaults to the whole TAM with emails, and computes the need", () => {
    expect(parseBuild({ company: { hq: {} }, monthly: 1000, months: 2 })).toEqual({
      company: { hq: {} }, people: {}, max_companies: 50000, find_emails: true, needed: 2000,
    });
  });
});
