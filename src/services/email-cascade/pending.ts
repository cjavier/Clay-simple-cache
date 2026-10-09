import prisma from "../../db/prisma";
import { postSlackMessage } from "../slack.service";
import { tableJobService } from "../table-job.service";
import { rowRef, toUpsertRow } from "../table-rows";
import { lookupCachedEmail, saveFoundEmail } from "./cache";
import { Budget, CascadeDeps, CascadeResult, findEmailCascade, PendingProvider, PendingReason } from "./cascade";
import { CascadePerson, CascadeProvider, CascadeProviderId, CASCADE_PROVIDERS, defaultProviders } from "./providers";
import { prismaAttempts, prismaBreaker, providerLabel } from "./store";
import { cascadeRowFields } from "./rows";
import { defaultValidators, Policy, qualify, Validator } from "./verify";

/**
 * Pending people: retried by hand (POST /emails/retry, /tables/:id/emails/retry,
 * MCP retry_pending_emails) or by the hourly check when a provider's breaker
 * closes again. Before anyone pays for a person, the cache is read: if Clay's
 * "Get Email (External)" (or anyone) already stored their address, the
 * pending closes for free. Whatever is found is written back to the person's
 * MailBridge table with the same `ref`, so MailBridge upserts the row.
 */

let providers: CascadeProvider[] | null = null;
export function cascadeProviders(): CascadeProvider[] {
  providers ??= defaultProviders();
  return providers;
}

let validators: Validator[] | null = null;
export function cascadeValidators(): Validator[] {
  validators ??= defaultValidators();
  return validators;
}

export function defaultDeps(): CascadeDeps {
  return {
    lookup: lookupCachedEmail,
    save: saveFoundEmail,
    qualify: (email, person, prior, policy) => qualify(email, person, prior, policy, { validators: cascadeValidators(), breaker: prismaBreaker }),
    attempts: prismaAttempts,
    breaker: prismaBreaker,
    providers: cascadeProviders(),
  };
}

export function defaultBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EMAIL_BUDGET_DEFAULT_USD);
  return Number.isFinite(n) && n >= 0 && env.EMAIL_BUDGET_DEFAULT_USD !== "" && env.EMAIL_BUDGET_DEFAULT_USD !== undefined ? n : 20;
}

export interface RetryFilter {
  job_id?: string;
  provider?: CascadeProviderId | "verify";
  reason?: PendingReason;
  /** Pending rows touched at or after this date. */
  since?: Date;
  /** Pending rows last touched before this (the hourly sweep leaves fresh ones alone). */
  before?: Date;
  reasons?: PendingReason[];
  exclude_providers?: string[];
  max_tries?: number;
  /** Max people per run. */
  limit?: number;
}

export interface PendingGroup {
  person_key: string;
  job_id: string;
  row_ref: string | null;
  person: CascadePerson;
  providers: PendingProvider[];
}

/** Pending rows → one group per person × job, with the providers to retry. */
export async function pendingGroups(f: RetryFilter): Promise<PendingGroup[]> {
  const limit = f.limit ?? 5000;
  const rows = await prisma.emailAttempt.findMany({
    where: {
      status: "pending",
      ...(f.job_id ? { job_id: f.job_id } : {}),
      ...(f.provider ? { provider: f.provider } : f.exclude_providers?.length ? { provider: { notIn: f.exclude_providers } } : {}),
      ...(f.reason ? { reason: f.reason } : f.reasons ? { reason: { in: f.reasons } } : {}),
      ...(f.since || f.before ? { updated_at: { ...(f.since ? { gte: f.since } : {}), ...(f.before ? { lt: f.before } : {}) } } : {}),
      ...(f.max_tries ? { tries: { lt: f.max_tries } } : {}),
    },
    orderBy: { created_at: "asc" },
    take: limit * CASCADE_PROVIDERS.length,
  });
  const groups = new Map<string, PendingGroup>();
  for (const r of rows) {
    const k = `${r.person_key}\u0000${r.job_id}`;
    let g = groups.get(k);
    if (!g) {
      if (groups.size >= limit) continue;
      g = {
        person_key: r.person_key,
        job_id: r.job_id,
        row_ref: r.row_ref,
        person: {
          linkedin_url: r.linkedin_url,
          first_name: r.first_name,
          last_name: r.last_name,
          full_name: r.full_name,
          company_domain: r.company_domain,
          company_name: r.company_name,
        },
        providers: [],
      };
      groups.set(k, g);
    }
    if (!g.row_ref && r.row_ref) g.row_ref = r.row_ref;
    if (!g.providers.includes(r.provider as PendingProvider)) g.providers.push(r.provider as PendingProvider);
  }
  return [...groups.values()];
}

/** The people row that carries the outcome back to its MailBridge table (upsert by the same ref). */
export function emailRow(g: Pick<PendingGroup, "row_ref" | "person">, r: CascadeResult) {
  const row: Record<string, unknown> = {
    ref: g.row_ref || (g.person.linkedin_url ? rowRef("people", { linkedin_url: g.person.linkedin_url }) : undefined),
    // It was "pendiente": a found address clears the reason the row showed.
    ...(r.found ? { discard_reason: "" } : {}),
  };
  for (const [k, v] of Object.entries(cascadeRowFields(r))) if (v !== undefined && v !== null) row[k] = v;
  return row;
}

export interface RetrySummary {
  trigger: string;
  persons: number;
  found: number;
  from_cache: number;
  still_pending: number;
  discarded: number;
  sent_to_mailbridge: number;
  spent_usd: number;
  by_source: Record<string, number>;
  errors: number;
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

/** Retry a list of pending groups now. Exported for tests (deps injectable). */
export async function processGroups(
  groups: PendingGroup[],
  opts: { trigger: string; budgetUsd: number; policy?: Policy; deps?: CascadeDeps; send?: (jobId: string, rows: Record<string, unknown>[]) => Promise<number> }
): Promise<RetrySummary> {
  const deps = opts.deps ?? defaultDeps();
  const send = opts.send ?? sendRows;
  const budget = new Budget(opts.budgetUsd);
  const out: RetrySummary = { trigger: opts.trigger, persons: groups.length, found: 0, from_cache: 0, still_pending: 0, discarded: 0, sent_to_mailbridge: 0, spent_usd: 0, by_source: {}, errors: 0 };
  const toSend = new Map<string, Record<string, unknown>[]>();

  await mapPool(groups, Number(process.env.EMAIL_RETRY_CONCURRENCY || 5), async (g) => {
    try {
      // The cascade reads the cache first: if Clay's function (or anyone) already found them,
      // the pending closes without paying for a finder (only a validation, if it has no recent verdict).
      const result = await findEmailCascade(g.person, deps, {
        ctx: { job_id: g.job_id, row_ref: g.row_ref },
        budget,
        only: g.providers,
        policy: opts.policy,
      });
      if (result.found && result.from_cache) out.from_cache++;
      if (!result.found) {
        if (result.candidate?.qualification.decision === "discard") out.discarded++;
        else out.still_pending++;
        // A verdict changed the row (discarded / still awaiting): tell MailBridge too.
        if (result.candidate && g.job_id) {
          const list = toSend.get(g.job_id) ?? [];
          list.push(emailRow(g, result));
          toSend.set(g.job_id, list);
        }
        return;
      }
      out.found++;
      out.by_source[result.email_source] = (out.by_source[result.email_source] || 0) + 1;
      if (g.job_id) {
        const list = toSend.get(g.job_id) ?? [];
        list.push(emailRow(g, result));
        toSend.set(g.job_id, list);
      }
    } catch (e) {
      out.errors++;
      console.error("[email-cascade] reintento falló para", g.person_key, e);
    }
  });

  for (const [jobId, rows] of toSend) {
    try {
      out.sent_to_mailbridge += await send(jobId, rows);
    } catch (e) {
      console.error(`[email-cascade] no se pudieron encolar ${rows.length} filas para ${jobId}:`, e);
    }
  }
  out.spent_usd = budget.spentUsd;
  return out;
}

/** Queue rows for the job's people table (same sender as POST /tables/:id/rows). */
async function sendRows(jobId: string, rows: Record<string, unknown>[]): Promise<number> {
  const job = await prisma.tableJob.findUnique({ where: { id: jobId }, select: { tables: true } });
  if (!(job?.tables as any)?.people) return 0;
  const mapped = rows.filter((r) => r.ref).map((r, i) => toUpsertRow("people", r, i));
  if (mapped.length) await tableJobService.enqueue(jobId, "people", mapped);
  return mapped.length;
}

export function summaryMessage(s: RetrySummary, label: string): string {
  const src = Object.entries(s.by_source).map(([k, n]) => `${k} ${n}`).join(", ");
  return (
    `:large_green_circle: *Correos pendientes — ${label}*: ${s.persons} persona${s.persons === 1 ? "" : "s"} revisada${s.persons === 1 ? "" : "s"}; ` +
    `${s.found} con correo (${s.from_cache} ya estaban en cache, sin costo)${src ? ` · ${src}` : ""}; ` +
    `${s.discarded ? `${s.discarded} descartados por la validación; ` : ""}${s.still_pending} siguen pendientes; ${s.sent_to_mailbridge} filas reenviadas a MailBridge; gasto ~$${s.spent_usd.toFixed(2)} USD.`
  );
}

// One run at a time: a manual retry and the hourly one never fight over the same people.
let chain: Promise<unknown> = Promise.resolve();

/** Count now, process in the background. */
export async function queueRetry(f: RetryFilter, opts: { trigger: string; budgetUsd?: number; policy?: Policy; label?: string; notify?: boolean } = { trigger: "manual" }) {
  const groups = await pendingGroups(f);
  const pendingRows = groups.reduce((s, g) => s + g.providers.length, 0);
  if (groups.length) {
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        // A manual retry after a top-up shouldn't wait for the hourly check to close the breaker.
        if (opts.trigger === "manual") await refreshOpenBreakers().catch((e) => console.error("[email-cascade] no se pudo revisar saldos:", e));
        const s = await processGroups(groups, { trigger: opts.trigger, budgetUsd: opts.budgetUsd ?? defaultBudgetUsd(), policy: opts.policy });
        console.log(`[email-cascade] ${opts.trigger}: ${JSON.stringify(s)}`);
        // The hourly sweep only speaks when it found something; manual and reactivation runs always report.
        const speak = opts.notify !== false && s.persons > 0 && (opts.trigger !== "hourly" || s.found > 0);
        if (speak) await postSlackMessage(summaryMessage(s, opts.label ?? opts.trigger));
        return s;
      });
  }
  return { persons: groups.length, pending_rows: pendingRows };
}

/** Close the breaker of any provider whose (free) balance says it has credits again. */
export async function refreshOpenBreakers(): Promise<string[]> {
  const reopened: string[] = [];
  for (const p of [...cascadeProviders(), ...cascadeValidators()]) {
    if (!p.balance || !p.configured()) continue;
    if (!(await prismaBreaker.isExhausted(p.id))) continue;
    const b = await p.balance();
    if (b.balance !== null && b.balance > 0 && (await prismaBreaker.reactivate(p.id))) reopened.push(p.id);
  }
  return reopened;
}

/** Pending people of one job, for GET /tables/:id. */
export async function jobPendingSummary(jobId: string) {
  const [byProv, persons, closed] = await Promise.all([
    prisma.emailAttempt.groupBy({ by: ["provider", "reason"], where: { job_id: jobId, status: "pending" }, _count: { _all: true } }),
    prisma.emailAttempt.findMany({ where: { job_id: jobId, status: "pending" }, distinct: ["person_key"], select: { person_key: true } }),
    prisma.emailAttempt.count({ where: { job_id: jobId, status: "closed" } }),
  ]);
  const by_provider: Record<string, Record<string, number>> = {};
  for (const r of byProv) (by_provider[r.provider] ??= {})[r.reason || "?"] = r._count._all;
  return { persons: persons.length, by_provider, closed_rows: closed };
}

export { providerLabel };
