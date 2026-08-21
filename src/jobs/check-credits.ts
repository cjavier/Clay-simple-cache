/**
 * Daily credit check for every paid API this service depends on.
 *
 * Reads each provider's balance, classifies it green / yellow / red against
 * measured burn rate, writes the result to `provider_credits`, and posts to
 * Slack when something is wrong or has just changed.
 *
 * This is the manual entrypoint. The scheduled daily run lives in
 * ./credit-check-schedule.ts inside the API process; both call the same
 * runCreditCheck() so a manual check and a scheduled one can't drift.
 *
 * Usage:
 *   npm run check:credits              # check, persist, alert if needed
 *   npm run check:credits -- --dry-run # check only, no DB write, no Slack
 *   npm run check:credits -- --force   # alert even if everything is green
 *   node dist/jobs/check-credits.js    # compiled
 *
 * Exit code reflects whether THIS RUN worked, not what it found. A red provider
 * is a successful detection — Slack is the channel for that. Non-zero is
 * reserved for the run genuinely failing: an unhandled error, or an alert that
 * had to be delivered and wasn't.
 */
import "dotenv/config";
import prisma from "../db/prisma";
import { runCreditCheck } from "./run-credit-check";

runCreditCheck({
  dryRun: process.argv.includes("--dry-run"),
  force: process.argv.includes("--force"),
})
  .then(({ alertFailed }) => {
    process.exitCode = alertFailed ? 1 : 0;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
