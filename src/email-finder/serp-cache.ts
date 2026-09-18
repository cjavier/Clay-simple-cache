import prisma from "../db/prisma";
import { config } from "./config";

/**
 * Serper results, cached by domain.
 *
 * `searchSerpForEmails()` is a question about a *domain* ("what do addresses at
 * empresa.com look like?"), but it was being asked once per *person*: 192,986
 * searches over 53,426 distinct domains bought the same Google page 139,560
 * extra times, $139.56 of it. The answer barely changes month to month, so a
 * 30-day TTL is generous.
 */

export interface CachedSerp {
  emails: string[];
  patterns: { pattern: string; count: number; examples: string[] }[];
}

export async function getCachedSerp(domain: string): Promise<CachedSerp | null> {
  try {
    const row = await prisma.serpCache.findUnique({ where: { domain } });
    if (!row || row.expires_at <= new Date()) return null;
    return {
      emails: (row.emails as string[]) || [],
      patterns: (row.patterns as CachedSerp["patterns"]) || [],
    };
  } catch {
    return null;
  }
}

export async function cacheSerp(
  domain: string,
  emails: string[],
  patterns: CachedSerp["patterns"]
): Promise<void> {
  const expires_at = new Date(Date.now() + config.serp_cache_ttl * 1000);
  const payload = { emails, patterns, checked_at: new Date(), expires_at };
  try {
    await prisma.serpCache.upsert({
      where: { domain },
      update: payload,
      create: { domain, ...payload },
    });
  } catch {
    // Non-critical.
  }
}
