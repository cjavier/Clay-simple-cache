/**
 * Backfill `domain_patterns` from the verified emails we already own.
 *
 * The `profiles` table holds ~149k emails that were found and validated
 * elsewhere (Clay's waterfall, other providers) and then upserted here. Each
 * row where the local-part can be re-derived from the person's own name is
 * direct evidence of that domain's mailbox convention — evidence we were
 * paying SERP and verification APIs to rediscover on every single search.
 *
 * Before this ran, 7,885 domains had a learned pattern. The mineable evidence
 * covers ~42.7k domains, and feeding it to the permutator's ranking moved
 * top-1 accuracy from 40.9% to 57.0% on a 36,000-email holdout of addresses
 * other providers found and our own /find returned `unknown` for.
 *
 * Rows whose name and email don't correspond yield no pattern and are simply
 * skipped, so mismatched records can't poison the table.
 *
 * Mining is now slug-aware. Asked to explain `rlozano@ctscorp.com` from
 * `{first:"Roberto", last:"Martinez"}` the old version returned null and the
 * domain learned nothing — and that shape is the common case, not the edge
 * case: the stored `last_name` is the maternal surname in 74.9% of profiles
 * with two surnames, while 57.2% of addresses use the paternal one. Reading the
 * surnames out of `linkedin_slug` as well lifts the share of rows that yield a
 * usable pattern from 60.6% to 77.6%, and the domains covered from 45,415 to
 * 51,905.
 *
 * Usage:
 *   npx ts-node scripts/backfill_domain_patterns.ts            # dry run
 *   npx ts-node scripts/backfill_domain_patterns.ts --commit   # write
 *
 * Idempotent: re-running recomputes the same evidence and upserts it.
 */
import prisma from "../src/db/prisma";
import {
  identifyPatternForSurnames,
  normalizeNameKeepingSpaces,
} from "../src/email-finder/permutator";
import { namePartsFromSlug } from "../src/email-finder/identity";

const COMMIT = process.argv.includes("--commit");
const PAGE = 5000;

type Evidence = Map<string, Map<string, number>>; // domain -> pattern -> count

async function mineEvidence(): Promise<{
  evidence: Evidence;
  scanned: number;
  derived: number;
}> {
  const evidence: Evidence = new Map();
  let scanned = 0;
  let derived = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.profile.findMany({
      where: { email: { not: null } },
      select: { id: true, email: true, data: true, linkedin_slug: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      scanned++;
      const email = (row.email || "").toLowerCase();
      const domain = email.split("@")[1];
      if (!domain) continue;

      const data = (row.data ?? {}) as Record<string, unknown>;
      const storedFirst = normalizeNameKeepingSpaces(String(data.first_name ?? ""));
      const storedLast = normalizeNameKeepingSpaces(String(data.last_name ?? ""));

      // The slug carries the whole name: "roberto-lozano-martinez-011251131".
      // Token 0 is the given name; everything after it is a surname candidate,
      // paternal first, plus the two concatenated.
      const slugTokens = row.linkedin_slug ? namePartsFromSlug(row.linkedin_slug) : [];
      const first = storedFirst || slugTokens[0] || "";
      if (!first) continue;

      const surnames: string[] = [];
      const pushUnique = (v: string) => {
        if (v && !surnames.includes(v)) surnames.push(v);
      };
      if (slugTokens.length >= 2) {
        const tail = slugTokens.slice(1);
        pushUnique(tail[0]);
        if (tail.length >= 2) {
          pushUnique(tail.join(""));
          pushUnique(tail[tail.length - 1]);
          // 4+ tokens means a middle name, so the paternal surname is the
          // second-to-last token rather than the second.
          pushUnique(slugTokens[slugTokens.length - 2]);
        }
      }
      pushUnique(storedLast);
      if (surnames.length === 0) continue;

      // Only self-consistent rows count as evidence: if the local-part can't be
      // rebuilt from this person's own name under ANY of their surnames, the row
      // tells us nothing about the domain's convention.
      const pattern = identifyPatternForSurnames(email, first, surnames);
      if (!pattern) continue;

      derived++;
      if (!evidence.has(domain)) evidence.set(domain, new Map());
      const perDomain = evidence.get(domain)!;
      perDomain.set(pattern, (perDomain.get(pattern) || 0) + 1);
    }

    process.stdout.write(`\r  scanned ${scanned}  derived ${derived}`);
  }
  process.stdout.write("\n");

  return { evidence, scanned, derived };
}

/**
 * Confidence reflects how unanimous the evidence is, so `prioritizePermutations`
 * can tell "12 of 12 mailboxes use first.last" from "3 of 7 do". The old writer
 * stamped every pattern 1.0, which made confidence useless as a ranking signal.
 */
/**
 * Single-quote a literal for the batched INSERT.
 *
 * Domains and pattern names are both drawn from a closed alphabet — the
 * pattern from a fixed table, the domain from the right-hand side of an
 * address — but a value from the database still gets escaped rather than
 * trusted, since $executeRawUnsafe does no binding of its own.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function confidenceFor(count: number, total: number): number {
  const share = count / total;
  const volume = Math.min(1, count / 5); // 5+ samples = fully trusted
  return Math.round(Math.max(0.3, share * (0.6 + 0.4 * volume)) * 100) / 100;
}

async function main() {
  console.log(
    `Backfilling domain_patterns from profiles (${COMMIT ? "COMMIT" : "DRY RUN"})\n`
  );

  const before = await prisma.domainPattern.groupBy({ by: ["domain"] });
  const { evidence, scanned, derived } = await mineEvidence();

  let upserts = 0;
  let newDomains = 0;
  const knownDomains = new Set(before.map((d) => d.domain));
  const writes: { domain: string; pattern: string; conf: number; n: number }[] = [];

  for (const [domain, perDomain] of evidence) {
    const total = [...perDomain.values()].reduce((a, b) => a + b, 0);
    if (!knownDomains.has(domain)) newDomains++;
    for (const [pattern, count] of perDomain) {
      writes.push({ domain, pattern, conf: confidenceFor(count, total), n: count });
      upserts++;
    }
  }

  console.log(`\nprofiles scanned          ${scanned}`);
  console.log(`patterns derived          ${derived}`);
  console.log(`domains with evidence     ${evidence.size}`);
  console.log(`domains with a pattern    ${knownDomains.size} -> ${knownDomains.size + newDomains}`);
  console.log(`rows to upsert            ${upserts}`);

  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    console.log("\nSample of what would be written:");
    for (const w of writes.slice(0, 10)) {
      console.log(`  ${w.domain.padEnd(34)} ${w.pattern.padEnd(12)} conf ${w.conf}  n=${w.n}`);
    }
    return;
  }

  // Written in batches rather than one statement per row: the evidence covers
  // 52,748 domains, and a round trip each would turn a two-minute job into half
  // an hour of mostly network latency.
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);
    const values = chunk
      .map(
        (w) =>
          `(gen_random_uuid(), ${quote(w.domain)}, ${quote(w.pattern)}, ${w.conf}, ${w.n}, now())`
      )
      .join(",");

    // Mirrors saveDomainPattern's atomic upsert, but sets an absolute
    // sample_count/confidence from the mined evidence instead of incrementing:
    // a backfill re-run must converge, not inflate counts.
    await prisma.$executeRawUnsafe(`
      INSERT INTO domain_patterns (id, domain, pattern, confidence, sample_count, last_confirmed)
      VALUES ${values}
      ON CONFLICT (domain, pattern)
      DO UPDATE SET
        sample_count = GREATEST(domain_patterns.sample_count, EXCLUDED.sample_count),
        confidence   = GREATEST(domain_patterns.confidence, EXCLUDED.confidence),
        last_confirmed = now()
    `);
    done += chunk.length;
    process.stdout.write(`\r  written ${done}/${upserts}`);
  }
  process.stdout.write(`\r  written ${done}/${upserts}\n`);

  const after = await prisma.domainPattern.groupBy({ by: ["domain"] });
  console.log(`\nDone. domain_patterns now covers ${after.length} domains.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
