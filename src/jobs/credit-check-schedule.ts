import prisma from "../db/prisma";
import { runCreditCheck } from "./run-credit-check";

/**
 * Daily credit check, scheduled inside the API process.
 *
 * This replaces a Railway cron service. That service fired exactly once and
 * then stopped: a schedule set through the dashboard/API attaches to the
 * deployment that existed at that moment, so every later deploy — including
 * every `git push` — produced a deployment with no cron, and the check silently
 * stopped running. Config-as-code didn't take either. A monitor that doesn't
 * run is worse than no monitor, because it looks like coverage.
 *
 * The API service is already up 24/7, so the schedule lives here instead: it's
 * plain code, it survives every deploy, and the timing logic is unit-testable,
 * which the Railway scheduler was not.
 */

const HOUR_UTC = Number(process.env.CREDIT_CHECK_HOUR_UTC || 14); // 08:00 CDMX
const MINUTE_UTC = Number(process.env.CREDIT_CHECK_MINUTE_UTC || 0);

/** Next occurrence of HOUR:MINUTE UTC strictly after `now`. */
export function nextRunAt(
  now: Date,
  hourUtc: number = HOUR_UTC,
  minuteUtc: number = MINUTE_UTC
): Date {
  const next = new Date(now);
  next.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/**
 * Whether to run immediately on boot.
 *
 * A restart resets the timer, so a deploy at the wrong moment would skip that
 * day entirely. `provider_credits` already records every check, so we can ask
 * the cheaper question: has today's scheduled time passed with no check
 * recorded since? If so, run now — the day still gets its check. This is also
 * what makes a redeploy-heavy day safe.
 */
export function shouldCatchUp(
  lastCheckedAt: Date | null,
  now: Date,
  hourUtc: number = HOUR_UTC,
  minuteUtc: number = MINUTE_UTC
): boolean {
  const todaysRun = new Date(now);
  todaysRun.setUTCHours(hourUtc, minuteUtc, 0, 0);
  // Scheduled time hasn't arrived yet today — nothing to catch up on.
  if (now.getTime() < todaysRun.getTime()) return false;
  // Never checked at all, or not since today's scheduled time.
  return !lastCheckedAt || lastCheckedAt.getTime() < todaysRun.getTime();
}

async function lastCheckAt(): Promise<Date | null> {
  try {
    const row = await prisma.providerCredit.findFirst({
      orderBy: { checked_at: "desc" },
      select: { checked_at: true },
    });
    return row?.checked_at ?? null;
  } catch {
    // Table missing or DB unreachable — don't let that stop the schedule.
    return null;
  }
}

async function runOnce(reason: string): Promise<void> {
  console.log(`[credit-check] corriendo (${reason})`);
  try {
    const { report, alertFailed } = await runCreditCheck({
      log: (l) => console.log(`[credit-check] ${l}`),
    });
    if (alertFailed) {
      console.error(
        "[credit-check] se detectó un problema y la alerta de Slack NO se entregó"
      );
    }
    console.log(`[credit-check] listo — estado global: ${report.worst}`);
  } catch (e) {
    // The monitor must never take the API down with it.
    console.error("[credit-check] la revisión falló:", e);
  }
}

let timer: NodeJS.Timeout | null = null;

function scheduleNext(): void {
  const now = new Date();
  const next = nextRunAt(now);
  const delay = next.getTime() - now.getTime();
  console.log(
    `[credit-check] próxima revisión ${next.toISOString()} ` +
      `(en ${Math.round(delay / 60000)} min)`
  );
  timer = setTimeout(async () => {
    await runOnce("programada");
    scheduleNext();
  }, delay);
}

/**
 * Arm the daily schedule. Off unless CREDIT_CHECK_DAILY=true, so local dev and
 * tests never post to the team's Slack channel by merely starting the server.
 */
export function startCreditCheckSchedule(): void {
  if (process.env.CREDIT_CHECK_DAILY !== "true") {
    console.log(
      "[credit-check] desactivado (CREDIT_CHECK_DAILY != true)"
    );
    return;
  }
  if (timer) return; // already armed

  scheduleNext();

  // Catch up asynchronously so a slow probe never delays server startup.
  void (async () => {
    if (shouldCatchUp(await lastCheckAt(), new Date())) {
      await runOnce("recuperando la revisión de hoy tras un reinicio");
    }
  })();
}

export function stopCreditCheckSchedule(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
