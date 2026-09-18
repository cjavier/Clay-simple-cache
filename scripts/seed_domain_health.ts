/**
 * Seed `domain_health` from the searches we already ran.
 *
 * The circuit breaker in `domain-health.ts` learns from live traffic, which
 * means the domains we already know are hopeless get a fresh ten searches to
 * prove it again — banorte.com.mx alone would burn another ~$0.20 relearning
 * what 549 searches already established. `search_log` has the answer; this
 * copies it over.
 *
 * Two deliberate conservatisms:
 *
 *  - **Only the healthy window counts.** From 9 May to 20 Aug 2026 both
 *    verification providers were dead and every one of 117,696 searches came
 *    back `unknown`. Seeding from all of history would mute essentially the
 *    entire internet. Evidence starts on 21 Aug, when results resumed.
 *  - **A much higher bar than the live breaker's.** The breaker mutes after 10
 *    fruitless searches; this seeds a mute only at 25+, because the old
 *    pipeline asked with the wrong surname and a 5-search miss says more about
 *    the old candidate list than about the domain. At 25+ with zero hits the
 *    domain is refusing to answer, not being asked badly.
 *
 * Usage:
 *   npx ts-node scripts/seed_domain_health.ts            # dry run
 *   npx ts-node scripts/seed_domain_health.ts --commit   # write
 *
 * Idempotent: re-running recomputes the same evidence and overwrites.
 */
import prisma from "../src/db/prisma";
import { config } from "../src/email-finder/config";

const COMMIT = process.argv.includes("--commit");

/** When the providers came back to life. Evidence before this is meaningless. */
const EVIDENCE_SINCE = new Date("2026-08-21T00:00:00Z");

/** Fruitless searches needed to seed a mute. Higher than the live breaker's. */
const SEED_MUTE_AFTER = Number(process.env.SEED_MUTE_AFTER || 25);

interface DomainRow {
  domain: string;
  searches: number;
  hits: number;
  last_hit_at: Date | null;
}

async function main() {
  console.log(
    `Seeding domain_health from search_log since ${EVIDENCE_SINCE.toISOString().slice(0, 10)} ` +
      `(${COMMIT ? "COMMIT" : "DRY RUN"})\n`
  );

  const rows = await prisma.$queryRaw<DomainRow[]>`
    SELECT domain,
           count(*)::int AS searches,
           count(*) FILTER (WHERE result_status IN ('valid', 'catch_all'))::int AS hits,
           max(created_at) FILTER (WHERE result_status IN ('valid', 'catch_all')) AS last_hit_at
    FROM search_log
    WHERE domain IS NOT NULL
      AND created_at >= ${EVIDENCE_SINCE}
    GROUP BY domain
  `;

  const muteUntil = new Date(
    Date.now() + config.domain_mute_days * 24 * 60 * 60 * 1000
  );
  const toMute = rows.filter((r) => r.hits === 0 && r.searches >= SEED_MUTE_AFTER);
  const wastedSearches = toMute.reduce((a, r) => a + r.searches, 0);

  console.log(`domains with traffic        ${rows.length}`);
  console.log(`domains to mute             ${toMute.length}`);
  console.log(`searches they absorbed      ${wastedSearches}`);
  console.log(`mute expires                ${muteUntil.toISOString().slice(0, 10)}\n`);

  console.log("Worst offenders:");
  for (const r of [...toMute].sort((a, b) => b.searches - a.searches).slice(0, 12)) {
    console.log(`  ${r.domain.padEnd(34)} ${String(r.searches).padStart(5)} searches, 0 results`);
  }

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    return;
  }

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((r) => {
        const mute =
          r.hits === 0 && r.searches >= SEED_MUTE_AFTER
            ? `'${muteUntil.toISOString()}'::timestamptz`
            : "NULL";
        const lastHit = r.last_hit_at
          ? `'${new Date(r.last_hit_at).toISOString()}'::timestamptz`
          : "NULL";
        return `(${quote(r.domain)}, ${r.searches}, ${r.hits}, ${lastHit}, ${mute}, now())`;
      })
      .join(",");

    await prisma.$executeRawUnsafe(`
      INSERT INTO domain_health (domain, searches, hits, last_hit_at, muted_until, updated_at)
      VALUES ${values}
      ON CONFLICT (domain) DO UPDATE SET
        searches    = GREATEST(domain_health.searches, EXCLUDED.searches),
        hits        = GREATEST(domain_health.hits, EXCLUDED.hits),
        last_hit_at = COALESCE(domain_health.last_hit_at, EXCLUDED.last_hit_at),
        muted_until = EXCLUDED.muted_until,
        updated_at  = now()
    `);
    done += chunk.length;
    process.stdout.write(`\r  written ${done}/${rows.length}`);
  }
  process.stdout.write(`\r  written ${done}/${rows.length}\n`);

  const muted = await prisma.domainHealth.count({
    where: { muted_until: { gt: new Date() } },
  });
  console.log(`\nDone. ${muted} domains are muted.`);
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
