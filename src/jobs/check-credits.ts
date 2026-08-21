/**
 * Daily credit check for every paid API this service depends on.
 *
 * Reads each provider's balance, classifies it green / yellow / red against
 * measured burn rate, writes the result to `provider_credits`, and posts to
 * Slack when something is wrong or has just changed.
 *
 * Lives under src/ (not scripts/) so `tsc` compiles it into dist/ — the Railway
 * cron service runs the compiled `node dist/jobs/check-credits.js`, with no
 * ts-node in the production image.
 *
 * Usage:
 *   npm run check:credits              # check, persist, alert if needed
 *   npm run check:credits -- --dry-run # check only, no DB write, no Slack
 *   npm run check:credits -- --force   # alert even if everything is green
 *   node dist/jobs/check-credits.js    # production / Railway cron
 *
 * Exit code reflects whether THIS JOB worked, not what it found. A red provider
 * is a successful detection — Slack is the channel for that. Exiting non-zero on
 * a red provider made the Railway cron service read "last run failed" every day
 * for as long as the provider stayed broken, which is the same alert fatigue the
 * all-green silence rule exists to prevent. Non-zero is reserved for the job
 * genuinely failing: an unhandled error, or an alert that had to be delivered
 * and wasn't.
 */
import "dotenv/config";
import prisma from "../db/prisma";
import {
  checkAllCredits,
  getPreviousStatuses,
  persistReport,
} from "../services/credit-monitor.service";
import {
  sendCreditAlert,
  shouldNotify,
  isSlackConfigured,
} from "../services/slack.service";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const ICON: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

async function main() {
  const report = await checkAllCredits();

  console.log(
    `Saldos de APIs — ${report.checked_at.toISOString()}${DRY_RUN ? "  (DRY RUN)" : ""}\n`
  );
  console.log(
    `Consumo medido: ${Math.round(report.burn.searches)} búsquedas/día, ` +
      `${Math.round(report.burn.verifications)} verificaciones/día\n`
  );

  for (const c of report.checks) {
    const bal =
      c.balance === null
        ? "—"
        : c.unit === "usd"
        ? `$${c.balance.toFixed(2)}`
        : c.balance.toLocaleString("en-US");
    const runway =
      c.days_left === null ? "" : `  ~${Math.round(c.days_left)}d de margen`;
    console.log(
      `  ${ICON[c.status]} ${c.label.padEnd(18)} ${bal.padStart(12)} ${c.unit.padEnd(8)}${runway}`
    );
    if (c.error) console.log(`      ${c.error}`);
  }

  const previous = await getPreviousStatuses();
  const { notify, changes } = shouldNotify(report, previous);

  if (changes.length > 0) {
    console.log("\nCambios desde la última revisión:");
    for (const ch of changes) console.log(`  ${ch}`);
  }

  if (DRY_RUN) {
    console.log(
      `\nDry run — no se escribió nada. ${
        notify || FORCE ? "Se habría enviado alerta a Slack." : "No se habría alertado."
      }`
    );
    return { report, alertFailed: false };
  }

  await persistReport(report);
  console.log("\nGuardado en provider_credits.");

  if (!notify && !FORCE) {
    console.log("Todo verde y sin cambios — sin alerta (silencio es lo normal).");
    return { report, alertFailed: false };
  }

  if (!isSlackConfigured()) {
    console.log(
      "Slack no configurado (falta SLACK_TOKEN o SLACK_ALERT_CHANNEL) — sin alerta."
    );
    // Deliberately not a failure: running without Slack is a valid local mode.
    return { report, alertFailed: false };
  }

  const sent = await sendCreditAlert(report, { changes });
  console.log(sent.ok ? `Alerta enviada a Slack (ts ${sent.ts}).` : `Slack falló: ${sent.error}`);
  // An undelivered alert IS a job failure: the problem was found and nobody was
  // told, which is worse than not checking at all.
  return { report, alertFailed: !sent.ok };
}

main()
  .then(({ alertFailed }) => {
    process.exitCode = alertFailed ? 1 : 0;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
