import prisma from "../db/prisma";
import { toEvidenceRows } from "../email-finder/provenance";
import { EVIDENCE } from "../email-finder/outcomes";
import { PushError, rowToEntry, sendEvidenceBatch, BATCH_ROWS } from "./evidence-push.service";

/**
 * Historical provenance: build `email_provenance` from `search_log` and
 * `verification_cache`, then push it to MailBridge. Both steps are re-runnable
 * (ids come from the source rows, inserts are ON CONFLICT DO NOTHING; a pushed
 * row is marked and MailBridge dedupes on sourceRef) and both default to a dry run.
 *
 * Mapping, the same one the live path uses:
 *   method emaillistverify | debounce | bouncer | neverbounce  -> verifier = method
 *   method domain_pattern | serp_pattern                        -> finder 'clay_cache', verifier null
 *   search_log row (a /find)                                    -> finder 'clay_cache'
 *   verification_cache row (a bare verification)                -> finder unknown (null) unless a pattern guess
 *   status -> verdict: valid, invalid, catch_all, risky as is; disposable, role_account -> risky;
 *                      no_mx -> invalid; anything else -> unknown (the raw status is kept)
 * Not facts, so not backfilled: known_email (an echo of a profile somebody else
 * ingested), local_* checks, domain_muted / domain_bounces refusals,
 * mailbridge_outcome (MailBridge's own data) and answers with no method.
 * Repeated searches for the same address with the same outcome collapse to the latest.
 */

const VERIFIER_METHODS = "('emaillistverify','debounce','bouncer','neverbounce')";
const GUESS_METHODS = "('domain_pattern','serp_pattern')";

const VERDICT_SQL = (col: string) => `CASE ${col}
  WHEN 'valid' THEN 'valid' WHEN 'invalid' THEN 'invalid' WHEN 'catch_all' THEN 'catch_all'
  WHEN 'risky' THEN 'risky' WHEN 'disposable' THEN 'risky' WHEN 'role_account' THEN 'risky'
  WHEN 'no_mx' THEN 'invalid' ELSE 'unknown' END`;

/** evidence tier → its measured bounce rate, the same table the live finder uses. */
const EXPECTED_BOUNCE_SQL = (col: string) =>
  `CASE ${col} ${Object.entries(EVIDENCE)
    .map(([tier, e]) => `WHEN '${tier}' THEN ${Number(e.expected_bounce)}`)
    .join(" ")} END`;

/** Gateway from the domain's MX hosts, as mailGateway() names them. */
const GATEWAY_SQL = `CASE WHEN di.mx_records::text ~* 'mimecast' THEN 'mimecast'
  WHEN di.mx_records::text ~* 'barracuda' THEN 'barracuda' WHEN di.mx_records::text ~* 'sophos' THEN 'sophos' END`;

/** The meta MailBridge reads from `raw` (see ProvenanceMeta); search_log knows more than the cache. */
const META_SQL = (fromSearch: boolean) => `jsonb_build_object(
    'send_recommendation', ${fromSearch ? "sl.send_recommendation" : "NULL"},
    'evidence_tier', ${fromSearch ? "sl.evidence" : "NULL"},
    'expected_bounce', ${fromSearch ? EXPECTED_BOUNCE_SQL("sl.evidence") : "NULL"},
    'mail_gateway', ${GATEWAY_SQL},
    'mx_provider', di.provider,
    'pattern', NULL,
    'searched_name', ${fromSearch ? "CASE WHEN coalesce(trim(sl.first_name), '') <> '' OR coalesce(trim(sl.last_name), '') <> '' THEN jsonb_build_object('first', NULLIF(trim(sl.first_name), ''), 'last', NULLIF(trim(sl.last_name), '')) END" : "NULL"})`;

export interface BackfillSource {
  origin: "backfill_search" | "backfill_cache";
  /** SELECT that yields the rows to insert, restricted to a [$1, $2) window of its date column. */
  select: string;
}

export const SOURCES: BackfillSource[] = [
  {
    origin: "backfill_search",
    select: `SELECT DISTINCT ON (lower(sl.result_email), sl.method_used, sl.result_status)
        sl.id, lower(sl.result_email) AS email, 'clay_cache'::text AS finder,
        CASE WHEN sl.method_used IN ${VERIFIER_METHODS} THEN sl.method_used END AS verifier,
        ${VERDICT_SQL("sl.result_status")} AS verdict, sl.result_status AS raw_status,
        NULL::float8 AS confidence, sl.method_used AS method, 'backfill_search'::text AS origin, sl.created_at AS checked_at,
        ${META_SQL(true)} AS meta
      FROM search_log sl
      LEFT JOIN domain_intel di ON di.domain = split_part(lower(sl.result_email), '@', 2)
      WHERE sl.result_email IS NOT NULL AND sl.result_email LIKE '%@%'
        AND (sl.method_used IN ${VERIFIER_METHODS} OR sl.method_used IN ${GUESS_METHODS})
        AND sl.created_at >= $1 AND sl.created_at < $2
      ORDER BY lower(sl.result_email), sl.method_used, sl.result_status, sl.created_at DESC`,
  },
  {
    origin: "backfill_cache",
    select: `SELECT vc.id, lower(vc.email) AS email,
        CASE WHEN vc.method IN ${GUESS_METHODS} THEN 'clay_cache' END AS finder,
        CASE WHEN vc.method IN ${VERIFIER_METHODS} THEN vc.method END AS verifier,
        ${VERDICT_SQL("vc.status")} AS verdict, vc.status AS raw_status,
        vc.confidence, vc.method, 'backfill_cache'::text AS origin, vc.verified_at AS checked_at,
        ${META_SQL(false)} AS meta
      FROM verification_cache vc
      LEFT JOIN domain_intel di ON di.domain = split_part(lower(vc.email), '@', 2)
      WHERE vc.email LIKE '%@%'
        AND (vc.method IN ${VERIFIER_METHODS} OR vc.method IN ${GUESS_METHODS})
        AND vc.verified_at >= $1 AND vc.verified_at < $2`,
  },
];

const DAY = 24 * 60 * 60 * 1000;

export interface BuildOptions {
  commit: boolean;
  since?: Date;
  windowDays?: number;
  log?: (m: string) => void;
}

/** Fill `email_provenance` from the legacy tables. Dry run counts what it would insert. */
export async function buildHistory(opts: BuildOptions): Promise<{ candidates: number; inserted: number }> {
  const log = opts.log ?? console.log;
  const step = (opts.windowDays ?? 7) * DAY;
  let candidates = 0;
  let inserted = 0;

  for (const src of SOURCES) {
    const table = src.origin === "backfill_search" ? "search_log" : "verification_cache";
    const col = src.origin === "backfill_search" ? "created_at" : "verified_at";
    const [{ lo, hi }] = await prisma.$queryRawUnsafe<{ lo: Date | null; hi: Date | null }[]>(
      `SELECT min(${col}) AS lo, max(${col}) AS hi FROM ${table}`
    );
    if (!lo || !hi) continue;
    let from = new Date(Math.max(lo.getTime(), opts.since?.getTime() ?? 0));
    const end = new Date(hi.getTime() + 1);
    let n = 0;
    let ins = 0;
    while (from < end) {
      const to = new Date(Math.min(from.getTime() + step, end.getTime()));
      if (opts.commit) {
        ins += Number(
          await prisma.$executeRawUnsafe(
            `INSERT INTO email_provenance (id, email, finder, verifier, verdict, raw_status, confidence, method, origin, checked_at, meta)
             SELECT id, email, finder, verifier, verdict, raw_status, confidence, method, origin, checked_at, meta FROM (${src.select}) s
             ON CONFLICT (id) DO NOTHING`,
            from,
            to
          )
        );
      } else {
        const [{ c }] = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) AS c FROM (${src.select}) s`, from, to);
        n += Number(c);
      }
      from = to;
    }
    candidates += n;
    inserted += ins;
    log(`${src.origin}: ${opts.commit ? `${ins} rows inserted` : `${n} rows would be inserted`}`);
  }
  return { candidates, inserted };
}

export interface PushOptions {
  commit: boolean;
  /** Batches per second sent to MailBridge. */
  rate?: number;
  /** Stop after this many batches (a gentle first run). */
  maxBatches?: number;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  send?: typeof sendEvidenceBatch;
}

/** Push backfilled history to MailBridge in batches of 500, rate limited. Dry run only counts. */
export async function pushHistory(opts: PushOptions): Promise<{ pending: number; batches: number; sent: number; rejected: number }> {
  const log = opts.log ?? console.log;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const send = opts.send ?? sendEvidenceBatch;
  const gap = 1000 / Math.max(opts.rate ?? 1, 0.05);

  const where = { pushed_at: null, push_error: null, origin: { in: ["backfill_search", "backfill_cache"] } };
  const pending = await prisma.emailProvenance.count({ where });
  if (!opts.commit) {
    log(`${pending} backfilled facts waiting to be pushed (dry run)`);
    return { pending, batches: 0, sent: 0, rejected: 0 };
  }

  let batches = 0;
  let sent = 0;
  let rejected = 0;
  for (;;) {
    if (opts.maxBatches && batches >= opts.maxBatches) break;
    // Pushed rows leave the filter, so the head of the queue is always the next batch.
    const rows = await prisma.emailProvenance.findMany({ where, orderBy: [{ created_at: "asc" }, { id: "asc" }], take: BATCH_ROWS });
    if (rows.length === 0) break;
    const flat: ReturnType<typeof toEvidenceRows> = [];
    const owner: string[] = [];
    for (const r of rows) {
      for (const e of toEvidenceRows(rowToEntry(r))) {
        flat.push(e);
        owner.push(r.id);
      }
    }
    // Rows with nothing to send (no valid provider) are closed out so they don't block the head of the queue.
    const empty = rows.filter((r) => !owner.includes(r.id)).map((r) => r.id);
    if (empty.length) await prisma.emailProvenance.updateMany({ where: { id: { in: empty } }, data: { push_error: "nothing to send" } });

    if (flat.length > 0) {
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await send(flat);
          break;
        } catch (err) {
          const retryable = err instanceof PushError ? err.retryable : true;
          if (!retryable || attempt >= 4) throw err;
          log(`  retrying after: ${(err as Error).message}`);
          await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        }
      }
      const bad = new Map(res.rejected.map((r) => [owner[r.index], r.reason]));
      const okIds = rows.map((r) => r.id).filter((id) => !bad.has(id) && !empty.includes(id));
      const now = new Date();
      if (okIds.length) await prisma.emailProvenance.updateMany({ where: { id: { in: okIds } }, data: { pushed_at: now } });
      for (const [id, reason] of bad) {
        if (id) await prisma.emailProvenance.updateMany({ where: { id }, data: { pushed_at: now, push_error: reason.slice(0, 300) } });
      }
      sent += flat.length - res.rejected.length;
      rejected += res.rejected.length;
    }
    batches++;
    log(`  batch ${batches}: ${flat.length} rows (sent ${sent}, rejected ${rejected})`);
    await sleep(gap);
  }
  return { pending, batches, sent, rejected };
}
