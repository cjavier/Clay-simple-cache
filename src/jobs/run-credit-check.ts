import {
  checkAllCredits,
  getPreviousStatuses,
  persistReport,
  CreditReport,
} from "../services/credit-monitor.service";
import {
  sendCreditAlert,
  shouldNotify,
  isSlackConfigured,
} from "../services/slack.service";

/**
 * One credit check: probe every provider, record it, alert if warranted.
 *
 * Shared by the CLI (`npm run check:credits`) and the in-process daily
 * scheduler, so a manual run and a scheduled one can't drift apart.
 */

export interface RunOptions {
  /** Probe and report, but write nothing and send nothing. */
  dryRun?: boolean;
  /** Alert even when everything is green and unchanged. */
  force?: boolean;
  /** Where to write progress. Defaults to console.log. */
  log?: (line: string) => void;
}

export interface RunResult {
  report: CreditReport;
  /**
   * True only when an alert was warranted and Slack rejected it. A problem
   * found and nobody told is worse than not checking, so this is the one
   * outcome the caller should treat as a failure.
   */
  alertFailed: boolean;
  notified: boolean;
}

const ICON: Record<string, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

function formatReport(report: CreditReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  lines.push(
    `Saldos de APIs — ${report.checked_at.toISOString()}${dryRun ? "  (DRY RUN)" : ""}`
  );
  lines.push(
    `Consumo medido: ${Math.round(report.burn.searches)} búsquedas/día, ` +
      `${Math.round(report.burn.verifications)} verificaciones/día`
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
    lines.push(
      `  ${ICON[c.status]} ${c.label.padEnd(18)} ${bal.padStart(12)} ${c.unit.padEnd(8)}${runway}`
    );
    if (c.error) lines.push(`      ${c.error}`);
  }
  return lines;
}

export async function runCreditCheck(opts: RunOptions = {}): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const report = await checkAllCredits();

  for (const line of formatReport(report, !!opts.dryRun)) log(line);

  const previous = await getPreviousStatuses();
  const { notify, changes } = shouldNotify(report, previous);

  if (changes.length > 0) {
    log("Cambios desde la última revisión:");
    for (const ch of changes) log(`  ${ch}`);
  }

  if (opts.dryRun) {
    log(
      `Dry run — no se escribió nada. ${
        notify || opts.force
          ? "Se habría enviado alerta a Slack."
          : "No se habría alertado."
      }`
    );
    return { report, alertFailed: false, notified: false };
  }

  await persistReport(report);
  log("Guardado en provider_credits.");

  if (!notify && !opts.force) {
    log("Todo verde y sin cambios — sin alerta (silencio es lo normal).");
    return { report, alertFailed: false, notified: false };
  }

  if (!isSlackConfigured()) {
    log("Slack no configurado (falta SLACK_TOKEN o SLACK_ALERT_CHANNEL) — sin alerta.");
    // Not a failure: running without Slack is a valid local mode.
    return { report, alertFailed: false, notified: false };
  }

  const sent = await sendCreditAlert(report, { changes });
  log(sent.ok ? `Alerta enviada a Slack (ts ${sent.ts}).` : `Slack falló: ${sent.error}`);
  return { report, alertFailed: !sent.ok, notified: sent.ok };
}
