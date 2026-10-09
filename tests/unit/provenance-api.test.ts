import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";

const { pipeline, enqueue } = vi.hoisted(() => ({ pipeline: { find: vi.fn(), verify: vi.fn() }, enqueue: vi.fn() }));

vi.mock("../../src/db/prisma", () => ({
  default: {
    profile: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    emailProvenance: { createMany: vi.fn(async () => ({ count: 1 })) },
    emailOutcome: { findMany: vi.fn(async () => []) },
    verificationCache: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  },
}));
vi.mock("../../src/email-finder/pipeline", () => ({
  findEmail: pipeline.find,
  verifySingleEmail: pipeline.verify,
  normalizeName: (s: string) => s,
}));
vi.mock("../../src/services/evidence-push.service", async (orig) => ({
  ...(await orig<typeof import("../../src/services/evidence-push.service")>()),
  evidencePusher: { enqueue },
  startEvidenceSweeper: vi.fn(),
}));

import app from "../../src/app";
import prisma from "../../src/db/prisma";
import { EMPTY_RESULT } from "./provenance-fixtures";

const db = prisma as any;
const auth = { Authorization: "Bearer prov-test-key" };
const good = { email_source: "findymail", email_verification: { provider: "emaillistverify", verdict: "valid" } };
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeAll(() => {
  process.env.API_KEY = "prov-test-key";
});
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROVENANCE_ENFORCE;
  db.profile.findUnique.mockResolvedValue(null);
  db.profile.create.mockResolvedValue({ id: "p1", email: "ana@acme.com" });
  db.emailOutcome.findMany.mockResolvedValue([]);
});
afterEach(() => {
  delete process.env.PROVENANCE_ENFORCE;
});

describe("POST /profiles — mandatory provenance", () => {
  it("enforced: an email without email_source and verdict is a 400 that says exactly what is missing", async () => {
    process.env.PROVENANCE_ENFORCE = "true";
    const res = await request(app).post("/profiles").set(auth).send({ email: "ana@acme.com", first_name: "Ana" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROVENANCE_REQUIRED");
    expect(res.body.missing).toEqual(["email_source", "email_verification.verdict"]);
    expect(res.body.error).toMatch(/missing: email_source, email_verification\.verdict/);
    expect(res.body.error).toMatch(/"verdict": "unknown"/);
    expect(db.profile.create).not.toHaveBeenCalled();
  });

  it("enforced: an invalid value is a 400 too, with the value named", async () => {
    process.env.PROVENANCE_ENFORCE = "true";
    const res = await request(app).post("/profiles").set(auth).send({ email: "ana@acme.com", email_source: "Blitz API!", email_verification: { verdict: "maybe" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/'Blitz API!' is not a provider id/);
    expect(res.body.error).toMatch(/'maybe' is not one of/);
  });

  it("enforced: a payload with no email needs none (linkedin-only upserts keep working)", async () => {
    process.env.PROVENANCE_ENFORCE = "true";
    const res = await request(app).post("/profiles").set(auth).send({ linkedin_url: "https://www.linkedin.com/in/ana", first_name: "Ana" });
    expect(res.status).toBe(200);
    expect(res.body.provenance).toBeUndefined();
  });

  it("with provenance: stores it in a fixed shape, records history and queues it for MailBridge", async () => {
    process.env.PROVENANCE_ENFORCE = "true";
    const res = await request(app).post("/profiles").set(auth).send({ email: "Ana@Acme.com", first_name: "Ana", ...good });
    expect(res.status).toBe(200);
    expect(res.body.provenance).toEqual({ recorded: true, finder: "findymail", verifier: "emaillistverify", verdict: "valid" });
    const stored = db.profile.create.mock.calls[0][0].data.data;
    expect(stored.first_name).toBe("Ana");
    expect(stored.email_source).toBe("findymail");
    expect(stored.email_verification).toMatchObject({ provider: "emaillistverify", verdict: "valid" });
    await flush();
    const rows = db.emailProvenance.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ email: "ana@acme.com", finder: "findymail", verifier: "emaillistverify", verdict: "valid", origin: "ingest" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("not enforced yet (default): accepts, stores nothing new, and warns in the response", async () => {
    const res = await request(app).post("/profiles").set(auth).send({ email: "ana@acme.com", first_name: "Ana" });
    expect(res.status).toBe(200);
    expect(res.body.provenance).toMatchObject({ recorded: false, will_be_rejected: true, missing: ["email_source", "email_verification.verdict"] });
    await flush();
    expect(db.emailProvenance.createMany).not.toHaveBeenCalled();
  });

  it("the flat form works for Clay columns", async () => {
    process.env.PROVENANCE_ENFORCE = "true";
    const res = await request(app).post("/profiles").set(auth).send({ email: "ana@acme.com", email_source: "blitzapi", email_verifier: "debounce", email_verdict: "Safe to Send" });
    expect(res.status).toBe(200);
    expect(res.body.provenance).toMatchObject({ finder: "blitzapi", verifier: "debounce", verdict: "valid" });
  });
});

describe("GET /profiles — a hard bounce is never served as good", () => {
  it("flags a profile whose address MailBridge saw hard-bounce", async () => {
    db.profile.findUnique.mockResolvedValue({ id: "p1", email: "ana@acme.com", data: { email_source: "findymail" }, linkedin_slug: null, phone_e164: null, updated_at: new Date() });
    db.emailOutcome.findMany.mockResolvedValue([
      { email: "ana@acme.com", pattern: null, first_name: null, last_name: null, linkedin_slug: null, bounced_at: new Date(), bounce_type: "hard", replied_at: null, positive_at: null, auto_replied: false, first_visible_send_at: new Date() },
    ]);
    const res = await request(app).get("/profiles").set(auth).query({ email: "ana@acme.com" });
    expect(res.body).toMatchObject({ result: 1, email_hard_bounced: true, email_verdict: "invalid" });
  });
  it("leaves a clean profile alone", async () => {
    db.profile.findUnique.mockResolvedValue({ id: "p1", email: "ana@acme.com", data: {}, linkedin_slug: null, phone_e164: null, updated_at: new Date() });
    const res = await request(app).get("/profiles").set(auth).query({ email: "ana@acme.com" });
    expect(res.body.email_hard_bounced).toBeUndefined();
  });
});

describe("POST /find and /verify — provenance in the response", () => {
  it("/find: finder, verifier, verdict, confidence, checked_at next to the existing fields; fresh facts are recorded and pushed", async () => {
    pipeline.find.mockResolvedValue({ ...EMPTY_RESULT, email: "ana@acme.com", status: "valid", confidence: 0.9, method: "emaillistverify", cost_usd: 0.004 });
    const res = await request(app).post("/find").set(auth).send({ first_name: "Ana", last_name: "Ruiz", domain: "acme.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "ana@acme.com", status: "valid", method: "emaillistverify", confidence: 0.9, finder: "clay_cache", verifier: "emaillistverify", verdict: "valid", hard_bounced: false });
    expect(new Date(res.body.checked_at).getTime()).toBeGreaterThan(Date.now() - 5000);
    await flush();
    expect(db.emailProvenance.createMany.mock.calls[0][0].data[0]).toMatchObject({ finder: "clay_cache", verifier: "emaillistverify", origin: "find" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("/find answered from the cache is not a new fact: reports the original date, records nothing", async () => {
    const at = new Date("2026-09-20T00:00:00Z");
    db.verificationCache.findUnique.mockResolvedValue({ verified_at: at });
    pipeline.find.mockResolvedValue({ ...EMPTY_RESULT, email: "ana@acme.com", status: "valid", method: "emaillistverify", cost_usd: 0 });
    const res = await request(app).post("/find").set(auth).send({ first_name: "Ana", domain: "acme.com" });
    expect(res.body.checked_at).toBe(at.toISOString());
    await flush();
    expect(db.emailProvenance.createMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("/verify of an address MailBridge saw bounce: verdict invalid + hard_bounced", async () => {
    pipeline.verify.mockResolvedValue({ ...EMPTY_RESULT, email: "x@acme.com", status: "invalid", confidence: 0.99, method: "mailbridge_outcome" });
    const res = await request(app).post("/verify").set(auth).send({ email: "x@acme.com" });
    expect(res.body).toMatchObject({ status: "invalid", verdict: "invalid", hard_bounced: true, finder: null, verifier: null });
    await flush();
    expect(enqueue).not.toHaveBeenCalled(); // MailBridge's own fact is never echoed back
  });

  it("/verify with a paid probe: only the verifier is known, verified evidence is pushed", async () => {
    pipeline.verify.mockResolvedValue({ ...EMPTY_RESULT, email: "x@acme.com", status: "catch_all", confidence: 0.5, method: "debounce", cost_usd: 0.002 });
    const res = await request(app).post("/verify").set(auth).send({ email: "x@acme.com" });
    expect(res.body).toMatchObject({ finder: null, verifier: "debounce", verdict: "catch_all" });
    await flush();
    expect(db.emailProvenance.createMany.mock.calls[0][0].data[0]).toMatchObject({ finder: null, verifier: "debounce", origin: "verify" });
  });

  it("a storage failure never costs the answer", async () => {
    db.emailProvenance.createMany.mockRejectedValueOnce(new Error("relation does not exist"));
    pipeline.find.mockResolvedValue({ ...EMPTY_RESULT, email: "ana@acme.com", status: "valid", method: "debounce", cost_usd: 0.002 });
    const res = await request(app).post("/find").set(auth).send({ first_name: "Ana", domain: "acme.com" });
    expect(res.status).toBe(200);
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/mailbridge — signature", () => {
  const secret = "whsec_prov_test";
  const body = JSON.stringify({ event_type: "email_outcomes", data: { rows: [] } });
  const sign = (ts: string, b = body, s = secret) => "sha256=" + createHmac("sha256", s).update(`${ts}.${b}`).digest("hex");
  const post = (headers: Record<string, string>) => request(app).post("/webhooks/mailbridge").set("Content-Type", "application/json").set(headers).send(body);

  beforeEach(() => {
    process.env.MAILBRIDGE_WEBHOOK_SECRET = secret;
  });

  it("good signature (no bearer needed) → 200", async () => {
    const ts = String(Date.now());
    const res = await post({ "x-mailbridge-timestamp": ts, "x-mailbridge-signature": sign(ts) });
    expect(res.status).toBe(200);
  });
  it("bad signature → 401", async () => {
    const ts = String(Date.now());
    const res = await post({ "x-mailbridge-timestamp": ts, "x-mailbridge-signature": sign(ts, body, "other") });
    expect(res.status).toBe(401);
  });
  it("signature over a different body → 401", async () => {
    const ts = String(Date.now());
    const res = await post({ "x-mailbridge-timestamp": ts, "x-mailbridge-signature": sign(ts, body + " ") });
    expect(res.status).toBe(401);
  });
  it("expired timestamp (6 minutes old) → 401; 4 minutes is fine", async () => {
    const old = String(Date.now() - 6 * 60 * 1000);
    expect((await post({ "x-mailbridge-timestamp": old, "x-mailbridge-signature": sign(old) })).status).toBe(401);
    const recent = String(Date.now() - 4 * 60 * 1000);
    expect((await post({ "x-mailbridge-timestamp": recent, "x-mailbridge-signature": sign(recent) })).status).toBe(200);
  });
  it("missing headers → 401; missing secret → 503", async () => {
    expect((await post({})).status).toBe(401);
    delete process.env.MAILBRIDGE_WEBHOOK_SECRET;
    const ts = String(Date.now());
    expect((await post({ "x-mailbridge-timestamp": ts, "x-mailbridge-signature": sign(ts) })).status).toBe(503);
  });
});
