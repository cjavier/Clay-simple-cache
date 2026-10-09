import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/prisma", () => ({ default: { emailProvenance: { updateMany: vi.fn(), findMany: vi.fn() } } }));

import { BATCH_ROWS, EvidencePusher, PushError, sendEvidenceBatch } from "../../src/services/evidence-push.service";
import { ProvenanceEntry } from "../../src/email-finder/provenance";

function entry(n: number, over: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email: `p${n}@acme.com`, finder: "clay_cache", verifier: "debounce",
    verdict: "valid", raw_status: "valid", confidence: 0.9, method: "debounce", origin: "find", checked_at: "2026-10-09T00:00:00.000Z", ...over,
  };
}

function harness(send: (rows: any[]) => Promise<any>, over: Record<string, any> = {}) {
  const logs: string[] = [];
  const done: { ids: string[]; rejected: { id: string; reason: string }[] }[] = [];
  const sleeps: number[] = [];
  const pusher = new EvidencePusher({
    send,
    sleep: async (ms) => void sleeps.push(ms),
    onDone: async (d) => void done.push(d),
    configured: () => true,
    log: (m) => logs.push(m),
    flushAfterMs: 5,
    ...over,
  });
  return { pusher, logs, done, sleeps };
}

describe("sendEvidenceBatch", () => {
  const env = { MAILBRIDGE_API_KEY: "k-123", MAILBRIDGE_API_URL: "https://mb.example/" } as any;
  it("POSTs {rows} to /email-evidence with the x-api-key header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ inserted: 2, skipped: 0, rejected: [] }), { status: 200 }));
    const rows = [{ email: "a@b.com", kind: "found", provider: "clay_cache", sourceRef: "ccache:find:1", occurredAt: "2026-10-09T00:00:00.000Z" }] as any;
    const r = await sendEvidenceBatch(rows, { fetchImpl: fetchImpl as any, env });
    expect(r).toEqual({ inserted: 2, skipped: 0, rejected: [] });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe("https://mb.example/email-evidence");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("k-123");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ rows });
  });
  it("marks 429/5xx/network as retryable and other 4xx as not", async () => {
    const mk = (status: number) => async () => new Response("nope", { status });
    await expect(sendEvidenceBatch([], { fetchImpl: mk(503) as any, env })).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(sendEvidenceBatch([], { fetchImpl: mk(429) as any, env })).rejects.toMatchObject({ retryable: true });
    await expect(sendEvidenceBatch([], { fetchImpl: mk(401) as any, env })).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(sendEvidenceBatch([], { fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as any, env })).rejects.toMatchObject({ status: 0, retryable: true });
  });
  it("refuses to run without a key", async () => {
    await expect(sendEvidenceBatch([], { env: {} as any })).rejects.toBeInstanceOf(PushError);
  });
});

describe("EvidencePusher", () => {
  it("batches up to 500 rows per call, in order, and marks every fact delivered", async () => {
    const sent: any[][] = [];
    const { pusher, done } = harness(async (rows) => (sent.push(rows), { inserted: rows.length, skipped: 0, rejected: [] }));
    // each entry has 2 rows (found + verified): 600 entries = 1,200 rows
    pusher.enqueue(Array.from({ length: 600 }, (_, i) => entry(i)));
    await pusher.flush();
    expect(sent.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(sent.every((b) => b.length <= BATCH_ROWS)).toBe(true);
    expect(sent[0][0].sourceRef).toBe(`ccache:find:${entry(0).id}`);
    expect(done.reduce((n, d) => n + d.ids.length, 0)).toBe(600);
    expect(pusher.pending).toBe(0);
  });

  it("does not block the caller: enqueue returns before anything is sent", async () => {
    const send = vi.fn(async (rows: any[]) => ({ inserted: rows.length, skipped: 0, rejected: [] }));
    const { pusher } = harness(send, { flushAfterMs: 50 });
    pusher.enqueue([entry(1)]);
    expect(send).not.toHaveBeenCalled();
    expect(pusher.pending).toBe(1);
    await pusher.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff on 5xx and succeeds", async () => {
    let calls = 0;
    const { pusher, done, sleeps } = harness(async (rows) => {
      if (++calls < 3) throw new PushError("HTTP 503", 503);
      return { inserted: rows.length, skipped: 0, rejected: [] };
    }, { retryDelays: [10, 20, 40] });
    pusher.enqueue([entry(1)]);
    await pusher.flush();
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(done[0].ids).toEqual([entry(1).id]);
  });

  it("gives up after the last delay but keeps the fact for the sweeper (nothing is marked delivered)", async () => {
    const { pusher, done, logs, sleeps } = harness(async () => { throw new PushError("HTTP 500", 500); }, { retryDelays: [1, 2] });
    pusher.enqueue([entry(1)]);
    await pusher.flush();
    expect(sleeps).toEqual([1, 2]);
    expect(done).toEqual([]);
    expect(logs.join("\n")).toMatch(/not delivered \(kept for the sweeper\)/);
    // the fact is no longer "in flight", so the sweeper can queue it again
    const again = vi.fn(async (rows: any[]) => ({ inserted: rows.length, skipped: 0, rejected: [] }));
    const h2 = harness(again);
    h2.pusher.enqueue([entry(1)]);
    await h2.pusher.flush();
    expect(again).toHaveBeenCalled();
  });

  it("does not retry a 4xx (config or data error)", async () => {
    const send = vi.fn(async () => { throw new PushError("HTTP 401", 401); });
    const { pusher, sleeps } = harness(send);
    pusher.enqueue([entry(1)]);
    await pusher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("maps rows MailBridge rejected back to their fact and records the reason", async () => {
    const { pusher, done } = harness(async (rows) => ({ inserted: rows.length - 1, skipped: 0, rejected: [{ index: 2, reason: "provider inválido" }] }));
    pusher.enqueue([entry(1), entry(2)]); // rows: 1f,1v,2f,2v -> index 2 is fact 2
    await pusher.flush();
    expect(done[0].ids).toEqual([entry(1).id]);
    expect(done[0].rejected).toEqual([{ id: entry(2).id, reason: "provider inválido" }]);
  });

  it("skips a fact already queued (the sweeper must not double-send what is in flight)", async () => {
    const sent: any[][] = [];
    const { pusher } = harness(async (rows) => (sent.push(rows), { inserted: rows.length, skipped: 0, rejected: [] }));
    pusher.enqueue([entry(1)]);
    pusher.enqueue([entry(1)]);
    await pusher.flush();
    expect(sent.flat()).toHaveLength(2);
  });

  it("without MAILBRIDGE env: logs once, sends nothing, never throws", async () => {
    const send = vi.fn();
    const { pusher, logs } = harness(send as any, { configured: () => false });
    pusher.enqueue([entry(1)]);
    pusher.enqueue([entry(2)]);
    await pusher.flush();
    expect(send).not.toHaveBeenCalled();
    expect(logs.filter((l) => /not set/.test(l))).toHaveLength(1);
  });
});
