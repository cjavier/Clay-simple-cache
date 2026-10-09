import crypto from "crypto";
import prisma from "../db/prisma";
import { mailbridge, MailBridgeError, UpsertRow } from "./mailbridge.client";
import { TableKind, tableNames } from "./table-rows";

/**
 * Lists built for MailBridge clients.
 *
 * `create` makes the MailBridge tables right away (two quick calls) so the
 * caller gets real table ids back. Rows are different: they are written here
 * first as batches and forwarded by an in-process sender, so a 5,000-row list
 * never rides on one HTTP request and a MailBridge deploy in the middle just
 * means a retry. MailBridge upserts each row by its `ref`, which is what makes
 * a retry safe: a batch that landed but whose answer was lost is resent and
 * updates the same rows.
 *
 * In-process for the same reason as `find-job.service.ts`: this API is up 24/7
 * and a separate scheduled service silently stopped firing once before.
 */

/** Rows per call to MailBridge (it accepts up to 1,000). */
export const BATCH_SIZE = Number(process.env.TABLE_BATCH_SIZE || 500);
/** Rows per POST /tables/:id/rows from the caller. */
export const MAX_ROWS_PER_REQUEST = 5000;
const MAX_ATTEMPTS = 8;
/** Seconds before attempt n+1 (n = attempts already made). Ends near 1h total. */
const BACKOFF_S = [5, 15, 45, 120, 300, 600, 1200];
/** A batch `sending` this long died with its process. */
const STALE_AFTER_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 1000;

export interface CreateInput {
  mailbridge_client: string;
  campaign: string;
  niche: string;
  kinds: TableKind[];
  filters?: Record<string, unknown>;
  source?: string | null;
}

let draining = false;
let sweepTimer: NodeJS.Timeout | null = null;

export const tableJobService = {
  async create(input: CreateInput) {
    const client = await mailbridge.resolveClient(input.mailbridge_client);
    const names = tableNames(await mailbridge.tableNames(client.id), input.campaign, input.niche, input.kinds);
    const id = crypto.randomUUID();
    const sourceConfig = {
      origin: "clay-cache POST /tables",
      job_id: id,
      campaign: input.campaign,
      niche: input.niche,
      source: input.source ?? null,
      filters: input.filters ?? {},
    };

    const tables: Record<string, { table_id: string; name: string }> = {};
    for (const kind of input.kinds) {
      const t = await mailbridge.createTable(client.id, names[kind], { ...sourceConfig, kind });
      tables[kind] = { table_id: t.id, name: t.name };
    }

    await prisma.tableJob.create({
      data: {
        id,
        mb_client_id: client.id,
        mb_client_name: client.name,
        campaign: input.campaign,
        niche: input.niche,
        filters: (input.filters ?? {}) as object,
        source: input.source ?? null,
        tables,
      },
    });
    return { id, client, tables };
  },

  async get(id: string) {
    return prisma.tableJob.findUnique({ where: { id } });
  },

  /** Split into batches, store them, and wake the sender. Returns immediately. */
  async enqueue(jobId: string, kind: TableKind, rows: UpsertRow[]) {
    const batches: UpsertRow[][] = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));
    const created = await prisma.$transaction(
      batches.map((b) =>
        prisma.tableJobBatch.create({
          data: { job_id: jobId, kind, rows: b as unknown as object, row_count: b.length },
          select: { id: true },
        })
      )
    );
    this.kick();
    return created.map((b) => b.id);
  },

  /** Per kind: rows received, delivered, pending and failed, plus the job status. */
  async status(jobId: string) {
    const groups = await prisma.tableJobBatch.groupBy({
      by: ["kind", "status"],
      where: { job_id: jobId },
      _sum: { row_count: true, inserted: true, updated: true },
      _count: { _all: true },
    });
    const errors = await prisma.tableJobBatch.findMany({
      where: { job_id: jobId, error: { not: null }, status: { not: "sent" } },
      select: { id: true, kind: true, status: true, attempts: true, error: true, next_attempt_at: true },
      orderBy: { updated_at: "desc" },
      take: 5,
    });
    const kinds: Record<string, any> = {};
    for (const g of groups) {
      const k = (kinds[g.kind] ??= { rows_received: 0, rows_sent: 0, rows_pending: 0, rows_failed: 0, inserted: 0, updated: 0, batches: 0 });
      const n = g._sum.row_count ?? 0;
      k.rows_received += n;
      k.batches += g._count._all;
      if (g.status === "sent") {
        k.rows_sent += n;
        k.inserted += g._sum.inserted ?? 0;
        k.updated += g._sum.updated ?? 0;
      } else if (g.status === "failed") k.rows_failed += n;
      else k.rows_pending += n;
    }
    const all = Object.values(kinds);
    const status = all.length === 0
      ? "ready"
      : all.some((k) => k.rows_failed > 0)
        ? "failed"
        : all.some((k) => k.rows_pending > 0)
          ? "syncing"
          : "synced";
    return { status, kinds, errors };
  },

  /** Put failed batches back in line (after fixing whatever made MailBridge refuse them). */
  async retryFailed(jobId: string): Promise<number> {
    const r = await prisma.tableJobBatch.updateMany({
      where: { job_id: jobId, status: "failed" },
      data: { status: "pending", attempts: 0, next_attempt_at: new Date(), error: null },
    });
    if (r.count) this.kick();
    return r.count;
  },

  /** Start the sender if it isn't running. Safe to call any number of times. */
  kick() {
    if (draining) return;
    draining = true;
    void drain()
      .catch((e) => console.error("[table-jobs] sender crashed:", e))
      .finally(() => {
        draining = false;
      });
  },

  /**
   * On boot: batches left `sending` by a dead process go back to `pending`, and
   * a sweep picks up retries whose time has come. Without the sweep a batch
   * waiting on backoff would only move when someone posted new rows.
   */
  async start() {
    const r = await prisma.tableJobBatch.updateMany({
      where: { status: "sending", updated_at: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      data: { status: "pending" },
    });
    if (r.count) console.log(`[table-jobs] ${r.count} lotes interrumpidos vuelven a la cola`);
    this.kick();
    if (!sweepTimer) {
      sweepTimer = setInterval(async () => {
        try {
          await prisma.tableJobBatch.updateMany({
            where: { status: "sending", updated_at: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
            data: { status: "pending" },
          });
          tableJobService.kick();
        } catch (e) {
          console.error("[table-jobs] sweep failed:", e);
        }
      }, SWEEP_EVERY_MS);
      sweepTimer.unref();
    }
  },
};

/** Oldest due batch first, one at a time: order within a table is preserved. */
async function drain(): Promise<void> {
  for (;;) {
    const batch = await prisma.tableJobBatch.findFirst({
      where: { status: "pending", next_attempt_at: { lte: new Date() } },
      orderBy: { created_at: "asc" },
      include: { job: { select: { tables: true } } },
    });
    if (!batch) return;
    // Claim it; if another drain got there first, move on.
    const claimed = await prisma.tableJobBatch.updateMany({
      where: { id: batch.id, status: "pending" },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    await send(batch.id, batch.kind, (batch.job.tables as any)?.[batch.kind]?.table_id, batch.rows as unknown as UpsertRow[], batch.attempts + 1);
  }
}

export async function send(batchId: string, kind: string, tableId: string | undefined, rows: UpsertRow[], attempt: number): Promise<void> {
  try {
    if (!tableId) throw new MailBridgeError(`job has no MailBridge table for kind '${kind}'`, 400);
    const r = await mailbridge.upsertRows(tableId, rows);
    await prisma.tableJobBatch.update({
      where: { id: batchId },
      data: { status: "sent", inserted: r.inserted, updated: r.updated, error: null },
    });
  } catch (err: any) {
    const retryable = err instanceof MailBridgeError ? err.retryable : true;
    const giveUp = !retryable || attempt >= MAX_ATTEMPTS;
    const wait = BACKOFF_S[Math.min(attempt - 1, BACKOFF_S.length - 1)] * 1000;
    await prisma.tableJobBatch.update({
      where: { id: batchId },
      data: {
        status: giveUp ? "failed" : "pending",
        error: String(err?.message || err).slice(0, 1000),
        next_attempt_at: new Date(Date.now() + (giveUp ? 0 : wait)),
      },
    });
    if (!giveUp) setTimeout(() => tableJobService.kick(), wait + 50).unref();
  }
}
