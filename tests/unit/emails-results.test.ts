import { describe, it, expect, vi, beforeEach } from "vitest";

const saved: any[] = [];
vi.mock("../../src/db/prisma", () => ({ default: {} }));
vi.mock("../../src/services/email-cascade/cache", () => ({
  lookupCachedEmail: vi.fn(async () => null),
  saveFoundEmail: vi.fn(async (...args: any[]) => { saved.push(args); }),
}));
vi.mock("../../src/services/email-cascade/facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/email-cascade/facts")>();
  return {
    ...actual,
    serverFacts: vi.fn(async () => ({ ...actual.EMPTY_FACTS, mx_provider: "office365", mail_gateway: "mimecast" })),
  };
});

import { emailsController } from "../../src/controllers/emails.controller";

function call(handler: (req: any, res: any) => Promise<void>, body: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null };
  const res = { status(code: number) { out.status = code; return this; }, json(b: unknown) { out.body = b; return this; } };
  return handler({ body }, res).then(() => out);
}

describe("POST /emails/facts and /emails/results (MailBridge spec 109)", () => {
  beforeEach(() => { saved.length = 0; });

  it("facts: free server facts for an address", async () => {
    const r = await call(emailsController.facts, { email: "Ana@Acme.mx", first_name: "Ana" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mx_provider: "office365", mail_gateway: "mimecast" });
    expect((await call(emailsController.facts, {})).status).toBe(400);
  });

  it("results: a verified find is saved with its finder, verifier and evidence", async () => {
    const r = await call(emailsController.results, {
      linkedin_url: "https://www.linkedin.com/in/ana", first_name: "Ana", last_name: "López", company_domain: "acme.mx",
      email: "ana@acme.mx", email_source: "prospeo",
      verification: { provider: "findymail", verdict: "valid", checked_at: "2026-10-09T00:00:00Z", confidence: 0.9 },
      facts: { mx_provider: "google_workspace", bad_domain: false },
    });
    expect(r.body).toMatchObject({ saved: true, email_source: "prospeo", verdict: "valid" });
    const [person, found, q, opts] = saved[0];
    expect(person).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/ana", company_domain: "acme.mx" });
    expect(found).toMatchObject({ email: "ana@acme.mx", source: "prospeo" });
    expect(q).toMatchObject({ verification: { provider: "findymail", verdict: "valid" }, evidence: "smtp_verified", send_recommendation: "send", facts: { mx_provider: "google_workspace" } });
    expect(opts).toEqual({ foundVia: "mailbridge_table" });
  });

  it("results: a find without verdict is saved as found; without identity it is rejected", async () => {
    await call(emailsController.results, { linkedin_url: "li", email: "beto@acme.mx", email_source: "findymail" });
    expect(saved[0][1]).toMatchObject({ email: "beto@acme.mx", source: "findymail", verification: null });
    expect(saved[0][2]).toBeUndefined();
    expect((await call(emailsController.results, { email: "x@acme.mx" })).status).toBe(400);
  });
});
