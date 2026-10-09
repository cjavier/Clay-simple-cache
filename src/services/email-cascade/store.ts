import prisma from "../../db/prisma";
import { postSlackMessage } from "../slack.service";
import { AttemptContext, AttemptStore, AttemptWrite, Breaker, PriorAttempt } from "./cascade";
import { CascadePerson, CascadeProviderId } from "./providers";
import { bareDomain } from "./providers";
import { splitName } from "./cache";

/** `email_attempts` and `email_provider_state` in Postgres. */

const LABEL: Record<string, string> = {
  blitzapi: "Blitz",
  prospeo: "Prospeo",
  findymail: "Findymail",
  findymail_verify: "Findymail (verificación)",
  debounce: "DeBounce",
  emaillistverify: "EmailListVerify",
};

/** Validators in fallback order, with the key each needs. */
const VALIDATOR_KEYS: Array<[string, string]> = [
  ["findymail_verify", "FINDYMAIL_API_KEY"],
  ["debounce", "DEBOUNCE_API_KEY"],
  ["emaillistverify", "EMAILLISTVERIFY_API_KEY"],
];
export const isValidator = (p: string) => VALIDATOR_KEYS.some(([id]) => id === p);

/** The validator now in charge: the first configured one whose breaker is closed. */
export async function activeValidator(): Promise<string | null> {
  for (const [id, env] of VALIDATOR_KEYS) {
    if (!process.env[env]) continue;
    if (!(await prismaBreaker.isExhausted(id))) return id;
  }
  return null;
}

export function validatorTripMessage(provider: string, reason: OpenReason, detail: string, next: string | null): string {
  const what = reason === "sin_creditos" ? "sin créditos" : "sin acceso (llave rechazada)";
  return (
    `:warning: *Validación de correos: ${providerLabel(provider)} ${what}* → ` +
    (next ? `se cambia a *${providerLabel(next)}*.` : `*no queda ningún validador*: los correos quedan pendientes de revalidar (no se descartan).`) +
    ` Cada hora se revisa su saldo y vuelve sola al recargar. \`${detail}\``
  );
}
export const providerLabel = (p: string) => LABEL[p] ?? p;

export const prismaAttempts: AttemptStore = {
  async prior(personKey: string): Promise<PriorAttempt[]> {
    return prisma.emailAttempt.findMany({
      where: { person_key: personKey, status: { in: ["found", "not_found"] } },
      select: { provider: true, status: true, resolved_at: true, updated_at: true },
    });
  },

  async record(personKey: string, person: CascadePerson, ctx: AttemptContext, w: AttemptWrite): Promise<void> {
    const now = new Date();
    const called = w.called !== false;
    const resolved = w.status === "found" || w.status === "not_found";
    const { first, last } = splitName(person);
    const identity = {
      linkedin_url: person.linkedin_url || null,
      first_name: first || null,
      last_name: last || null,
      full_name: person.full_name || null,
      company_domain: bareDomain(person.company_domain) || null,
      company_name: person.company_name || null,
    };
    const where = { person_key_provider_job_id: { person_key: personKey, provider: w.provider, job_id: ctx.job_id || "" } };
    const outcome = {
      status: w.status,
      reason: w.status === "pending" ? w.reason ?? "error" : null,
      email: w.email ?? null,
      last_error: w.error ? String(w.error).slice(0, 500) : null,
      resolved_at: resolved ? now : null,
      ...(called ? { attempted_at: now } : {}),
      ...(ctx.mb_table_id ? { mb_table_id: ctx.mb_table_id } : {}),
      ...(ctx.row_ref ? { row_ref: ctx.row_ref } : {}),
    };
    try {
      await prisma.emailAttempt.upsert({
        where,
        create: {
          person_key: personKey,
          provider: w.provider,
          job_id: ctx.job_id || "",
          ...identity,
          ...outcome,
          cost_usd: w.cost_usd ?? 0,
          tries: called ? 1 : 0,
        },
        update: {
          ...outcome,
          ...(w.cost_usd ? { cost_usd: { increment: w.cost_usd } } : {}),
          ...(called ? { tries: { increment: 1 } } : {}),
        },
      });
    } catch (e) {
      // Bookkeeping must never cost the person their row.
      console.error("[email-cascade] no se pudo registrar el intento:", e);
    }
  },

  async closePending(personKey: string, jobId: string, reason: "cache" | "encontrado", email: string | null): Promise<number> {
    const r = await prisma.emailAttempt.updateMany({
      where: { person_key: personKey, job_id: jobId, status: "pending" },
      data: { status: "closed", reason, email, resolved_at: new Date() },
    });
    return r.count;
  },
};

// ─── Breaker ────────────────────────────────────────────────

type OpenReason = "sin_creditos" | "sin_acceso";
const CACHE_MS = 30_000;
const cache = new Map<string, { reason: OpenReason | null; at: number }>();

export function resetBreakerCache() {
  cache.clear();
}

/** Delay before the "sin créditos" Slack, so its count covers the chunk in flight, not just the first person. */
const notifyDelay = () => Number(process.env.EMAIL_BREAKER_NOTIFY_DELAY_MS ?? 60_000);

export async function pendingSnapshot(provider: string): Promise<{ persons: number; campaigns: string[] }> {
  const rows = await prisma.emailAttempt.findMany({
    where: { provider, status: "pending" },
    distinct: ["person_key"],
    select: { person_key: true, job_id: true },
  });
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))];
  const jobs = jobIds.length
    ? await prisma.tableJob.findMany({ where: { id: { in: jobIds } }, select: { campaign: true } })
    : [];
  return { persons: rows.length, campaigns: [...new Set(jobs.map((j) => j.campaign))].sort() };
}

export function tripMessage(provider: string, reason: OpenReason, detail: string, snap: { persons: number; campaigns: string[] }): string {
  const what = reason === "sin_creditos" ? "sin créditos" : "sin acceso (llave rechazada)";
  const camps = snap.campaigns.length ? ` (${snap.campaigns.slice(0, 6).join(", ")}${snap.campaigns.length > 6 ? "…" : ""})` : "";
  return (
    `:red_circle: *${providerLabel(provider)} ${what}*; ${snap.persons} persona${snap.persons === 1 ? "" : "s"} pendiente${snap.persons === 1 ? "" : "s"}${camps}. ` +
    `Se dejó de llamar; las personas siguen con el siguiente proveedor y quedan pendientes para ${providerLabel(provider)}. ` +
    `Cada hora se revisa su saldo y, al recargar, se reactiva y procesa los pendientes solo. \`${detail}\``
  );
}

export const prismaBreaker: Breaker & {
  reactivate(provider: string): Promise<boolean>;
  states(): Promise<Array<{ provider: string; exhausted_at: Date | null; exhausted_reason: string | null; last_balance: number | null; low_alert_on: string | null; updated_at: Date }>>;
} = {
  async isExhausted(provider) {
    const c = cache.get(provider);
    if (c && Date.now() - c.at < CACHE_MS) return c.reason;
    let reason: OpenReason | null = null;
    try {
      const row = await prisma.emailProviderState.findUnique({ where: { provider } });
      reason = row?.exhausted_at ? ((row.exhausted_reason as OpenReason) || "sin_creditos") : null;
    } catch {
      /* table missing / DB hiccup: assume closed, the provider itself will say 402 */
    }
    cache.set(provider, { reason, at: Date.now() });
    return reason;
  },

  async trip(provider, reason, detail, _ctx) {
    cache.set(provider, { reason, at: Date.now() });
    await prisma.emailProviderState.upsert({ where: { provider }, create: { provider }, update: {} });
    const r = await prisma.emailProviderState.updateMany({
      where: { provider, exhausted_at: null },
      data: { exhausted_at: new Date(), exhausted_reason: reason, exhausted_detail: detail.slice(0, 500) },
    });
    if (r.count !== 1) return false;
    console.warn(`[email-cascade] breaker abierto: ${provider} (${reason}: ${detail})`);
    // One Slack per event: only the call that flipped the row announces it.
    if (isValidator(provider)) {
      // Switching validators is news right away; nobody is "pending" for a validator.
      void activeValidator()
        .then((next) => postSlackMessage(validatorTripMessage(provider, reason, detail, next)))
        .catch((e) => console.error("[email-cascade] aviso de validador falló:", e));
      return true;
    }
    setTimeout(() => {
      void pendingSnapshot(provider)
        .then((snap) => postSlackMessage(tripMessage(provider, reason, detail, snap)))
        .catch((e) => console.error("[email-cascade] aviso de breaker falló:", e));
    }, notifyDelay()).unref?.();
    return true;
  },

  async reactivate(provider) {
    const r = await prisma.emailProviderState.updateMany({
      where: { provider, exhausted_at: { not: null } },
      data: { exhausted_at: null, exhausted_reason: null, exhausted_detail: null, reactivated_at: new Date() },
    });
    cache.set(provider, { reason: null, at: Date.now() });
    return r.count === 1;
  },

  async states() {
    return prisma.emailProviderState.findMany({
      select: { provider: true, exhausted_at: true, exhausted_reason: true, last_balance: true, low_alert_on: true, updated_at: true },
    });
  },
};
