/**
 * Daily credit check for every paid API this service depends on.
 *
 * Reads each provider's balance, classifies it green / yellow / red against
 * measured burn rate, writes the result to `provider_credits`, and posts to
 * Slack when something is wrong or has just changed.
 *
 * Usage:
 *   npx ts-node scripts/check_credits.ts              # check, persist, alert if needed
 *   npx ts-node scripts/check_credits.ts --dry-run    # check only, no DB write, no Slack
 *   npx ts-node scripts/check_credits.ts --force      # alert even if everything is green
 *
 * Exit code is 1 when any provider is red, so a cron or CI job fails visibly.
 */
import "dotenv/config";
import prisma from "../src/db/prisma";
import {
  checkAllCredits,
  getPreviousStatuses,
  persistReport,
} from "../src/services/credit-monitor.service";
import {
  sendCreditAlert,
  shouldNotify,
  isSlackConfigured,
} from "../src/services/slack.service";

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
    return report;
  }

  await persistReport(report);
  console.log("\nGuardado en provider_credits.");

  if (!notify && !FORCE) {
    console.log("Todo verde y sin cambios — sin alerta (silencio es lo normal).");
    return report;
  }

  if (!isSlackConfigured()) {
    console.log(
      "Slack no configurado (falta SLACK_TOKEN o SLACK_ALERT_CHANNEL) — sin alerta."
    );
    return report;
  }

  const sent = await sendCreditAlert(report, { changes });
  console.log(sent.ok ? `Alerta enviada a Slack (ts ${sent.ts}).` : `Slack falló: ${sent.error}`);
  return report;
}

main()
  .then((report) => {
    process.exitCode = report.worst === "red" ? 1 : 0;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
