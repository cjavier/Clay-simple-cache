import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailbridge } from "../../src/services/mailbridge.client";

type Reply = { status: number; body: unknown };

function mockFetch(replies: Record<string, Reply>) {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method || "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = replies[`${method} ${path}`] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
  return calls;
}

describe("mailbridge workbooks (spec 113)", () => {
  beforeEach(() => { process.env.MAILBRIDGE_API_KEY = "k"; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reuses the client's workbook with the campaign's name", async () => {
    const calls = mockFetch({ "GET /workbooks?clientId=c1": { status: 200, body: { workbooks: [{ id: "w1", name: "CK001" }] } } });
    expect(await mailbridge.ensureWorkbook("c1", "ck001")).toEqual({ id: "w1", name: "CK001" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("creates it when missing", async () => {
    const calls = mockFetch({
      "GET /workbooks?clientId=c1": { status: 200, body: { workbooks: [] } },
      "POST /workbooks": { status: 201, body: { id: "w2", name: "CK002" } },
    });
    expect(await mailbridge.ensureWorkbook("c1", "CK002")).toEqual({ id: "w2", name: "CK002" });
    expect(calls[1].body).toEqual({ clientId: "c1", name: "CK002" });
  });

  it("returns null on a MailBridge without workbooks, and the table goes without the new fields", async () => {
    const calls = mockFetch({ "POST /tables": { status: 201, body: { id: "t1", name: "CK001 — Personas x" } } });
    const wb = await mailbridge.ensureWorkbook("c1", "CK001");
    expect(wb).toBeNull();
    await mailbridge.createTable("c1", "CK001 — Personas x", { kind: "people" }, { entityType: "people", workbookId: wb?.id });
    const post = calls.find((c) => c.path === "/tables")!;
    expect(post.body.workbookId).toBeUndefined();
    expect(post.body.entityType).toBeUndefined();
  });

  it("sends workbookId and entityType when there is a workbook", async () => {
    const calls = mockFetch({ "POST /tables": { status: 201, body: { id: "t1", name: "n" } } });
    await mailbridge.createTable("c1", "n", { kind: "companies" }, { entityType: "companies", workbookId: "w1" });
    expect(calls[0].body).toMatchObject({ workbookId: "w1", entityType: "companies", sourceKind: "webhook" });
  });

  it("does not swallow other errors", async () => {
    mockFetch({ "GET /workbooks?clientId=c1": { status: 500, body: { error: "boom" } } });
    await expect(mailbridge.ensureWorkbook("c1", "CK001")).rejects.toThrow(/HTTP 500/);
  });
});
