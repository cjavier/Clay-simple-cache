import { mailbridge } from "./mailbridge.client";

/**
 * The email columns every people table gets in MailBridge. Since MailBridge
 * spec 109 the paid search and verification live THERE, one visible column
 * per step (like Clay), with the cost of each provider recorded per client:
 *
 *   Cache (Clay)   clay_cache → POST /emails/lookup on this API (free)
 *   Prospeo        only if there is still no email
 *   Findymail      only if there is still no email
 *   Clay Function  Clay's "Get Email (External)" (CLAY_EMAIL_ROUTINE_ID,
 *                  default function:t_0tmngkoVgNYaHjSNmeY) — manual-only:
 *                  running the whole table skips it; run it by name
 *   Verificación   Findymail verify → DeBounce when Findymail has no credits;
 *                  reuses a cache verdict of ≤30 days; asks this API for the
 *                  server facts (POST /emails/facts)
 *   Email          acceptance policy (moderate by default) → Email, Email
 *                  Source, Email Status, Discard Reason
 *
 * MailBridge owns the definition (POST /tables/:id/columns/presets/email-cascade):
 * one definition, no copy here. Every email and verdict those columns produce
 * comes back to this cache (POST /emails/results). Columns never run by
 * themselves (each step costs credits, and new columns start as a 3-row sandbox).
 */

/** Custom-function routines need the `function:` prefix in Clay's public API. */
export function clayEmailRoutineId(): string {
  return process.env.CLAY_EMAIL_ROUTINE_ID || "function:t_0tmngkoVgNYaHjSNmeY";
}

/** What `tables.people.email_waterfall` reports: the columns MailBridge created or kept. */
export async function addEmailCascadeColumns(tableId: string): Promise<string> {
  const r = await mailbridge.addEmailCascadeColumns(tableId, { clayRoutineId: clayEmailRoutineId() });
  return `added: ${r.order.join(" → ")}`;
}
