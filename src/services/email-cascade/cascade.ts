import { CacheHit, FoundEmail, personKey } from "./cache";
import { CascadePerson, CascadeProvider, CascadeProviderId, EmailVerification } from "./providers";
import { defaultPolicy, Policy, Qualification } from "./verify";

/**
 * findEmailCascade(person): cache first, then Blitz → Prospeo → Findymail.
 *
 *  1. Cache of profiles (LinkedIn, then name + domain). A hit is used with its
 *     ORIGINAL email_source; nobody pays.
 *  2. Each provider in order, unless:
 *     - it already answered for this person: `found` (ever) or `not_found`
 *       within EMAIL_NOT_FOUND_RETRY_DAYS (90) — a real "no" isn't bought twice;
 *     - its breaker is open (no credits) → the person stays `pending` for it;
 *     - the job's budget can't pay its unit cost → `pending` (presupuesto).
 *  3. What it found goes to the cache with its provenance.
 *
 * Every call outcome is written to `email_attempts`; that table is what the
 * retries (hourly reactivation, POST /emails/retry) work from.
 */

export type PendingReason = "sin_creditos" | "rate_limit" | "error" | "presupuesto" | "revalidar";

export interface AttemptContext {
  job_id?: string | null;
  mb_table_id?: string | null;
  row_ref?: string | null;
}

export interface PriorAttempt {
  provider: string;
  status: string;
  resolved_at: Date | null;
  updated_at: Date;
}

export interface AttemptWrite {
  /** "verify" = the address is known but awaits a conclusive validation. */
  provider: CascadeProviderId | "verify";
  status: "found" | "not_found" | "pending";
  reason?: PendingReason | null;
  email?: string | null;
  cost_usd?: number;
  error?: string | null;
  /** False when nobody was called (breaker open, no budget): the try isn't counted. */
  called?: boolean;
}

export interface AttemptStore {
  prior(personKey: string): Promise<PriorAttempt[]>;
  record(personKey: string, person: CascadePerson, ctx: AttemptContext, write: AttemptWrite): Promise<void>;
  /**
   * The person has an address now: their `pending` rows IN THIS JOB close
   * (reason: cache | encontrado). Other jobs keep theirs, so their tables
   * still get the address when those are retried (from the cache, free).
   */
  closePending(personKey: string, jobId: string, reason: "cache" | "encontrado", email: string | null): Promise<number>;
}

export interface Breaker {
  /** Why it's open (sin_creditos | sin_acceso), or null when the provider can be called. */
  isExhausted(provider: string): Promise<"sin_creditos" | "sin_acceso" | null>;
  /** Opens the breaker. Resolves true only for the call that opened it (the one that announces it). */
  trip(provider: string, reason: "sin_creditos" | "sin_acceso", detail: string, ctx: AttemptContext): Promise<boolean>;
}

export interface CascadeDeps {
  lookup(person: CascadePerson): Promise<CacheHit | null>;
  /** Write an address (and its validation, when there is one) to the cache. */
  save(person: CascadePerson, found: FoundEmail, q?: Qualification): Promise<void>;
  /** Validate the address and apply the acceptance policy. Absent = accept everything (finder-only tests). */
  qualify?: (email: string, person: CascadePerson, prior: unknown, policy: Policy) => Promise<Qualification>;
  attempts: AttemptStore;
  breaker: Breaker;
  providers: CascadeProvider[];
  now?: () => Date;
}

/** Spend cap for one build (or one retry run). Reserves before a call so parallel calls can't overshoot. */
export class Budget {
  private reserved = 0;
  exhausted = false;
  constructor(public readonly limitUsd: number, public spentUsd = 0) {}

  tryReserve(cost: number): boolean {
    if (cost <= 0) return true;
    if (this.spentUsd + this.reserved + cost > this.limitUsd + 1e-9) {
      this.exhausted = true;
      return false;
    }
    this.reserved += cost;
    return true;
  }

  /** A cost that can't be reserved ahead (a validation): just count it. */
  charge(cost: number) {
    if (cost > 0) this.spentUsd = Math.round((this.spentUsd + cost) * 1e6) / 1e6;
  }

  /** After the call: charge it if the provider billed, release it either way. */
  settle(cost: number, charged: boolean) {
    if (cost <= 0) return;
    this.reserved = Math.max(0, this.reserved - cost);
    if (charged) this.spentUsd = Math.round((this.spentUsd + cost) * 1e6) / 1e6;
  }
}

export type PendingProvider = CascadeProviderId | "verify";

/** An address that was found but didn't pass the policy (or awaits revalidation): goes to "Email Found", not "Email". */
export interface Candidate {
  email: string;
  email_source: string;
  qualification: Qualification;
}

export type CascadeResult =
  | {
      found: true;
      email: string;
      email_source: string;
      email_verification: EmailVerification | Record<string, unknown> | null;
      from_cache: boolean;
      email_found_via?: string | null;
      provider: CascadeProviderId | null;
      cost_usd: number;
      /** Validation + policy, when the cascade validates (production always does). */
      qualification?: Qualification;
    }
  | {
      found: false;
      pending: Array<{ provider: PendingProvider; reason: PendingReason }>;
      not_found: CascadeProviderId[];
      cost_usd: number;
      candidate?: Candidate;
    };

export interface CascadeOptions {
  ctx?: AttemptContext;
  budget?: Budget;
  /** Skip the cache read (the caller just read it). */
  skipCache?: boolean;
  /** Only these providers (a retry for one provider). Others are left as they are. */
  only?: PendingProvider[];
  /** Acceptance policy (default EMAIL_ACCEPT_POLICY, moderate). */
  policy?: Policy;
}

export function notFoundRetryDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EMAIL_NOT_FOUND_RETRY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

/** Has this provider already given a real answer for this person? */
export function alreadyAnswered(prior: PriorAttempt[], provider: string, now: Date, days = notFoundRetryDays()): boolean {
  return prior.some((a) => {
    if (a.provider !== provider) return false;
    if (a.status === "found") return true;
    if (a.status !== "not_found") return false;
    const at = (a.resolved_at ?? a.updated_at).getTime();
    return now.getTime() - at < days * 86_400_000;
  });
}

export async function findEmailCascade(person: CascadePerson, deps: CascadeDeps, opts: CascadeOptions = {}): Promise<CascadeResult> {
  const now = deps.now?.() ?? new Date();
  const ctx = opts.ctx ?? {};
  const policy = opts.policy ?? defaultPolicy();
  const key = personKey(person);
  const pending: Array<{ provider: PendingProvider; reason: PendingReason }> = [];
  const notFound: CascadeProviderId[] = [];
  let cost = 0;
  let candidate: Candidate | undefined;

  const record = async (w: AttemptWrite) => {
    if (key) await deps.attempts.record(key, person, ctx, w);
  };

  /** Validate + policy. Without a qualifier (tests of the finder alone) every address is accepted. */
  const check = async (email: string, source: string, prior: unknown): Promise<Qualification | null> => {
    if (!deps.qualify) return null;
    const q = await deps.qualify(email, person, prior, policy);
    if (q.cost_usd) {
      opts.budget?.charge(q.cost_usd);
      cost += q.cost_usd;
    }
    return q;
  };
  const revalidate = async (email: string, source: string, q: Qualification): Promise<CascadeResult> => {
    pending.push({ provider: "verify", reason: "revalidar" });
    await record({ provider: "verify", status: "pending", reason: "revalidar", email, called: q.validated_now, error: q.reason });
    return { found: false, pending, not_found: notFound, cost_usd: cost, candidate: { email, email_source: source, qualification: q } };
  };

  if (!opts.skipCache) {
    const cached = await deps.lookup(person);
    if (cached) {
      const prior = cached.email_verification ? { ...cached.email_verification, raw: cached.validator_response ?? null } : null;
      const q = await check(cached.email, cached.email_source || "clay_cache", prior);
      if (q && q.validated_now) await deps.save(person, { email: cached.email, source: cached.email_source || "clay_cache", verification: null }, q);
      if (!q || q.decision === "accept") {
        if (key && ctx.job_id) await deps.attempts.closePending(key, ctx.job_id, "cache", cached.email);
        return {
          found: true,
          email: cached.email,
          email_source: cached.email_source || "clay_cache",
          email_verification: q ? q.verification : cached.email_verification,
          email_found_via: cached.email_found_via,
          from_cache: true,
          provider: null,
          cost_usd: cost,
          ...(q ? { qualification: q } : {}),
        };
      }
      if (q.decision === "revalidate") return revalidate(cached.email, cached.email_source || "clay_cache", q);
      // Discarded: look for a better address.
      candidate = { email: cached.email, email_source: cached.email_source || "clay_cache", qualification: q };
      await record({ provider: "verify", status: "not_found", email: cached.email, called: q.validated_now, error: q.reason });
    }
  }

  const prior = key ? await deps.attempts.prior(key) : [];

  for (const provider of deps.providers) {
    if (opts.only && !opts.only.includes(provider.id)) continue;
    if (!provider.configured()) continue;
    if (alreadyAnswered(prior, provider.id, now)) {
      notFound.push(provider.id);
      continue;
    }
    const open = await deps.breaker.isExhausted(provider.id);
    if (open) {
      const reason: PendingReason = open === "sin_creditos" ? "sin_creditos" : "error";
      pending.push({ provider: provider.id, reason });
      await record({ provider: provider.id, status: "pending", reason, called: false, error: open === "sin_acceso" ? "proveedor sin acceso (breaker abierto)" : null });
      continue;
    }
    const unit = provider.costUsd();
    if (opts.budget && !opts.budget.tryReserve(unit)) {
      pending.push({ provider: provider.id, reason: "presupuesto" });
      await record({ provider: provider.id, status: "pending", reason: "presupuesto", called: false });
      continue;
    }

    let outcome;
    try {
      outcome = await provider.find(person);
    } catch (e: any) {
      outcome = { kind: "error" as const, detail: String(e?.message || e).slice(0, 300) };
    }
    opts.budget?.settle(unit, outcome.kind === "found");

    switch (outcome.kind) {
      case "found": {
        cost += unit;
        // The finder answered: it's not asked again for this person, whatever the validator says.
        await record({ provider: provider.id, status: "found", email: outcome.email, cost_usd: unit });
        const q = await check(outcome.email, provider.id, null);
        await deps.save(person, { email: outcome.email, source: provider.id, verification: outcome.verification }, q ?? undefined);
        if (!q || q.decision === "accept") {
          if (key) await deps.attempts.closePending(key, ctx.job_id || "", "encontrado", outcome.email);
          return {
            found: true,
            email: outcome.email,
            email_source: provider.id,
            email_verification: q ? q.verification : outcome.verification,
            from_cache: false,
            provider: provider.id,
            cost_usd: cost,
            ...(q ? { qualification: q } : {}),
          };
        }
        if (q.decision === "revalidate") return revalidate(outcome.email, provider.id, q);
        candidate = { email: outcome.email, email_source: provider.id, qualification: q };
        // The validation's "no" closes any wait for a verdict on this person.
        await record({ provider: "verify", status: "not_found", email: outcome.email, called: q.validated_now, error: q.reason });
        break; // discarded → next provider
      }
      case "not_found":
        notFound.push(provider.id);
        await record({ provider: provider.id, status: "not_found", error: outcome.detail ?? null });
        break;
      case "no_credits":
        await deps.breaker.trip(provider.id, outcome.reason, outcome.detail, ctx);
        pending.push({ provider: provider.id, reason: outcome.reason === "sin_creditos" ? "sin_creditos" : "error" });
        await record({ provider: provider.id, status: "pending", reason: outcome.reason === "sin_creditos" ? "sin_creditos" : "error", error: outcome.detail });
        break;
      case "rate_limit":
        pending.push({ provider: provider.id, reason: "rate_limit" });
        await record({ provider: provider.id, status: "pending", reason: "rate_limit", error: outcome.detail });
        break;
      default:
        pending.push({ provider: provider.id, reason: "error" });
        await record({ provider: provider.id, status: "pending", reason: "error", error: outcome.detail });
    }
  }

  return { found: false, pending, not_found: notFound, cost_usd: cost, ...(candidate ? { candidate } : {}) };
}
