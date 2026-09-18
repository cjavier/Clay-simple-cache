import prisma from "../db/prisma";
import { config } from "./config";
import { EmailStatus, VerificationMethod } from "./types";

interface CachedVerification {
  email: string;
  status: EmailStatus;
  confidence: number;
  method: VerificationMethod | null;
}

export async function getCachedVerification(
  email: string
): Promise<CachedVerification | null> {
  const cached = await prisma.verificationCache.findUnique({
    where: { email },
  });

  if (!cached || cached.expires_at <= new Date()) return null;

  return {
    email: cached.email,
    status: cached.status as EmailStatus,
    confidence: cached.confidence,
    method: cached.method as VerificationMethod | null,
  };
}

/**
 * Batch variant of getCachedVerification. Looks up all given emails in a
 * single query and returns only the non-expired ones, keyed by email —
 * same expiration semantics as getCachedVerification (expires_at <= now
 * is treated as a miss).
 */
export async function getCachedVerificationsBatch(
  emails: string[]
): Promise<Map<string, CachedVerification>> {
  const result = new Map<string, CachedVerification>();
  if (emails.length === 0) return result;

  const cached = await prisma.verificationCache.findMany({
    where: { email: { in: emails } },
  });

  const now = new Date();
  for (const row of cached) {
    if (row.expires_at <= now) continue;
    result.set(row.email, {
      email: row.email,
      status: row.status as EmailStatus,
      confidence: row.confidence,
      method: row.method as VerificationMethod | null,
    });
  }

  return result;
}

/**
 * How long a verdict stays trustworthy, by verdict.
 *
 * `invalid` is a property of the mailbox and barely changes, so it keeps the
 * full TTL. `unknown` usually means the probe was refused, not that the address
 * is bad — a short TTL stops a transient gateway hiccup from being remembered
 * as fact for a month, while still absorbing the repeat traffic that matters:
 * 20.1% of all searches are a repeat of the same person and domain.
 */
function ttlSecondsFor(status: string): number {
  if (status === EmailStatus.unknown) return 3 * 24 * 60 * 60; // 3 days
  return config.verification_cache_ttl;
}

export async function cacheVerification(
  email: string,
  status: string,
  confidence: number,
  method: string | null
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSecondsFor(status) * 1000);

  await prisma.verificationCache.upsert({
    where: { email },
    update: {
      status,
      confidence,
      method,
      verified_at: new Date(),
      expires_at: expiresAt,
    },
    create: {
      email,
      status,
      confidence,
      method,
      verified_at: new Date(),
      expires_at: expiresAt,
    },
  });
}

/**
 * Remember the verdicts a search ruled out, not just the one it kept.
 *
 * pipeline.ts only ever cached the address it returned, so `verification_cache`
 * held 13,194 rows after 2.9 million paid calls — every `invalid` we bought was
 * thrown away the moment it was read. The next search for the same person
 * (20.1% of all traffic) paid for the identical rejections again.
 *
 * Writes are fire-and-forget: a cache miss costs a call, a failed cache write
 * must not cost an answer.
 */
export async function cacheNegativeVerifications(
  results: { email: string; status: EmailStatus; confidence: number; method: string | null }[]
): Promise<void> {
  const worthKeeping = results.filter(
    (r) =>
      r.email &&
      (r.status === EmailStatus.invalid ||
        r.status === EmailStatus.unknown ||
        r.status === EmailStatus.no_mx ||
        r.status === EmailStatus.disposable ||
        r.status === EmailStatus.role_account)
  );
  if (worthKeeping.length === 0) return;

  await Promise.all(
    worthKeeping.map((r) =>
      cacheVerification(r.email, r.status, r.confidence, r.method).catch(() => undefined)
    )
  );
}
