import prisma from "../db/prisma";
import { config } from "./config";

/**
 * Stop asking domains that never answer.
 *
 * 6,889 domains absorbed 14,786 searches and $135.02 in four weeks without ever
 * returning a single `valid` or `catch_all`: banorte.com.mx (549 searches, 0
 * results), bbva.mx (541, 0), alicorp.com.pe (406, 0). They are large
 * organizations behind anti-spam gateways that refuse SMTP probes outright, so
 * every candidate comes back undecided and the search burns its whole budget to
 * learn nothing.
 *
 * After `DOMAIN_MUTE_AFTER` fruitless searches in a row the domain is muted for
 * `DOMAIN_MUTE_DAYS` and answers `unknown` immediately at zero cost. The mute
 * expires rather than being permanent, so a company that migrates its mail is
 * re-tested instead of blacklisted; and any hit clears the counter at once.
 */

export interface DomainVerdict {
  muted: boolean;
  searches: number;
  hits: number;
}

export async function checkDomainHealth(domain: string): Promise<DomainVerdict> {
  try {
    const row = await prisma.domainHealth.findUnique({ where: { domain } });
    if (!row) return { muted: false, searches: 0, hits: 0 };
    const muted = !!row.muted_until && row.muted_until > new Date();
    return { muted, searches: row.searches, hits: row.hits };
  } catch {
    return { muted: false, searches: 0, hits: 0 };
  }
}

/**
 * Record the outcome of one search.
 *
 * A hit resets the fruitless streak (and lifts any mute). A miss increments it,
 * and trips the breaker once the streak reaches the threshold. The counters are
 * updated in a single statement so concurrent searches on the same domain
 * compound instead of racing.
 */
export async function recordDomainOutcome(
  domain: string,
  hit: boolean
): Promise<void> {
  const muteMs = config.domain_mute_days * 24 * 60 * 60 * 1000;
  try {
    if (hit) {
      await prisma.$executeRaw`
        INSERT INTO domain_health (domain, searches, hits, last_hit_at, muted_until, updated_at)
        VALUES (${domain}, 1, 1, now(), NULL, now())
        ON CONFLICT (domain) DO UPDATE SET
          searches = domain_health.searches + 1,
          hits = domain_health.hits + 1,
          last_hit_at = now(),
          muted_until = NULL,
          updated_at = now()
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO domain_health (domain, searches, hits, muted_until, updated_at)
        VALUES (${domain}, 1, 0, NULL, now())
        ON CONFLICT (domain) DO UPDATE SET
          searches = domain_health.searches + 1,
          muted_until = CASE
            WHEN domain_health.hits = 0
             AND domain_health.searches + 1 >= ${config.domain_mute_after}
            THEN now() + (${muteMs}::bigint * interval '1 millisecond')
            ELSE domain_health.muted_until
          END,
          updated_at = now()
      `;
    }
  } catch {
    // Bookkeeping must never fail a search.
  }
}
