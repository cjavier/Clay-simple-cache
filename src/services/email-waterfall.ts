/**
 * The email waterfall every people table gets in MailBridge: Prospeo →
 * Findymail → Clay function "Get Email (External)" (its own cascade of
 * Icypeas, Kitt, LeadMagic… validated by Debounce). Rows that already carry
 * an email (Blitz) are skipped by the run condition.
 *
 * It never runs by itself: MailBridge columns only run when someone asks
 * (and new columns are capped to a 3-row sandbox until verified), because
 * every step costs credits. The winning provider is stored as the cell's
 * provider — for the Clay step, the provider inside the function that found
 * it — so every email keeps its source.
 */

export const EMAIL_WATERFALL_KEY = "email_cascada";

/** Custom-function routines need the `function:` prefix in Clay's public API. */
export function clayEmailRoutineId(): string {
  return process.env.CLAY_EMAIL_ROUTINE_ID || "function:t_0tmngkoVgNYaHjSNmeY";
}

export function emailWaterfallColumn(routineId = clayEmailRoutineId()) {
  return {
    key: EMAIL_WATERFALL_KEY,
    label: "Email (cascada)",
    kind: "enrichment",
    dataType: "email",
    // After the columns the rows bring, wherever they land.
    position: 1000,
    config: {
      inputs: {
        first_name: "{{first_name}}",
        last_name: "{{last_name}}",
        full_name: "{{full_name}}",
        company_domain: "{{domain}}",
        company_name: "{{company}}",
        linkedin_url: "{{linkedin_profile}}",
        // The Clay function's own input names.
        "First name": "{{first_name}}",
        "Last name": "{{last_name}}",
        "Full Name": "{{full_name}}",
        "Company Domain": "{{domain}}",
        "Company Name": "{{company}}",
      },
      providers: [
        { id: "prospeo", op: "find_email" },
        { id: "findymail", op: "find_email" },
        { id: "clay", op: "routine", routineId, timeoutMs: 30_000 },
      ],
    },
    // Only rows without an email (people rows never carry an empty one).
    runCondition: [{ filters: [{ columnKey: "email", operator: "empty" }] }],
  };
}
