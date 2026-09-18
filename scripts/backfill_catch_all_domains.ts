/**
 * Backfill `domain_intel.is_catch_all` from what the verifiers already told us.
 *
 * `analyzeDomain()` wrote the literal `false` into that column on every upsert,
 * in both branches, so all 63,293 rows said false and the flag could never
 * become true. That is fixed going forward, but the knowledge it should have
 * been accumulating is not lost — it is in `search_log`, which records 15,266
 * `catch_all` verdicts across 6,073 distinct domains. Every one of those is a
 * provider telling us the server accepts any local part.
 *
 * Without this, each of those domains has to be rediscovered the expensive way:
 * a fresh search spends candidates probing a mailbox that answers "yes" to
 * everything, learns nothing from the answers, and only then falls back to the
 * pattern. With it, the search goes straight to the pattern at zero probe cost.
 *
 * Domains with no `domain_intel` row yet get one with `expires_at` in the past:
 * `analyzeDomain()` treats that as stale and re-reads MX on the next search,
 * but it reads `is_catch_all` off the stale row regardless, so the flag
 * survives the refresh instead of being a guess about DNS.
 *
 * Usage:
 *   npx ts-node scripts/backfill_catch_all_domains.ts            # dry run
 *   npx ts-node scripts/backfill_catch_all_domains.ts --commit   # write
 */
import prisma from "../src/db/prisma";

const COMMIT = process.argv.includes("--commit");

/**
 * Catch-all verdicts needed before we believe it.
 *
 * One verdict is already a provider's answer, not a guess, but two costs
 * nothing extra to require and rules out a single transient misread on a
 * domain we will then stop probing for 7 days at a time.
 */
const MIN_VERDICTS = Number(process.env.CATCH_ALL_MIN_VERDICTS || 2);

interface Row {
  domain: string;
  catch_alls: number;
  valids: number;
}

async function main() {
  console.log(
    `Backfilling domain_intel.is_catch_all from search_log (${COMMIT ? "COMMIT" : "DRY RUN"})\n`
  );

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT domain,
           count(*) FILTER (WHERE result_status = 'catch_all')::int AS catch_alls,
           count(*) FILTER (WHERE result_status = 'valid')::int AS valids
    FROM search_log
    WHERE domain IS NOT NULL
    GROUP BY domain
    HAVING count(*) FILTER (WHERE result_status = 'catch_all') > 0
  `;

  const confident = rows.filter((r) => r.catch_alls >= MIN_VERDICTS);
  const withValids = confident.filter((r) => r.valids > 0);

  console.log(`domains with any catch_all verdict   ${rows.length}`);
  console.log(`domains with >= ${MIN_VERDICTS} verdicts              ${confident.length}`);
  console.log(`  of those, also seen 'valid'        ${withValids.length}`);
  console.log(`  (expected: on a catch-all server every probe says yes,`);
  console.log(`   so a 'valid' there was never a confirmation)\n`);

  const before = await prisma.domainIntel.count({ where: { is_catch_all: true } });
  console.log(`is_catch_all = true, before           ${before}`);

  if (!COMMIT) {
    console.log("\nSample:");
    for (const r of [...confident].sort((a, b) => b.catch_alls - a.catch_alls).slice(0, 10)) {
      console.log(`  ${r.domain.padEnd(34)} ${String(r.catch_alls).padStart(4)} catch_all, ${r.valids} valid`);
    }
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    return;
  }

  // A row far in the past for expires_at: analyzeDomain() re-reads MX on the
  // next search (it is stale) but carries is_catch_all forward off this row.
  const stale = new Date(0).toISOString();

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < confident.length; i += CHUNK) {
    const chunk = confident.slice(i, i + CHUNK);
    const values = chunk
      .map(
        (r) =>
          `(gen_random_uuid(), ${quote(r.domain)}, false, '[]'::jsonb, 'other', true, false, false, now(), '${stale}'::timestamptz)`
      )
      .join(",");

    await prisma.$executeRawUnsafe(`
      INSERT INTO domain_intel
        (id, domain, has_mx, mx_records, provider, is_catch_all, is_disposable, is_free_provider, checked_at, expires_at)
      VALUES ${values}
      ON CONFLICT (domain) DO UPDATE SET is_catch_all = true
    `);
    done += chunk.length;
    process.stdout.write(`\r  written ${done}/${confident.length}`);
  }
  process.stdout.write(`\r  written ${done}/${confident.length}\n`);

  const after = await prisma.domainIntel.count({ where: { is_catch_all: true } });
  console.log(`\nDone. is_catch_all = true, after      ${after}`);
}

/** Single-quote a literal for the batched INSERT (no binding in RawUnsafe). */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
