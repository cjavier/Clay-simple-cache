import prisma from "../db/prisma";
import { KnownPattern } from "./permutator";

/**
 * Record (or reinforce) that `pattern` was observed for `domain`.
 *
 * This used to be a find-then-create: under concurrent requests for the
 * same (domain, pattern) — e.g. two findEmail() calls for the same company
 * racing, or the parallel SERP-pattern writes in pipeline.ts — both calls
 * could see "no existing row" and both try to create(), and the loser would
 * throw a P2002 unique constraint violation.
 *
 * A single atomic INSERT ... ON CONFLICT DO UPDATE (Postgres upsert) closes
 * that race: exactly one row ever exists per (domain, pattern), and the
 * increment/confidence-clamp happens server-side in the same statement, so
 * concurrent writers correctly compound onto each other instead of racing.
 *
 * The id comes from Postgres' gen_random_uuid(), not from crypto.randomUUID():
 * $executeRaw binds a JS string as `text`, and Postgres will not implicitly
 * cast text to uuid in an INSERT value position, so passing it from Node made
 * every call fail with 42804 ("column id is of type uuid but expression is of
 * type text"). Because pipeline.ts awaits these writes outside a try/catch,
 * that turned every search where SERP detected a pattern into a 500 with no
 * search_log row written.
 */
export async function saveDomainPattern(
  domain: string,
  pattern: string
): Promise<void> {
  // Learning is a side effect of a search, never the point of it. pipeline.ts
  // awaits these writes on the hot path, so letting one throw would fail a
  // search that had already found its answer. Swallow and log, like logSearch.
  try {
    await saveDomainPatternOrThrow(domain, pattern);
  } catch (e) {
    console.error(`saveDomainPattern(${domain}, ${pattern}) failed:`, e);
  }
}

async function saveDomainPatternOrThrow(
  domain: string,
  pattern: string
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO domain_patterns (id, domain, pattern, confidence, sample_count, last_confirmed)
    VALUES (gen_random_uuid(), ${domain}, ${pattern}, 1.0, 1, now())
    ON CONFLICT (domain, pattern)
    DO UPDATE SET
      sample_count = domain_patterns.sample_count + 1,
      confidence = LEAST(1.0, domain_patterns.confidence + 0.1),
      last_confirmed = now()
  `;
}

export async function getDomainPatterns(
  domain: string
): Promise<KnownPattern[]> {
  const patterns = await prisma.domainPattern.findMany({
    where: { domain },
    orderBy: [{ confidence: "desc" }, { sample_count: "desc" }],
  });

  return patterns.map((p) => ({
    pattern: p.pattern,
    confidence: p.confidence,
    sample_count: p.sample_count,
  }));
}
