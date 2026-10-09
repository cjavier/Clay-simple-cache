import { Request, Response } from "express";
import { mailbridge, mailbridgeConfigured, MailBridgeError } from "../services/mailbridge.client";
import { MAX_ROWS_PER_REQUEST, tableJobService } from "../services/table-job.service";
import { RowError, TABLE_KINDS, TableKind, toUpsertRow } from "../services/table-rows";
import { blitzConfigured } from "../services/blitz.client";
import { BuildConfig, buildSummary, MAX_COMPANIES, tableBuildService } from "../services/table-build.service";
import { jobPendingSummary } from "../services/email-cascade/pending";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `build` of POST /tables: Blitz filters already translated by the skill. Returns an error string or the config. */
export function parseBuild(b: unknown): BuildConfig | string {
  if (!isObj(b)) return "build must be an object";
  if (!isObj(b.company) || Object.keys(b.company).length === 0) return "build.company (Blitz company filter) is required";
  if (b.people !== undefined && !isObj(b.people)) return "build.people must be an object";
  const max = b.max_companies === undefined ? MAX_COMPANIES : b.max_companies;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_COMPANIES) return `build.max_companies must be 1-${MAX_COMPANIES}`;
  if (b.find_emails !== undefined && typeof b.find_emails !== "boolean") return "build.find_emails must be boolean";
  let budget: number | undefined;
  if (b.email_budget_usd !== undefined) {
    const n = Number(b.email_budget_usd);
    if (b.email_budget_usd === null || !Number.isFinite(n) || n < 0 || n > 1000) return "build.email_budget_usd must be a number 0-1000 (USD)";
    budget = n;
  }
  if (b.email_policy !== undefined && !["strict", "moderate", "permissive"].includes(b.email_policy as string)) return "build.email_policy must be strict | moderate | permissive";
  const monthly = Number(b.monthly) || 0;
  const months = Number(b.months) || 1;
  return {
    ...(budget !== undefined ? { email_budget_usd: budget } : {}),
    ...(b.email_policy !== undefined ? { email_policy: b.email_policy as BuildConfig["email_policy"] } : {}),
    company: b.company,
    people: (b.people as Record<string, unknown>) || {},
    max_companies: max as number,
    find_emails: b.find_emails !== false,
    needed: monthly ? monthly * months : null,
  };
}

/** The build's email block plus the pending people as they are now (retries change them). */
async function withLivePending(jobId: string, summary: ReturnType<typeof buildSummary>) {
  if (!summary?.emails) return summary;
  try {
    return { ...summary, emails: { ...summary.emails, pending_now: await jobPendingSummary(jobId), retry: `/tables/${jobId}/emails/retry` } };
  } catch {
    return summary;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v: unknown, max = 120): string | null {
  return typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null;
}

function notConfigured(res: Response): boolean {
  if (mailbridgeConfigured()) return false;
  res.status(503).json({ error: "MAILBRIDGE_API_KEY is not configured on this server" });
  return true;
}

function mbFailure(res: Response, err: unknown, what: string) {
  if (err instanceof MailBridgeError) {
    // A client that doesn't exist is the caller's mistake; anything else is MailBridge's.
    const status = err.status === 404 || err.status === 400 ? 400 : 502;
    res.status(status).json({ error: `${what}: ${err.message}` });
    return;
  }
  console.error(`${what}:`, err);
  res.status(500).json({ error: "Internal server error" });
}

async function loadJob(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "Table job not found" });
    return null;
  }
  const job = await tableJobService.get(id);
  if (!job) res.status(404).json({ error: "Table job not found" });
  return job;
}

export const tablesController = {
  async create(req: Request, res: Response) {
    if (notConfigured(res)) return;
    const b = req.body || {};
    const client = text(b.mailbridge_client, 200);
    const campaign = text(b.campaign, 40);
    const niche = text(b.niche, 120);
    if (!client || !campaign || !niche) {
      res.status(400).json({ error: "mailbridge_client (UUID or exact name), campaign and niche are required" });
      return;
    }
    const kinds: TableKind[] = b.kinds === undefined ? [...TABLE_KINDS] : b.kinds;
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !TABLE_KINDS.includes(k)) || new Set(kinds).size !== kinds.length) {
      res.status(400).json({ error: `kinds must be a non-empty subset of ${JSON.stringify(TABLE_KINDS)}` });
      return;
    }
    if (b.filters !== undefined && (typeof b.filters !== "object" || b.filters === null || Array.isArray(b.filters))) {
      res.status(400).json({ error: "filters must be an object" });
      return;
    }
    let build: BuildConfig | null = null;
    if (b.build !== undefined) {
      const parsed = parseBuild(b.build);
      if (typeof parsed === "string") {
        res.status(400).json({ error: parsed });
        return;
      }
      if (!blitzConfigured()) {
        res.status(503).json({ error: "BLITZAPI_KEY is not configured on this server" });
        return;
      }
      build = parsed;
    }
    try {
      const job = await tableJobService.create({
        mailbridge_client: client,
        campaign,
        niche,
        kinds,
        filters: b.filters,
        source: text(b.source, 40) ?? (build ? "blitzapi" : null),
        build,
        email_waterfall: b.email_waterfall !== false,
      });
      if (build) tableBuildService.start(job.id);
      res.status(201).json({
        id: job.id,
        mailbridge_client: job.client,
        tables: job.tables,
        status: build ? "building" : "ready",
        rows: `/tables/${job.id}/rows`,
      });
    } catch (err) {
      mbFailure(res, err, "Could not create the MailBridge tables");
    }
  },

  async addRows(req: Request, res: Response) {
    try {
      const job = await loadJob(req, res);
      if (!job) return;
      const { kind, rows } = req.body || {};
      const tables = job.tables as Record<string, unknown>;
      if (!TABLE_KINDS.includes(kind) || !tables[kind]) {
        res.status(400).json({ error: `kind must be one of this job's tables: ${JSON.stringify(Object.keys(tables))}` });
        return;
      }
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS_PER_REQUEST) {
        res.status(400).json({ error: `rows must be an array of 1 to ${MAX_ROWS_PER_REQUEST} objects` });
        return;
      }
      let mapped;
      try {
        // All or nothing: a list half-accepted is a list nobody can reason about.
        mapped = rows.map((r: unknown, i: number) => toUpsertRow(kind, r, i));
      } catch (err) {
        if (err instanceof RowError) {
          res.status(400).json({ error: err.message, accepted: 0 });
          return;
        }
        throw err;
      }
      const batchIds = await tableJobService.enqueue(job.id, kind, mapped);
      const withEmail = mapped.filter((r) => r.sources?.Email).length;
      // Rows with an email but no verdict are accepted only while PROVENANCE_ENFORCE is off.
      const withoutVerdict = mapped.filter((r) => r.sources?.Email && !r.data["Email Verdict"]).length;
      res.status(202).json({
        accepted: mapped.length,
        with_email: withEmail,
        ...(withoutVerdict ? { without_verdict: withoutVerdict, warning: "rows with an email need email_verification.verdict (or email_status \"valido\"); this will be rejected once PROVENANCE_ENFORCE is on" } : {}),
        batches: batchIds.length,
        status: `/tables/${job.id}`,
      });
    } catch (err) {
      console.error("Table rows error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async get(req: Request, res: Response) {
    try {
      const job = await loadJob(req, res);
      if (!job) return;
      const sync = await tableJobService.status(job.id);
      const tables = job.tables as Record<string, { table_id: string; name: string }>;
      // ?live=1 asks MailBridge how many rows each table really holds — the
      // check that what we say we sent actually landed.
      if (req.query.live === "1" || req.query.live === "true") {
        for (const [kind, t] of Object.entries(tables)) {
          try {
            (sync.kinds[kind] ??= {}).mailbridge_row_count = await mailbridge.tableRowCount(t.table_id);
          } catch (err: any) {
            (sync.kinds[kind] ??= {}).mailbridge_row_count_error = err?.message || String(err);
          }
        }
      }
      res.json({
        id: job.id,
        mailbridge_client: { id: job.mb_client_id, name: job.mb_client_name },
        campaign: job.campaign,
        niche: job.niche,
        source: job.source,
        filters: job.filters,
        tables,
        ...sync,
        // A build still producing rows outranks "synced": more are coming.
        ...(["queued", "running"].includes(job.build_status || "") ? { status: "building" } : {}),
        ...(job.build_status === "failed" ? { status: "failed" } : {}),
        build: await withLivePending(job.id, buildSummary(job.build_status, job.build_state as any, job.build as any, job.build_error)),
        created_at: job.created_at,
      });
    } catch (err) {
      console.error("Table job error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async retry(req: Request, res: Response) {
    try {
      const job = await loadJob(req, res);
      if (!job) return;
      res.json({ requeued_batches: await tableJobService.retryFailed(job.id) });
    } catch (err) {
      console.error("Table retry error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
