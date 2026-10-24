#!/usr/bin/env node
// Contract E2E for the Clay Cache → sistema-outbound migration.
//
// Two modes:
//   compare  — read-only requests from real fixtures sent to OLD and NEW; the
//              JSON bodies must match (after dropping volatile keys). Run it
//              after a data copy, before the cutover, and again after.
//   smoke    — exercises every endpoint MailBridge, Clay and the MCP users call
//              against ONE target, including writes with a synthetic identity
//              (e2e-<run>@improvitz-e2e-test.com) and read-after-write checks.
//
// Env:
//   OLD_URL, OLD_KEY          current Clay Cache (default https://api.improvitz.com)
//   NEW_URL, NEW_KEY          sistema-outbound
//   TARGET_URL, TARGET_KEY    smoke target (defaults to NEW_*)
//   MAILBRIDGE_WEBHOOK_SECRET optional: signs a /webhooks/mailbridge call in smoke
//   FIXTURES                  JSONL (default scripts/migration/.local/fixtures.jsonl)
//   WITH_FIND=1               also compare POST /find (can spend provider credit)
//
//   node scripts/migration/contract-e2e.mjs compare
//   node scripts/migration/contract-e2e.mjs smoke

import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const mode = process.argv[2] || "compare";
const OLD = { url: process.env.OLD_URL || "https://api.improvitz.com", key: process.env.OLD_KEY };
const NEW = { url: process.env.NEW_URL, key: process.env.NEW_KEY };
const TARGET = { url: process.env.TARGET_URL || NEW.url, key: process.env.TARGET_KEY || NEW.key };
const FIXTURES = process.env.FIXTURES || new URL("./.local/fixtures.jsonl", import.meta.url).pathname;

// Keys that legitimately differ between two calls of the same request.
const VOLATILE = new Set(["duration_ms", "cost_usd", "timed_out", "checked_at", "requestId"]);

let failures = 0;
let passes = 0;
const fail = (name, detail) => { failures++; console.log(`✗ ${name}\n    ${detail}`); };
const pass = (name) => { passes++; if (process.env.VERBOSE) console.log(`✓ ${name}`); };

async function call(target, method, path, body, headers = {}) {
  const res = await fetch(target.url.replace(/\/$/, "") + path, {
    method,
    redirect: "manual",
    headers: {
      ...(target.key ? { authorization: `Bearer ${target.key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)]));
  }
  return v;
}

function diff(a, b, path = "") {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diff(a[k], b[k], `${path}.${k}`));
  }
  return [`${path || "(root)"}: old=${JSON.stringify(a)?.slice(0, 120)} new=${JSON.stringify(b)?.slice(0, 120)}`];
}

async function same(name, method, path, body) {
  const [o, n] = await Promise.all([call(OLD, method, path, body), call(NEW, method, path, body)]);
  if (o.status !== n.status) return fail(name, `status old=${o.status} new=${n.status} new_body=${n.text.slice(0, 200)}`);
  const d = diff(strip(o.json ?? o.text), strip(n.json ?? n.text));
  if (d.length) return fail(name, d.slice(0, 5).join("\n    "));
  pass(name);
}

async function compare() {
  if (!NEW.url || !OLD.key || !NEW.key) throw new Error("compare needs OLD_KEY, NEW_URL and NEW_KEY");
  const fx = readFileSync(FIXTURES, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`compare: ${fx.length} fixtures  ${OLD.url}  vs  ${NEW.url}`);
  for (const [i, f] of fx.entries()) {
    const q = (o) => "?" + new URLSearchParams(o).toString();
    await same(`#${i} GET /profiles?email`, "GET", "/profiles" + q({ email: f.email }));
    await same(`#${i} GET /profiles?linkedin_url`, "GET", "/profiles" + q({ linkedin_url: f.linkedin_url }));
    await same(`#${i} POST /emails/lookup linkedin`, "POST", "/emails/lookup", { linkedin_url: f.linkedin_url });
    await same(`#${i} POST /emails/lookup name+domain`, "POST", "/emails/lookup", {
      first_name: f.first_name, last_name: f.last_name, company_domain: f.domain,
    });
    await same(`#${i} POST /emails/facts`, "POST", "/emails/facts", {
      email: f.email, first_name: f.first_name, last_name: f.last_name, linkedin_url: f.linkedin_url,
    });
    if (process.env.WITH_FIND && i < 10) {
      await same(`#${i} POST /find`, "POST", "/find", {
        first_name: f.first_name, last_name: f.last_name, domain: f.domain, linkedin_url: f.linkedin_url,
      });
    }
  }
  // Validation errors must be the same too: MailBridge branches on them.
  await same("400 /emails/lookup empty", "POST", "/emails/lookup", {});
  await same("400 /emails/facts bad email", "POST", "/emails/facts", { email: "nope" });
  await same("400 /emails/results no identity", "POST", "/emails/results", { email: "a@b.co" });
  await same("400 /find no domain", "POST", "/find", { first_name: "a" });
  await same("400 /profiles no key", "POST", "/profiles", { first_name: "a" });
  await same("GET /profiles not found", "GET", "/profiles?email=nobody-e2e%40improvitz-e2e-test.com");
}

async function expect(name, p, check) {
  try {
    const r = await p;
    const problem = check(r);
    if (problem) fail(name, `${problem} — status=${r.status} body=${r.text.slice(0, 300)}`);
    else pass(name);
    return r;
  } catch (e) {
    fail(name, String(e));
  }
}

async function smoke() {
  if (!TARGET.url || !TARGET.key) throw new Error("smoke needs TARGET_URL/TARGET_KEY (or NEW_URL/NEW_KEY)");
  const run = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const domain = "improvitz-e2e-test.com";
  const email = `e2e.${run}@${domain}`;
  const li = `https://www.linkedin.com/in/e2e-migration-${run}`;
  const T = TARGET;
  console.log(`smoke: ${T.url}  run=${run}`);

  await expect("GET /health", call(T, "GET", "/health"), (r) => r.status !== 200 && "not 200");
  await expect("GET /docs/api", call(T, "GET", "/docs/api"), (r) => r.status !== 200 && "not 200");
  await expect("GET /llms.txt", call(T, "GET", "/llms.txt"), (r) => r.status !== 200 && "not 200");
  await expect("401 without key", call({ url: T.url }, "POST", "/emails/lookup", { linkedin_url: li }), (r) => r.status !== 401 && "not 401");
  await expect("401 wrong key", call({ url: T.url, key: "wrong" }, "GET", "/profiles?email=" + email), (r) => r.status !== 401 && "not 401");

  // Clay: POST /profiles then read it back by every key.
  await expect(
    "POST /profiles (new)",
    call(T, "POST", "/profiles", {
      email, linkedin_url: li, first_name: "E2e", last_name: `Migration${run}`, company_domain: domain,
      email_source: "clay_cache", email_verification: { provider: null, verdict: "unknown" }, e2e_run: run,
    }),
    (r) => (r.status !== 200 ? "not 200" : r.json?.resolved_by !== "new" ? `resolved_by=${r.json?.resolved_by}` : null)
  );
  await expect(
    "POST /profiles (merge by linkedin)",
    call(T, "POST", "/profiles", { linkedin_url: li, title: "QA" }),
    (r) => (r.status !== 200 ? "not 200" : r.json?.resolved_by === "new" ? "created a duplicate" : null)
  );
  await expect("GET /profiles?email", call(T, "GET", `/profiles?email=${encodeURIComponent(email)}`), (r) =>
    r.json?.result !== 1 ? "not found" : r.json.title !== "QA" || r.json.e2e_run !== run ? "data not merged" : null
  );
  await expect("GET /profiles?linkedin_url", call(T, "GET", `/profiles?linkedin_url=${encodeURIComponent(li)}`), (r) =>
    r.json?.email !== email ? `email=${r.json?.email}` : null
  );

  // MailBridge cascade: results → lookup → facts.
  const email2 = `e2e2.${run}@${domain}`;
  const li2 = `https://www.linkedin.com/in/e2e-results-${run}`;
  await expect(
    "POST /emails/results",
    call(T, "POST", "/emails/results", {
      linkedin_url: li2, first_name: "E2e", last_name: `Results${run}`, company_domain: domain,
      email: email2, email_source: "findymail", origin: "e2e_migration",
      verification: { provider: "debounce", verdict: "valid", confidence: 0.9 },
      facts: { mx_provider: "google", mail_gateway: null, domain_catch_all: false, bad_domain: false },
    }),
    (r) => (r.status !== 200 ? "not 200" : r.json?.saved !== true ? "saved!=true" : null)
  );
  await expect("POST /emails/lookup after results", call(T, "POST", "/emails/lookup", { linkedin_url: li2 }), (r) =>
    r.json?.found !== true || r.json?.email !== email2 ? `found=${r.json?.found} email=${r.json?.email}` : null
  );
  await expect(
    "POST /emails/lookup by name+domain",
    call(T, "POST", "/emails/lookup", { first_name: "E2e", last_name: `Results${run}`, company_domain: domain }),
    (r) => (r.status !== 200 ? "not 200" : null)
  );
  await expect("POST /emails/facts", call(T, "POST", "/emails/facts", { email: email2 }), (r) =>
    r.status !== 200 ? "not 200" : !("mx_provider" in (r.json || {})) ? "missing mx_provider" : null
  );
  await expect("POST /emails/lookup miss", call(T, "POST", "/emails/lookup", { linkedin_url: `${li2}-nobody` }), (r) =>
    r.json?.found !== false ? "expected found=false" : null
  );

  // Webhook: signed outcome for the synthetic address, then the outcome must show in GET /profiles.
  const secret = process.env.MAILBRIDGE_WEBHOOK_SECRET;
  if (secret) {
    const body = JSON.stringify({
      event_type: "email_outcomes",
      data: { rows: [{ contact_id: `e2e-${run}`, email, first_name: "E2e", last_name: `Migration${run}`, linkedin_url: li, bounced_at: new Date().toISOString(), bounce_type: "hard" }] },
    });
    const ts = String(Date.now());
    const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    await expect(
      "POST /webhooks/mailbridge signed",
      call({ url: T.url }, "POST", "/webhooks/mailbridge", body, { "x-mailbridge-timestamp": ts, "x-mailbridge-signature": sig }),
      (r) => (r.status !== 200 || r.json?.ok !== true ? "not ok" : null)
    );
    await expect("GET /profiles shows hard bounce", call(T, "GET", `/profiles?email=${encodeURIComponent(email)}`), (r) =>
      r.json?.email_hard_bounced !== true ? "email_hard_bounced not set" : null
    );
  } else {
    console.log("  (skip signed webhook: MAILBRIDGE_WEBHOOK_SECRET not set)");
  }
  await expect(
    "POST /webhooks/mailbridge bad signature",
    call({ url: T.url }, "POST", "/webhooks/mailbridge", { event_type: "email_outcomes" }, { "x-mailbridge-timestamp": String(Date.now()), "x-mailbridge-signature": "sha256=00" }),
    (r) => (r.status !== 401 ? "not 401" : null)
  );

  // MCP (stateless streamable HTTP).
  const mcpHeaders = { accept: "application/json, text/event-stream" };
  const rpc = (id, method, params) => call(T, "POST", "/mcp", { jsonrpc: "2.0", id, method, params }, mcpHeaders);
  const parse = (r) => {
    if (r.json) return r.json;
    const line = r.text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5)) : null;
  };
  await expect(
    "MCP initialize",
    rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }),
    (r) => (r.status !== 200 || !parse(r)?.result?.serverInfo ? "no serverInfo" : null)
  );
  const tools = await expect("MCP tools/list", rpc(2, "tools/list", {}), (r) => (!parse(r)?.result?.tools?.length ? "no tools" : null));
  if (tools) console.log(`  MCP tools: ${parse(tools)?.result?.tools?.map((t) => t.name).join(", ")}`);
  await expect("MCP get_profile", rpc(3, "tools/call", { name: "get_profile", arguments: { email } }), (r) =>
    !JSON.stringify(parse(r) || {}).includes(email) ? "profile not returned" : null
  );
  await expect("GET /mcp → 405", call(T, "GET", "/mcp", undefined, mcpHeaders), (r) => (r.status !== 405 ? "not 405" : null));

  // Lists: GET /tables/:id of an unknown id must 404, not 500.
  await expect("GET /tables/:id unknown", call(T, "GET", "/tables/00000000-0000-0000-0000-000000000000"), (r) =>
    r.status !== 404 ? "not 404" : null
  );

  console.log(`  synthetic rows: emails ${email}, ${email2} (domain ${domain}) — delete with the cleanup SQL in README-migration.md`);
}

const t0 = Date.now();
await (mode === "smoke" ? smoke() : compare());
console.log(`\n${passes} ok, ${failures} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(failures ? 1 : 0);
