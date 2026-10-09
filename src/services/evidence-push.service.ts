import prisma from "../db/prisma";
import { EvidenceRow, ProvenanceEntry, ProvenanceMeta, toEvidenceRows } from "../email-finder/provenance";
import { postSlackMessage } from "./slack.service";

/**
 * Pushes per-email evidence (who found it, who verified it, the verdict) to
 * MailBridge's `POST /email-evidence`, so MailBridge can grade providers
 * against the bounces it sees.
 *
 * Shape of the guarantee:
 *  - Nothing here blocks an API response. `enqueue` only appends to memory.
 *  - The facts are already in `email_provenance` (the durable outbox) before
 *    they are queued; `pushed_at` says whether MailBridge has them. A restart
 *    or a MailBridge outage loses nothing: the sweeper re-queues what is still
 *    unpushed, and MailBridge dedupes on `sourceRef`, so a repeat is harmless.
 *  - Batches of up to 500 rows (MailBridge takes 1,000), retried with backoff
 *    on network errors, 429 and 5xx. Other 4xx are config or data errors and
 *    are not retried.
 *  - Auth is MailBridge's `x-api-key` (the same agency-wide key the list
 *    builder uses). `Authorization: Bearer` is for MailBridge's user JWTs and
 *    would answer 401 here.
 *  - Env vars missing: logged once, then skipped. Never a crash.
 */

const DEFAULT_URL = "https://api-production-0f81.up.railway.app";
export const BATCH_ROWS = 500;
/** Seconds-scale waits between attempts of the same batch. */
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];
const FLUSH_AFTER_MS = 2_000;
/** Items held in memory; beyond this we drop (the sweeper recovers them from the table). */
const MAX_QUEUE_ITEMS = 20_000;

export interface QueueItem {
  /** `email_provenance.id`, to mark it pushed. */
  id: string;
  rows: EvidenceRow[];
}

export interface PushResponse {
  inserted: number;
  skipped: number;
  rejected: { index: number; reason: string }[];
}

export class PushError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PushError";
  }
  /** The key was refused: nothing will get through until someone fixes it. */
  get authFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
  /** Network failure, rate limit, or MailBridge having a bad moment. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function evidencePushConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MAILBRIDGE_API_KEY);
}

/** One POST of up to 1,000 rows. Throws PushError. */
export async function sendEvidenceBatch(
  rows: EvidenceRow[],
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<PushResponse> {
  const env = opts.env ?? process.env;
  const key = env.MAILBRIDGE_API_KEY;
  const base = (env.MAILBRIDGE_API_URL || DEFAULT_URL).replace(/\/+$/, "");
  if (!key) throw new PushError("MAILBRIDGE_API_KEY is not set", 0);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base}/email-evidence`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err: any) {
    throw new PushError(`MailBridge /email-evidence did not answer: ${err?.message || err}`, 0);
  }
  const text = await res.text();
  if (!res.ok) throw new PushError(`MailBridge /email-evidence → HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  const body = text ? JSON.parse(text) : {};
  return {
    inserted: body.inserted ?? 0,
    skipped: body.skipped ?? 0,
    rejected: Array.isArray(body.rejected) ? body.rejected : [],
  };
}

export interface PusherDeps {
  send?: (rows: EvidenceRow[]) => Promise<PushResponse>;
  sleep?: (ms: number) => Promise<void>;
  /** Mark rows as delivered (or rejected with a reason). */
  onDone?: (done: { ids: string[]; rejected: { id: string; reason: string }[] }) => Promise<void>;
  configured?: () => boolean;
  log?: (msg: string) => void;
  retryDelays?: number[];
  flushAfterMs?: number;
  /** Shout somewhere a human looks (Slack). Called once per auth pause. */
  alert?: (msg: string) => Promise<void>;
  now?: () => number;
}

/** After a 401/403 the pusher stops sending for this long, then tries once more. */
export const AUTH_PAUSE_MS = 30 * 60 * 1000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class EvidencePusher {
  private queue: QueueItem[] = [];
  private inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private warnedUnconfigured = false;
  private readonly deps: Required<PusherDeps>;

  constructor(deps: PusherDeps = {}) {
    this.deps = {
      send: deps.send ?? ((rows) => sendEvidenceBatch(rows)),
      sleep: deps.sleep ?? realSleep,
      onDone: deps.onDone ?? markPushed,
      configured: deps.configured ?? (() => evidencePushConfigured()),
      log: deps.log ?? ((m) => console.log(m)),
      retryDelays: deps.retryDelays ?? RETRY_DELAYS_MS,
      flushAfterMs: deps.flushAfterMs ?? FLUSH_AFTER_MS,
      alert: deps.alert ?? slackAlert,
      now: deps.now ?? Date.now,
    };
  }

  private pausedUntil = 0;

  get pending(): number {
    return this.queue.length;
  }

  /** True while MailBridge is refusing our key (see AUTH_PAUSE_MS). */
  get paused(): boolean {
    return this.deps.now() < this.pausedUntil;
  }

  private pauseForAuth(err: PushError): void {
    this.pausedUntil = this.deps.now() + AUTH_PAUSE_MS;
    const msg =
      `[evidence-push] MailBridge refused MAILBRIDGE_API_KEY (HTTP ${err.status}). ` +
      `Evidence is still stored in email_provenance but nothing is sent; pausing ${AUTH_PAUSE_MS / 60000} min. ` +
      `Fix the key on Railway (Clay-simple-cache) — the sweeper resends everything once it works.`;
    console.error(msg);
    this.deps.alert(msg).catch(() => undefined);
  }

  /** Never throws and never waits: appends and schedules a flush. */
  enqueue(entries: ProvenanceEntry[]): void {
    try {
      if (!this.deps.configured()) {
        if (!this.warnedUnconfigured) {
          this.warnedUnconfigured = true;
          this.deps.log(
            "[evidence-push] MAILBRIDGE_API_KEY not set: provenance is stored but not sent to MailBridge"
          );
        }
        return;
      }
      for (const e of entries) {
        if (this.inFlight.has(e.id)) continue;
        const rows = toEvidenceRows(e);
        if (rows.length === 0) continue;
        if (this.queue.length >= MAX_QUEUE_ITEMS) {
          this.deps.log(`[evidence-push] queue full (${MAX_QUEUE_ITEMS}); the sweeper will pick up the rest from email_provenance`);
          break;
        }
        this.inFlight.add(e.id);
        this.queue.push({ id: e.id, rows });
      }
      this.schedule();
    } catch (err: any) {
      this.deps.log(`[evidence-push] enqueue failed: ${err?.message || err}`);
    }
  }

  private schedule(): void {
    if (this.queue.length === 0) return;
    const rowCount = this.queue.reduce((n, i) => n + i.rows.length, 0);
    if (rowCount >= BATCH_ROWS) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.flushAfterMs);
    this.timer.unref?.();
  }

  /** Send everything queued. Resolves when the queue is empty. Safe to call concurrently. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (this.queue.length > 0) this.schedule();
      });
    }
    return this.draining;
  }

  private takeBatch(): QueueItem[] {
    const batch: QueueItem[] = [];
    let rows = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (batch.length > 0 && rows + next.rows.length > BATCH_ROWS) break;
      batch.push(this.queue.shift() as QueueItem);
      rows += next.rows.length;
    }
    return batch;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.paused) {
        // Drop what is queued: it is in email_provenance and the sweeper re-queues it after the pause.
        for (const item of this.queue) this.inFlight.delete(item.id);
        this.queue = [];
        return;
      }
      const batch = this.takeBatch();
      const ids = batch.map((b) => b.id);
      try {
        await this.sendWithRetry(batch);
      } catch (err: any) {
        // Gave up for now. The facts stay unpushed in email_provenance, and the sweeper re-queues them.
        this.deps.log(`[evidence-push] ${batch.length} facts not delivered (kept for the sweeper): ${err?.message || err}`);
        for (const id of ids) this.inFlight.delete(id);
        if (err instanceof PushError && err.authFailure) this.pauseForAuth(err);
      }
    }
  }

  private async sendWithRetry(batch: QueueItem[]): Promise<void> {
    const flat: EvidenceRow[] = [];
    const owner: string[] = []; // flat row index → history id
    for (const item of batch) {
      for (const r of item.rows) {
        flat.push(r);
        owner.push(item.id);
      }
    }
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.deps.send(flat);
        const rejected = res.rejected.map((r) => ({ id: owner[r.index], reason: r.reason })).filter((r) => r.id);
        const rejectedIds = new Set(rejected.map((r) => r.id));
        // A fact with only some rows rejected still counts as rejected: it can't be fixed by retrying.
        const ok = batch.map((b) => b.id).filter((id) => !rejectedIds.has(id));
        await this.deps.onDone({ ids: ok, rejected });
        for (const b of batch) this.inFlight.delete(b.id);
        return;
      } catch (err) {
        const retryable = err instanceof PushError ? err.retryable : true;
        if (!retryable || attempt >= this.deps.retryDelays.length) throw err;
        await this.deps.sleep(this.deps.retryDelays[attempt++]);
      }
    }
  }
}

async function slackAlert(msg: string): Promise<void> {
  await postSlackMessage(`:rotating_light: Clay cache → MailBridge: ${msg}`);
}

async function markPushed(done: { ids: string[]; rejected: { id: string; reason: string }[] }): Promise<void> {
  const now = new Date();
  if (done.ids.length > 0) {
    await prisma.emailProvenance.updateMany({ where: { id: { in: done.ids } }, data: { pushed_at: now, push_error: null } });
  }
  for (const r of done.rejected) {
    await prisma.emailProvenance.updateMany({
      where: { id: r.id },
      data: { pushed_at: now, push_error: r.reason.slice(0, 300) },
    });
  }
}

export const evidencePusher = new EvidencePusher();

const SWEEP_EVERY_MS = 5 * 60 * 1000;
const SWEEP_LOOKBACK_DAYS = 14;

/** Re-queue facts MailBridge doesn't have yet (outage, restart, queue overflow). Backfill rows are pushed by their own script. */
export async function sweepUnpushed(pusher: EvidencePusher = evidencePusher, limit: number = BATCH_ROWS): Promise<number> {
  if (!evidencePushConfigured() || pusher.paused) return 0;
  const since = new Date(Date.now() - SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.emailProvenance.findMany({
    where: { pushed_at: null, push_error: null, origin: { in: ["find", "verify", "ingest"] }, created_at: { gt: since } },
    orderBy: { created_at: "asc" },
    take: limit,
  });
  const entries = rows.map(rowToEntry);
  // A fact with no provider MailBridge accepts produces no rows; close it out so
  // it doesn't sit at the head of the sweep forever and starve newer facts.
  const empty = entries.filter((e) => toEvidenceRows(e).length === 0).map((e) => e.id);
  if (empty.length > 0) {
    await prisma.emailProvenance.updateMany({ where: { id: { in: empty } }, data: { push_error: "nothing to send" } });
  }
  pusher.enqueue(entries.filter((e) => !empty.includes(e.id)));
  return rows.length;
}

export function rowToEntry(r: {
  id: string;
  email: string;
  finder: string | null;
  verifier: string | null;
  verdict: string;
  raw_status: string | null;
  confidence: number | null;
  method: string | null;
  origin: string;
  checked_at: Date;
  meta?: unknown;
}): ProvenanceEntry {
  return {
    id: r.id,
    email: r.email,
    finder: r.finder,
    verifier: r.verifier,
    verdict: r.verdict as ProvenanceEntry["verdict"],
    raw_status: r.raw_status,
    confidence: r.confidence,
    method: r.method,
    origin: r.origin as ProvenanceEntry["origin"],
    checked_at: r.checked_at.toISOString(),
    meta: (r.meta ?? null) as ProvenanceMeta | null,
  };
}

export function startEvidenceSweeper(): void {
  if (!evidencePushConfigured()) {
    console.log("[evidence-push] MAILBRIDGE_API_KEY not set: provenance is stored but not sent to MailBridge");
    return;
  }
  const tick = () => sweepUnpushed().catch((e) => console.error("[evidence-push] sweep failed:", e?.message || e));
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, SWEEP_EVERY_MS).unref?.();
}
