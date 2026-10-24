import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import request from "supertest";

vi.mock("../../src/db/prisma", () => ({ default: {} }));

// What the upstream (sistema-outbound's clay-cache) received.
let seen: { method?: string; url?: string; headers?: http.IncomingHttpHeaders; body?: Buffer }[] = [];
let upstream: http.Server;
let target = "";

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/slow") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("part1;");
        setTimeout(() => res.end("part2"), 50);
        return;
      }
      res.writeHead(req.url === "/teapot" ? 418 : 200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ from: "upstream", url: req.url }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => upstream.close());
afterEach(() => {
  seen = [];
  delete process.env.CUTOVER_MODE;
  delete process.env.PROXY_TARGET;
  vi.resetModules();
});

async function loadApp(env: Record<string, string>) {
  Object.assign(process.env, env);
  vi.resetModules();
  return (await import("../../src/app")).default;
}

describe("CUTOVER_MODE=maintenance", () => {
  it("answers 503 with Retry-After everywhere but /health", async () => {
    const app = await loadApp({ CUTOVER_MODE: "maintenance" });
    const r = await request(app).post("/emails/lookup").send({ linkedin_url: "x" });
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("120");
    const w = await request(app).post("/webhooks/mailbridge").send({});
    expect(w.status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("CUTOVER_MODE=proxy", () => {
  it("relays method, path, query, auth and the raw body byte for byte", async () => {
    const app = await loadApp({ CUTOVER_MODE: "proxy", PROXY_TARGET: target });
    // Spacing and key order a JSON re-serialization would change: the HMAC is over these bytes.
    const raw = '{"event_type":"email_outcomes",  "data":{"rows":[]}, "z":1}';
    const ts = "1700000000000";
    const sig = "sha256=" + createHmac("sha256", "s").update(`${ts}.${raw}`).digest("hex");
    const r = await request(app)
      .post("/webhooks/mailbridge?x=1&y=2")
      .set("content-type", "application/json")
      .set("authorization", "Bearer k")
      .set("x-mailbridge-timestamp", ts)
      .set("x-mailbridge-signature", sig)
      .send(raw);
    expect(r.status).toBe(200);
    expect(r.headers["x-upstream"]).toBe("yes");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/webhooks/mailbridge?x=1&y=2");
    expect(seen[0].body!.toString("utf8")).toBe(raw);
    expect(seen[0].headers!.authorization).toBe("Bearer k");
    expect(seen[0].headers!["x-mailbridge-signature"]).toBe(sig);
    expect(seen[0].headers!.host).toBe(new URL(target).host);
    expect(seen[0].headers!["x-forwarded-for"]).toBeTruthy();
  });

  it("passes upstream status codes and streams the body through", async () => {
    const app = await loadApp({ CUTOVER_MODE: "proxy", PROXY_TARGET: target });
    expect((await request(app).get("/teapot")).status).toBe(418);
    const s = await request(app).get("/slow");
    expect(s.text).toBe("part1;part2");
  });

  it("answers /health itself and 502s when the target is down", async () => {
    const app = await loadApp({ CUTOVER_MODE: "proxy", PROXY_TARGET: "http://127.0.0.1:1" });
    expect((await request(app).get("/health")).status).toBe(200);
    expect(seen).toHaveLength(0);
    expect((await request(app).post("/find").send({ domain: "a.com" })).status).toBe(502);
  });
});

describe("no CUTOVER_MODE", () => {
  it("keeps today's behavior", async () => {
    const app = await loadApp({});
    process.env.API_KEY = "k";
    const r = await request(app).post("/emails/lookup").send({});
    expect(r.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
