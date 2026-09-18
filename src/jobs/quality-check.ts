import { scoreRecentAnswers, QualityReport } from "../services/finder-quality.service";
import { postSlackMessage, isSlackConfigured } from "../services/slack.service";

/**
 * Daily read on whether the finder is still answering *correctly* and *in time*.
 *
 * The credit monitor exists because a depleted provider returns `unknown`,
 * which looks exactly like "no such address" — it caught a 103-day blackout in
 * which 117,696 searches and $2,618 produced zero results. This is the same
 * idea one level up: a finder can be fully funded, fully up, answering 200 OK,
 * and still be wrong or too late to matter. The two failures that actually
 * happened, expressed as thresholds:
 *
 *  - `catch_all` agreement fell to 33.3% while `valid` held at 95.2%, and the
 *    single blended "success rate" on /stats showed neither.
 *  - The median answer drifted to 25 minutes, past the point where callers
 *    still use it — answers over an hour were kept only 29.4% of the time.
 */

export const THRESHOLDS = {
  /** Below this, addresses built from a domain pattern are worse than useless. */
  catch_all_agreement: Number(process.env.QUALITY_MIN_CATCHALL_AGREEMENT || 0.6),
  /** `valid` is a confirmed mailbox; anything under this means the cascade broke. */
  valid_agreement: Number(process.env.QUALITY_MIN_VALID_AGREEMENT || 0.85),
  /** Past this median, the caller has usually stopped waiting. */
  p50_ms: Number(process.env.QUALITY_MAX_P50_MS || 30_000),
  /** Ignore a rate computed from too few comparisons to mean anything. */
  min_comparable: Number(process.env.QUALITY_MIN_COMPARABLE || 40),
};

export interface QualityVerdict {
  report: QualityReport;
  problems: string[];
  alertFailed: boolean;
  notified: boolean;
}

export function findProblems(report: QualityReport): string[] {
  const problems: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  for (const [status, bucket] of Object.entries(report.by_status)) {
    if (bucket.comparable < THRESHOLDS.min_comparable) continue;
    if (bucket.agreement_rate === null) continue;

    const floor =
      status === "valid"
        ? THRESHOLDS.valid_agreement
        : THRESHOLDS.catch_all_agreement;

    if (bucket.agreement_rate < floor) {
      problems.push(
        `Precisión de \`${status}\`: ${pct(bucket.agreement_rate)} ` +
          `(${bucket.agreed}/${bucket.comparable} coinciden con el correo que otro proveedor entregó` +
          `, umbral ${pct(floor)})`
      );
    }
  }

  const p50 = report.latency.p50_ms;
  if (p50 !== null && p50 > THRESHOLDS.p50_ms) {
    problems.push(
      `Mediana de respuesta: ${Math.round(p50 / 1000)}s ` +
        `(umbral ${Math.round(THRESHOLDS.p50_ms / 1000)}s). ` +
        `Las respuestas que tardan más de una hora solo se aprovechan el 29.4% de las veces.`
    );
  }

  // Delivery is the other half of "too late": an answer nobody stored is an
  // answer nobody got, whatever the latency percentile says.
  for (const [status, bucket] of Object.entries(report.by_status)) {
    if (bucket.answered >= 100 && bucket.delivery_rate < 0.5) {
      problems.push(
        `Solo el ${pct(bucket.delivery_rate)} de las respuestas \`${status}\` ` +
          `terminó guardada en profiles — el que pregunta no las está recibiendo.`
      );
    }
  }

  return problems;
}

export async function runQualityCheck(opts: {
  windowDays?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
} = {}): Promise<QualityVerdict> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const report = await scoreRecentAnswers(opts.windowDays ?? 7);
  const problems = findProblems(report);

  log(`Calidad del finder — ${report.sampled} respuestas de los últimos ${report.window_days} días`);
  for (const [status, b] of Object.entries(report.by_status)) {
    const agree = b.agreement_rate === null ? "—" : `${(b.agreement_rate * 100).toFixed(1)}%`;
    log(
      `  ${status.padEnd(10)} ${String(b.answered).padStart(6)} respuestas · ` +
        `acierto ${agree} (${b.comparable} comparables) · ` +
        `entregadas ${(b.delivery_rate * 100).toFixed(1)}%`
    );
  }
  if (report.latency.p50_ms !== null) {
    log(`  latencia p50 ${Math.round(report.latency.p50_ms / 1000)}s · p90 ${Math.round((report.latency.p90_ms || 0) / 1000)}s`);
  }

  if (problems.length === 0) {
    log("Sin problemas — silencio.");
    return { report, problems, alertFailed: false, notified: false };
  }

  for (const p of problems) log(`  ⚠️  ${p}`);

  if (opts.dryRun) return { report, problems, alertFailed: false, notified: false };
  if (!isSlackConfigured()) {
    log("Slack no configurado — sin alerta.");
    return { report, problems, alertFailed: false, notified: false };
  }

  const sent = await postSlackMessage(
    `Calidad del email finder: ${problems.length} problema(s)`,
    [
      {
        type: "header",
        text: { type: "plain_text", text: "Email finder · calidad", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: problems.map((p) => `• ${p}`).join("\n") },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Muestra: ${report.sampled} respuestas de ${report.window_days} días · \`GET /stats\` tiene el desglose`,
          },
        ],
      },
    ]
  );

  log(sent.ok ? "Alerta de calidad enviada a Slack." : `Slack falló: ${sent.error}`);
  return { report, problems, alertFailed: !sent.ok, notified: sent.ok };
}
