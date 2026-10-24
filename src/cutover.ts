import { Request, Response, NextFunction } from "express";
import http from "node:http";
import https from "node:https";

/**
 * Cutover to sistema-outbound's `clay-cache` service (spec 125 over there).
 * api.improvitz.com keeps pointing at this service until the CNAME moves, so
 * this service steps aside through CUTOVER_MODE:
 *
 *  - unset        → today's behavior.
 *  - maintenance  → no background loops, no database; every request but
 *                   /health gets 503 + Retry-After while the data is copied.
 *  - proxy        → no background loops, no database; every request is relayed
 *                   as-is to PROXY_TARGET (method, path, query, headers, and the
 *                   raw body byte for byte so MailBridge's HMAC still verifies),
 *                   the response streamed back.
 */
export type CutoverMode = "maintenance" | "proxy" | null;

export function cutoverMode(env: NodeJS.ProcessEnv = process.env): CutoverMode {
  const m = (env.CUTOVER_MODE || "").trim().toLowerCase();
  if (m === "maintenance" || m === "proxy") return m;
  return null;
}

export const RETRY_AFTER_S = 120;

export function maintenanceHandler(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") return next();
  res.set("Retry-After", String(RETRY_AFTER_S));
  res.status(503).json({ error: "Service under maintenance, retry shortly", retry_after_s: RETRY_AFTER_S });
}

// Hop-by-hop headers (RFC 9110 §7.6.1) are this connection's, not the request's.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

/** No timeout of our own: POST /find has taken 92 s. The caller's timeout governs. */
export function proxyHandler(target: string) {
  const base = new URL(target);
  const client = base.protocol === "https:" ? https : http;
  const agent = new client.Agent({ keepAlive: true });

  return (req: Request, res: Response): void => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_BY_HOP.has(k) && k !== "host") headers[k] = v;
    }
    headers.host = base.host;
    // Who really called, appended like any proxy would.
    const prior = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = [prior, req.ip].filter(Boolean).join(", ");
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = req.protocol;

    const upstream = client.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        method: req.method,
        path: req.originalUrl,
        headers,
        agent,
      },
      (up) => {
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k)) res.setHeader(k, v);
        }
        res.status(up.statusCode || 502);
        up.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      console.error(`[cutover] proxy ${req.method} ${req.path} failed:`, err.message);
      if (!res.headersSent) res.status(502).json({ error: "Bad gateway" });
      else res.destroy(err);
    });
    // The client gave up (499 territory): stop the upstream work too.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
}
