import { Request, Response } from "express";
import { mailbridge, mailbridgeConfigured, MailBridgeError } from "../services/mailbridge.client";
import { MAX_ROWS_PER_REQUEST, tableJobService } from "../services/table-job.service";
import { RowError, TABLE_KINDS, TableKind, toUpsertRow } from "../services/table-rows";

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
    try {
      const job = await tableJobService.create({
        mailbridge_client: client,
        campaign,
        niche,
        kinds,
        filters: b.filters,
        source: text(b.source, 40),
      });
      res.status(201).json({
        id: job.id,
        mailbridge_client: job.client,
        tables: job.tables,
        status: "ready",
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
      res.status(202).json({ accepted: mapped.length, with_email: withEmail, batches: batchIds.length, status: `/tables/${job.id}` });
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
