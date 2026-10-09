/**
 * Load MailBridge outcome history into `email_outcomes` from a JSONL file.
 *
 * The `email_outcomes` webhook only carries what changes from the day it is
 * switched on. The history before that — including Instantly's bounces, which
 * MailBridge never wrote to its own bounce columns — comes in once through
 * here. One JSON object per line, in the OutcomeRowInput shape
 * (src/email-finder/outcomes.ts).
 *
 * Usage:
 *   npx ts-node scripts/import_outcomes.ts outcomes.jsonl            # dry run
 *   npx ts-node scripts/import_outcomes.ts outcomes.jsonl --commit   # write
 *
 * Idempotent: rows upsert on (source, source_ref).
 */
import { readFileSync } from "node:fs";
import prisma from "../src/db/prisma";
import { ingestOutcomes, OutcomeRowInput } from "../src/email-finder/outcomes";

async function main() {
  const file = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!file) throw new Error("usage: import_outcomes.ts <file.jsonl> [--commit]");

  const rows: OutcomeRowInput[] = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const bounced = rows.filter((r) => r.bounced_at && (r.bounce_type || "hard") !== "soft").length;
  const replied = rows.filter((r) => r.replied_at || r.positive_at || r.auto_replied).length;
  const visible = rows.filter((r) => r.first_visible_send_at).length;
  console.log(`${rows.length} rows · ${bounced} hard bounces · ${replied} replies · ${visible} visible sends`);
  if (!commit) {
    console.log("dry run — pass --commit to write");
    return;
  }

  const CHUNK = 5000;
  let upserted = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await ingestOutcomes(rows.slice(i, i + CHUNK));
    upserted += r.upserted;
    skipped += r.skipped;
    console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`upserted ${upserted}, skipped ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
