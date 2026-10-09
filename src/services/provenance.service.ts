import prisma from "../db/prisma";
import { findEmail as pipelineFind, verifySingleEmail as pipelineVerify } from "../email-finder/pipeline";
import {
  deriveProvenance,
  isFreshFact,
  ProvenanceEntry,
  ProvenanceOrigin,
} from "../email-finder/provenance";
import { FindRequest, VerificationResult } from "../email-finder/types";
import { evidencePusher } from "./evidence-push.service";
import { randomUUID } from "crypto";

/**
 * Stores provenance history and hands it to the MailBridge push queue.
 *
 * `recordProvenance` writes the facts first (the durable outbox) and then
 * queues them; it never throws and callers never await it on the request path.
 */
export async function recordProvenance(entries: ProvenanceEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    await prisma.emailProvenance.createMany({
      data: entries.map((e) => ({
        id: e.id,
        email: e.email,
        finder: e.finder,
        verifier: e.verifier,
        verdict: e.verdict,
        raw_status: e.raw_status,
        confidence: e.confidence,
        method: e.method,
        origin: e.origin,
        checked_at: new Date(e.checked_at),
      })),
      skipDuplicates: true,
    });
  } catch (err: any) {
    // The table may not exist yet during a rolling deploy, or the DB may blink.
    // Provenance must never cost an answer; the response already carries it.
    console.error("[provenance] could not store history:", err?.message || err);
    return;
  }
  evidencePusher.enqueue(entries);
}

/** When the cache row we answered from was written (null when there is none). */
async function cachedAt(email: string): Promise<Date | null> {
  try {
    const row = await prisma.verificationCache.findUnique({ where: { email }, select: { verified_at: true } });
    return row?.verified_at ?? null;
  } catch {
    return null;
  }
}

/** The provider recorded when this address was ingested, for `known_email` answers. */
async function profileSource(email: string): Promise<string | null> {
  try {
    const row = await prisma.profile.findUnique({ where: { email }, select: { data: true } });
    const src = (row?.data as Record<string, unknown> | null)?.email_source;
    return typeof src === "string" ? src : null;
  } catch {
    return null;
  }
}

/**
 * Add finder / verifier / verdict / checked_at to a pipeline answer and, when
 * the answer is a new fact, record it and queue it for MailBridge.
 */
export async function withProvenance(
  op: "find" | "verify",
  result: VerificationResult,
  now: Date = new Date()
): Promise<VerificationResult> {
  const fresh = isFreshFact(result);
  let known: string | null = null;
  let cached: Date | null = null;
  if (result.email && !fresh) {
    [cached, known] = await Promise.all([
      cachedAt(result.email),
      result.method === "known_email" ? profileSource(result.email) : Promise.resolve(null),
    ]);
  }
  const p = deriveProvenance(result, { op, profileSource: known, cachedAt: cached, now });

  if (fresh && result.email) {
    const entry: ProvenanceEntry = {
      id: randomUUID(),
      email: result.email.trim().toLowerCase(),
      finder: p.finder,
      verifier: p.verifier,
      verdict: p.verdict,
      raw_status: p.raw_status,
      confidence: p.confidence,
      method: p.method,
      origin: op as ProvenanceOrigin,
      checked_at: p.checked_at,
    };
    void recordProvenance([entry]);
  }
  return { ...result, finder: p.finder, verifier: p.verifier, verdict: p.verdict, checked_at: p.checked_at };
}

export async function findEmail(request: FindRequest): Promise<VerificationResult> {
  return withProvenance("find", await pipelineFind(request));
}

export async function verifySingleEmail(email: string, maxTier: number = 2): Promise<VerificationResult> {
  return withProvenance("verify", await pipelineVerify(email, maxTier));
}
