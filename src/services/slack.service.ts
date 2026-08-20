import { CreditCheck, CreditReport, CreditStatus } from "./credit-monitor.service";

/**
 * Slack notifier for the credit monitor. Deliberately dependency-free — one
 * fetch against chat.postMessage — so the daily job doesn't drag in an SDK.
 */

const SLACK_API = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 15_000;

const EMOJI: Record<CreditStatus, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

const WORD: Record<CreditStatus, string> = {
  green: "OK",
  yellow: "BAJO",
  red: "AGOTADO",
};

export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_TOKEN && process.env.SLACK_ALERT_CHANNEL);
}

function fmtBalance(c: CreditCheck): string {
  if (c.balance === null) return "—";
  if (c.unit === "usd") {
    return `$${c.balance.toFixed(2)} USD`;
  }
  return `${c.balance.toLocaleString("en-US")} créditos`;
}

function fmtRunway(c: CreditCheck): string {
  if (c.days_left === null) return "";
  if (c.days_left === 0) return " · sin margen";
  if (c.days_left < 1) return ` · <1 día de margen`;
  return ` · ~${Math.round(c.days_left)} días de margen`;
}

/**
 * One line per provider. Kept as plain text inside a section rather than a
 * table: Slack has no table primitive, and fields/columns wrap badly on mobile.
 */
function providerLines(checks: CreditCheck[]): string {
  const order: Record<CreditStatus, number> = { red: 0, yellow: 1, green: 2 };
  return [...checks]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((c) => {
      const head = `${EMOJI[c.status]}  *${c.label}* — ${WORD[c.status]}`;
      const detail = c.error
        ? `\`${c.error}\``
        : `${fmtBalance(c)}${fmtRunway(c)}`;
      return `${head}\n     ${detail}\n     _${c.impact}_`;
    })
    .join("\n\n");
}

function headline(report: CreditReport, changes: string[]): string {
  const reds = report.checks.filter((c) => c.status === "red").length;
  const yellows = report.checks.filter((c) => c.status === "yellow").length;

  if (reds > 0) {
    return `🔴 ${reds} proveedor${reds > 1 ? "es" : ""} sin saldo${
      yellows > 0 ? ` · ${yellows} bajo${yellows > 1 ? "s" : ""}` : ""
    }`;
  }
  if (yellows > 0) {
    return `🟡 ${yellows} proveedor${yellows > 1 ? "es" : ""} con saldo bajo`;
  }
  return changes.length > 0
    ? "🟢 Saldos restablecidos"
    : "🟢 Todos los proveedores con saldo";
}

export interface SlackAlertOptions {
  /** Human-readable status transitions since the previous run. */
  changes?: string[];
  channel?: string;
  token?: string;
}

export async function sendCreditAlert(
  report: CreditReport,
  opts: SlackAlertOptions = {}
): Promise<{ ok: boolean; error?: string; ts?: string }> {
  const token = opts.token ?? process.env.SLACK_TOKEN ?? "";
  const channel = opts.channel ?? process.env.SLACK_ALERT_CHANNEL ?? "";
  if (!token) return { ok: false, error: "SLACK_TOKEN no configurado" };
  if (!channel) return { ok: false, error: "SLACK_ALERT_CHANNEL no configurado" };

  const changes = opts.changes ?? [];
  const title = headline(report, changes);

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Saldos de APIs · Clay Cache", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: providerLines(report.checks) },
    },
  ];

  if (changes.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Cambios desde la última revisión*\n${changes
            .map((c) => `• ${c}`)
            .join("\n")}`,
        },
      }
    );
  }

  const burn =
    report.burn.searches > 0
      ? `Consumo medido: ${Math.round(
          report.burn.searches
        ).toLocaleString("en-US")} búsquedas/día · ${Math.round(
          report.burn.verifications
        ).toLocaleString("en-US")} verificaciones/día`
      : "Sin tráfico medido en los últimos 30 días";

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${burn}  |  ${report.checked_at.toLocaleString("es-MX", {
          timeZone: "America/Mexico_City",
          dateStyle: "medium",
          timeStyle: "short",
        })} (CDMX)`,
      },
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        // Fallback for notifications and screen readers, which don't read blocks.
        text: `${title} — Saldos de APIs Clay Cache`,
        blocks,
      }),
      signal: controller.signal,
    });
    const body: any = await res.json();
    if (!body.ok) return { ok: false, error: body.error || "error de Slack" };
    return { ok: true, ts: body.ts };
  } catch (e: any) {
    return { ok: false, error: e?.message || "error de red" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this run is worth a Slack message.
 *
 * Rule: anything not green always alerts, so a dead provider is reported every
 * day until it's fixed. An all-green run stays quiet *unless* something just
 * recovered — silence is the normal state, and a daily "all good" ping trains
 * people to ignore the channel.
 */
export function shouldNotify(
  report: CreditReport,
  previous: Map<string, CreditStatus>
): { notify: boolean; changes: string[] } {
  const changes: string[] = [];
  for (const c of report.checks) {
    const before = previous.get(c.provider);
    if (before && before !== c.status) {
      changes.push(
        `${c.label}: ${EMOJI[before]} ${WORD[before]} → ${EMOJI[c.status]} ${
          WORD[c.status]
        }`
      );
    }
  }
  const notify = report.worst !== "green" || changes.length > 0;
  return { notify, changes };
}
