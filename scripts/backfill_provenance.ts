/**
 * Backfill email provenance (who found / who verified) from the legacy tables
 * and push it to MailBridge's POST /email-evidence.
 *
 *   # 1. Build history from search_log + verification_cache (dry run by default)
 *   npx ts-node scripts/backfill_provenance.ts build [--since=2026-01-01] [--commit]
 *   # 2. Push the backfilled rows to MailBridge, 500 per call, rate limited
 *   npx ts-node scripts/backfill_provenance.ts push [--rate=1] [--max-batches=10] [--commit]
 *
 * Both steps are re-runnable. Without --commit nothing is written and nothing
 * is sent. `push` needs MAILBRIDGE_API_KEY (and MAILBRIDGE_API_URL if it is not
 * the production API). Mapping and exclusions: src/services/provenance-backfill.ts.
 */
import dotenv from "dotenv";
dotenv.config();
import prisma from "../src/db/prisma";
import { buildHistory, pushHistory } from "../src/services/provenance-backfill";
import { evidencePushConfigured } from "../src/services/evidence-push.service";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

async function main() {
  const cmd = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (cmd === "build") {
    const since = arg("since") ? new Date(arg("since") as string) : undefined;
    if (since && Number.isNaN(since.getTime())) throw new Error("--since must be a date, e.g. 2026-01-01");
    const r = await buildHistory({ commit, since });
    console.log(commit ? `inserted ${r.inserted}` : `${r.candidates} candidates (dry run: pass --commit to write)`);
  } else if (cmd === "push") {
    if (commit && !evidencePushConfigured()) throw new Error("MAILBRIDGE_API_KEY is not set");
    const r = await pushHistory({
      commit,
      rate: arg("rate") ? Number(arg("rate")) : 1,
      maxBatches: arg("max-batches") ? Number(arg("max-batches")) : undefined,
    });
    console.log(commit ? `pushed ${r.sent} rows in ${r.batches} batches (${r.rejected} rejected by MailBridge)` : "dry run: pass --commit to send");
  } else {
    throw new Error("usage: backfill_provenance.ts <build|push> [--commit] [--since=DATE] [--rate=N] [--max-batches=N]");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
