import prisma from "../../db/prisma";
import { postSlackMessage } from "../slack.service";
import { cascadeProviders, cascadeValidators, queueRetry } from "./pending";
import { pendingSnapshot, prismaBreaker, providerLabel, resetBreakerCache, tripMessage, isValidator, activeValidator, validatorTripMessage } from "./store";

/** What the tick needs of a finder or a validator. */
interface Checkable {
  id: string;
  configured(): boolean;
  balance?(): Promise<{ balance: number | null; error: string | null }>;
}

/**
 * Hourly, in-process (same reason as the credit check: a Railway cron
 * silently stopped firing once). For each paid finder with a free balance
 * endpoint (Prospeo, Findymail):
 *  - breaker open and balance > 0 → reactivate, Slack, retry its pending people;
 *  - breaker closed and balance ≤ 0 → open it before anyone gets a 402;
 *  - balance under its threshold → one Slack per provider per day.
 * Providers without a balance endpoint (Blitz) are half-opened after
 * EMAIL_BREAKER_PROBE_HOURS (6): the next call decides.
 * Also retries people left pending by a rate limit or an error (older than an
 * hour, fewer than EMAIL_MAX_TRIES tries). `presupuesto` is never retried
 * by itself: spending more is a decision.
 *
 * State lives in the DB (`email_provider_state`, `email_attempts`), so a
 * restart only delays the next tick; it runs EMAIL_CASCADE_FIRST_RUN_MS after boot.
 */

const HOUR = 60 * 60 * 1000;

export function lowThreshold(provider: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[`EMAIL_LOW_CREDITS_${provider.toUpperCase()}`] ?? env.EMAIL_LOW_CREDITS;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) ? n : 500;
}

/** YYYY-MM-DD in CDMX: "once a day" means the team's day. */
export function cdmxDay(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

export interface TickDeps {
  providers: Checkable[];
  now?: () => Date;
  notify?: (text: string) => Promise<unknown>;
  retry?: typeof queueRetry;
}

export interface TickReport {
  provider: string;
  balance: number | null;
  error: string | null;
  action: "reactivated" | "tripped" | "low" | "ok" | "unreadable" | "probe";
  queued?: number;
}

export async function hourlyTick(d: TickDeps = { providers: [...cascadeProviders(), ...cascadeValidators()] }): Promise<TickReport[]> {
  const now = d.now?.() ?? new Date();
  const notify = d.notify ?? postSlackMessage;
  const retry = d.retry ?? queueRetry;
  const out: TickReport[] = [];

  for (const p of d.providers) {
    if (!p.configured()) continue;
    const state = await prisma.emailProviderState.findUnique({ where: { provider: p.id } });

    if (!p.balance) {
      const hours = Number(process.env.EMAIL_BREAKER_PROBE_HOURS || 6);
      if (state?.exhausted_at && now.getTime() - state.exhausted_at.getTime() > hours * HOUR) {
        await prismaBreaker.reactivate(p.id);
        const q = await retry({ provider: p.id as any, reasons: ["sin_creditos", "error"] }, { trigger: "reactivation", label: `${providerLabel(p.id)} reactivado (prueba)` });
        out.push({ provider: p.id, balance: null, error: null, action: "probe", queued: q.persons });
      }
      continue;
    }

    const b = await p.balance();
    await prisma.emailProviderState.upsert({
      where: { provider: p.id },
      create: { provider: p.id, last_balance: b.balance, last_balance_at: now },
      update: { ...(b.balance !== null ? { last_balance: b.balance } : {}), last_balance_at: now },
    });
    if (b.balance === null) {
      out.push({ provider: p.id, balance: null, error: b.error, action: "unreadable" });
      continue;
    }

    if (state?.exhausted_at && b.balance > 0) {
      await prismaBreaker.reactivate(p.id);
      if (isValidator(p.id)) {
        // Validation is back: the addresses that waited for a verdict get one.
        const q = await retry({ provider: "verify", reason: "revalidar" }, { trigger: "reactivation", label: `validación con ${providerLabel(p.id)}` });
        await notify(`:large_green_circle: *Validación de correos: ${providerLabel(p.id)} reactivado* (saldo ${b.balance.toLocaleString("en-US")}); vuelve a ser el validador${q.persons ? ` y revalida ${q.persons} correo${q.persons === 1 ? "" : "s"} pendiente${q.persons === 1 ? "" : "s"}` : ""}.`);
        out.push({ provider: p.id, balance: b.balance, error: null, action: "reactivated", queued: q.persons });
        continue;
      }
      const q = await retry({ provider: p.id as any, reasons: ["sin_creditos", "error"] }, { trigger: "reactivation", label: `${providerLabel(p.id)} reactivado` });
      await notify(
        `:large_green_circle: *${providerLabel(p.id)} reactivado*: saldo ${b.balance.toLocaleString("en-US")} créditos. ` +
          `Procesando ${q.persons} persona${q.persons === 1 ? "" : "s"} pendiente${q.persons === 1 ? "" : "s"} (antes se revisa el cache: lo que ya encontró Clay no se paga).`
      );
      out.push({ provider: p.id, balance: b.balance, error: null, action: "reactivated", queued: q.persons });
      continue;
    }

    if (!state?.exhausted_at && b.balance <= 0) {
      const flipped = await prisma.emailProviderState.updateMany({
        where: { provider: p.id, exhausted_at: null },
        data: { exhausted_at: now, exhausted_reason: "sin_creditos", exhausted_detail: "saldo 0 (chequeo horario)" },
      });
      resetBreakerCache();
      if (flipped.count === 1) {
        await notify(
          isValidator(p.id)
            ? validatorTripMessage(p.id, "sin_creditos", "saldo 0 (chequeo horario)", await activeValidator())
            : tripMessage(p.id, "sin_creditos", "saldo 0 (chequeo horario)", await pendingSnapshot(p.id))
        );
      }
      out.push({ provider: p.id, balance: b.balance, error: null, action: "tripped" });
      continue;
    }

    const threshold = lowThreshold(p.id);
    const today = cdmxDay(now);
    if (b.balance > 0 && b.balance < threshold && state?.low_alert_on !== today) {
      await prisma.emailProviderState.update({ where: { provider: p.id }, data: { low_alert_on: today } });
      await notify(
        `:large_yellow_circle: *${providerLabel(p.id)} con saldo bajo*: ${b.balance.toLocaleString("en-US")} créditos (umbral ${threshold.toLocaleString("en-US")}). ` +
          `Al llegar a 0 se deja de llamar y las personas quedan pendientes hasta que se recargue.`
      );
      out.push({ provider: p.id, balance: b.balance, error: null, action: "low" });
      continue;
    }
    out.push({ provider: p.id, balance: b.balance, error: null, action: "ok" });
  }

  // People left pending by a rate limit or an error, once the dust settled
  // (not for a provider whose breaker is open: that waits for its reactivation).
  const maxTries = Number(process.env.EMAIL_MAX_TRIES || 5);
  const open = (await prisma.emailProviderState.findMany({ where: { exhausted_at: { not: null } }, select: { provider: true } })).map((r) => r.provider);
  await retry(
    { reasons: ["rate_limit", "error"], before: new Date(now.getTime() - HOUR), max_tries: maxTries, limit: 200, exclude_providers: open },
    { trigger: "hourly", label: "reintento horario (rate limit / error)" }
  );
  // Addresses still without a conclusive verdict, once a day, a few times at most.
  await retry(
    { provider: "verify", reason: "revalidar", before: new Date(now.getTime() - 24 * HOUR), max_tries: 3, limit: 200 },
    { trigger: "hourly", label: "revalidación diaria" }
  );
  return out;
}

let timer: NodeJS.Timeout | null = null;

/** Arm the hourly check. Off unless EMAIL_CASCADE_HOURLY=true (local servers never call providers or Slack by starting). */
export function startEmailCascadeSchedule(): void {
  if (process.env.EMAIL_CASCADE_HOURLY !== "true") {
    console.log("[email-cascade] chequeo horario desactivado (EMAIL_CASCADE_HOURLY != true)");
    return;
  }
  if (timer) return;
  const run = () =>
    hourlyTick()
      .then((r) => console.log(`[email-cascade] chequeo horario: ${JSON.stringify(r)}`))
      .catch((e) => console.error("[email-cascade] chequeo horario falló:", e));
  setTimeout(run, Number(process.env.EMAIL_CASCADE_FIRST_RUN_MS || 2 * 60 * 1000)).unref();
  timer = setInterval(run, HOUR);
  timer.unref();
}
