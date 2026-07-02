import { randomUUID } from "crypto";
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
 */
export async function saveDomainPattern(
  domain: string,
  pattern: string
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO domain_patterns (id, domain, pattern, confidence, sample_count, last_confirmed)
    VALUES (${randomUUID()}, ${domain}, ${pattern}, 1.0, 1, now())
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
