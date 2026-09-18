import prisma from "../db/prisma";
import { config } from "./config";
import {
  EmailStatus,
  VerificationResult,
  VerificationMethod,
  FindRequest,
  EmailVerificationProvider,
  SerpInfo,
  CONCLUSIVE_STATUSES,
} from "./types";
import { analyzeDomain, markDomainCatchAll } from "./domain-intel";
import {
  normalizeName,
  generateCandidates,
  prioritizePermutations,
  identifyPattern,
  identifyPatternForSurnames,
  KnownPattern,
} from "./permutator";
import { resolveIdentity, ResolvedIdentity } from "./identity";
import {
  getCachedVerification,
  getCachedVerificationsBatch,
  cacheVerification,
  cacheNegativeVerifications,
} from "./cache";
import { saveDomainPattern, getDomainPatterns } from "./pattern-learner";
import {
  getKnownEmailsForDomain,
  matchPerson,
  KnownEmail,
} from "./known-emails";
import { getCachedSerp, cacheSerp } from "./serp-cache";
import { checkDomainHealth, recordDomainOutcome } from "./domain-health";
import { normalizeDomain } from "../services/normalization";
import { EmailListVerifyProvider } from "./providers/emaillistverify";
import { DebounceProvider } from "./providers/debounce";
import {
  searchSerpForEmails,
  identifyPatternsFromEmails,
} from "./providers/serper";

function makeResult(partial: Partial<VerificationResult>): VerificationResult {
  return {
    email: null,
    status: EmailStatus.unknown,
    confidence: 0,
    method: null,
    pattern: null,
    domain_info: null,
    serp_info: null,
    permutations_tried: 0,
    cost_usd: 0,
    duration_ms: 0,
    ...partial,
  };
}

// Tier configuration — only Tier 1 and Tier 2 for now
const TIERS: EmailVerificationProvider[][] = [
  [new EmailListVerifyProvider()],       // Tier 1
  [new DebounceProvider()],              // Tier 2
  // Tier 3 (NeverBounce) — not implemented yet
];

/**
 * Per-search budget for Tier 2 escalations.
 *
 * Tier 2 (DeBounce) caps concurrent calls per ACCOUNT. On a domain where Tier 1
 * can't conclude anything — a mailbox behind an anti-spam gateway answers
 * `antispam_system` for every permutation — all candidates escalated, and
 * between this process and the deployed service that saturated the account and
 * came back as HTTP 429. Throttled calls look exactly like undeliverable
 * addresses, so the fan-out was actively producing wrong answers.
 *
 * Escalating every candidate was never useful anyway: if Tier 1 can't see the
 * domain, asking Tier 2 about the 12th-most-likely spelling is noise. The budget
 * spends Tier 2 on the most likely candidates, which are first in the list.
 * Tier 1 coverage is untouched — every candidate is still checked there.
 */
interface TierBudget {
  remaining: number;
}

const TIER2_BUDGET_PER_SEARCH = Number(
  process.env.TIER2_BUDGET_PER_SEARCH || 2
);

/**
 * A wall-clock deadline carried through one search.
 *
 * Without it a search has no upper bound at all: Express sets no timeout, so the
 * process kept verifying candidates for a caller that had hung up 40 minutes
 * earlier. 86% of four weeks of spend went to searches that answered after two
 * minutes, and 70% of the answers that took over an hour were never used.
 */
class Deadline {
  readonly at: number;
  constructor(budgetMs: number) {
    this.at = Date.now() + budgetMs;
  }
  get expired(): boolean {
    return Date.now() >= this.at;
  }
  get remaining(): number {
    return Math.max(0, this.at - Date.now());
  }
}

async function apiCascade(
  email: string,
  maxTier: number,
  tier2Budget?: TierBudget
): Promise<VerificationResult> {
  let totalCost = 0;
  // "risky" is not conclusive: keep the first one as a fallback but keep
  // walking the cascade in case a later tier returns something conclusive.
  let riskyFallback: VerificationResult | null = null;

  for (let tierIdx = 0; tierIdx < TIERS.length; tierIdx++) {
    if (tierIdx + 1 > maxTier) break;

    // Tier index 1+ is an escalation and draws from the budget when one is set.
    if (tierIdx > 0 && tier2Budget) {
      if (tier2Budget.remaining <= 0) break;
      tier2Budget.remaining--;
    }

    for (const provider of TIERS[tierIdx]) {
      if (!provider.is_configured()) continue;

      const result = await provider.verify(email);
      totalCost += result.cost_usd;

      if (CONCLUSIVE_STATUSES.includes(result.status)) {
        return { ...result, cost_usd: totalCost };
      }

      // risky is not conclusive — remember it as a fallback and continue
      // to the next provider/tier instead of returning immediately.
      if (result.status === EmailStatus.risky && !riskyFallback) {
        riskyFallback = result;
      }
    }
  }

  if (riskyFallback) {
    return { ...riskyFallback, cost_usd: totalCost };
  }

  return makeResult({ email, cost_usd: totalCost });
}

/**
 * Run apiCascade on multiple emails in parallel batches for speed.
 * Returns results in the same order as input.
 */
async function apiCascadeParallel(
  emails: string[],
  maxTier: number,
  concurrency: number = 5,
  tier2Budget?: TierBudget
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = new Array(emails.length);

  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((email) => apiCascade(email, maxTier, tier2Budget))
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}

/**
 * Read the domain's mailbox convention out of addresses we already own.
 *
 * `profiles` holds 168,523 real addresses. Leave-one-out over that table — hide
 * one address, predict its pattern from the rest of its domain, compare —
 * lands on the right pattern 81.5% of the time, and 47.3% of recent searches
 * are on a domain with at least three known addresses. That is the single
 * cheapest signal available to this service, and it was never read: the
 * catch-all branch guessed instead, and got the address right 33.3% of the time.
 */
function inferPatternsFromKnownEmails(known: KnownEmail[]): KnownPattern[] {
  const tally = new Map<string, number>();

  for (const row of known) {
    const surnames = [
      ...(row.last ? [row.last] : []),
      ...row.slug_parts.slice(1),
      ...(row.slug_parts.length >= 3
        ? [row.slug_parts.slice(1).join("")]
        : []),
    ];
    const first = row.slug_parts[0] || row.first;
    if (!first || surnames.length === 0) continue;

    const pattern = identifyPatternForSurnames(row.email, first, surnames);
    if (pattern) tally.set(pattern, (tally.get(pattern) || 0) + 1);
  }

  return [...tally.entries()]
    .map(([pattern, sample_count]) => ({
      pattern,
      // Evidence from our own verified mail beats a pattern glimpsed once in a
      // search-engine snippet, but one sample is still one sample.
      confidence: Math.min(1, 0.6 + sample_count * 0.1),
      sample_count,
    }))
    .sort((a, b) => b.sample_count - a.sample_count);
}

/** Merge pattern evidence from several sources, strongest first. */
function mergePatterns(...sources: KnownPattern[][]): KnownPattern[] {
  const merged = new Map<string, KnownPattern>();
  for (const list of sources) {
    for (const p of list) {
      const existing = merged.get(p.pattern);
      if (!existing) {
        merged.set(p.pattern, { ...p });
      } else {
        existing.sample_count += p.sample_count;
        existing.confidence = Math.max(existing.confidence, p.confidence);
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.sample_count - a.sample_count || b.confidence - a.confidence
  );
}

/** The first candidate that spells the person's name under `pattern`. */
function candidateForPattern(
  candidates: string[],
  pattern: string,
  identity: ResolvedIdentity
): string | null {
  for (const email of candidates) {
    for (const surname of identity.surnames) {
      if (identifyPattern(email, identity.first, surname) === pattern) {
        return email;
      }
    }
  }
  return null;
}

export async function findEmail(request: FindRequest): Promise<VerificationResult> {
  const start = Date.now();
  const deadline = new Deadline(
    request.time_budget_ms || config.find_time_budget_ms
  );
  let totalCost = 0;
  let permutationsTried = 0;
  let apiCalls = 0;

  // ── 1. Normalize the domain ──
  // `/find` used to do nothing but trim+lowercase here, while the company
  // normalizer stripped protocol, www and path. That gap cost 355 searches and
  // $8.05 against the host "www.gob.pe", which has no mailboxes at all.
  const domain = normalizeDomain(request.domain || "");
  if (!domain) {
    return makeResult({
      status: EmailStatus.invalid,
      confidence: 1,
      method: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start,
    });
  }

  // ── 2. Work out whose name we are actually spelling ──
  const identity = resolveIdentity(request);
  const first = identity.first;
  const last = identity.given_last;
  const maxTier = Math.min(request.max_tier || 2, 2); // Cap at 2 (no Tier 3 yet)

  const identityInfo = {
    identity_source: identity.source,
    surnames_tried: identity.surnames,
  };

  if (!first && identity.surnames.length === 0) {
    return makeResult({
      status: EmailStatus.invalid,
      confidence: 1,
      method: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 3. Circuit breaker ──
  const health = await checkDomainHealth(domain);
  if (health.muted) {
    await logSearch(first, last, domain, null, "unknown", VerificationMethod.domain_muted, 0, 0, 0, Date.now() - start);
    return makeResult({
      status: EmailStatus.unknown,
      method: VerificationMethod.domain_muted,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 4. Domain analysis and early exits ──
  const domainInfo = await analyzeDomain(domain);

  if (!domainInfo.has_mx) {
    return makeResult({
      status: EmailStatus.no_mx,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }
  if (domainInfo.is_disposable) {
    return makeResult({
      status: EmailStatus.disposable,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 5. Everything we already own about this domain (one indexed query) ──
  const knownEmails = await getKnownEmailsForDomain(domain);

  // 5a. Do we already have this exact person? 7.4% of past searches were for
  // someone whose address was already sitting in `profiles`.
  const alreadyKnown = matchPerson(knownEmails, first, identity.surnames);
  if (alreadyKnown) {
    const pattern = identifyPatternForSurnames(alreadyKnown.email, first, identity.surnames);
    await recordDomainOutcome(domain, true);
    await logSearch(first, last, domain, alreadyKnown.email, "valid", VerificationMethod.known_email, 0, 0, 0, Date.now() - start);
    return makeResult({
      email: alreadyKnown.email,
      status: EmailStatus.valid,
      confidence: 0.95,
      method: VerificationMethod.known_email,
      pattern,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 6. Candidates, ordered by what this domain is known to do ──
  let candidates = generateCandidates(
    first,
    identity.surnames,
    domain,
    identity.second_given
  );

  const dbPatterns = await getDomainPatterns(domain);
  const inferredPatterns = inferPatternsFromKnownEmails(knownEmails);
  let patterns = mergePatterns(inferredPatterns, dbPatterns);
  candidates = prioritizePermutations(candidates, patterns, first, last);

  const strongPattern =
    patterns.length > 0 &&
    patterns[0].sample_count >= config.pattern_confidence_samples
      ? patterns[0]
      : null;

  // ── 7. Verification cache ──
  const cachedByEmail = await getCachedVerificationsBatch(candidates);
  for (const email of candidates) {
    const cached = cachedByEmail.get(email);
    if (cached?.status === EmailStatus.valid) {
      const pattern = identifyPatternForSurnames(email, first, identity.surnames);
      await recordDomainOutcome(domain, true);
      return makeResult({
        email,
        status: EmailStatus.valid,
        confidence: cached.confidence,
        method: cached.method,
        pattern,
        domain_info: domainInfo,
        permutations_tried: 0,
        cost_usd: 0,
        duration_ms: Date.now() - start,
        ...identityInfo,
      });
    }
  }

  // Candidates we already know are dead cost nothing to skip. This is the
  // payoff of caching negatives: 20.1% of searches repeat a person+domain.
  const untried = candidates.filter((email) => {
    const cached = cachedByEmail.get(email);
    return !cached || cached.status === EmailStatus.catch_all;
  });

  // ── 8. Known catch-all domain: probing cannot discriminate ──
  // A catch-all server accepts every local part, so buying five identical
  // "yes" answers tells us nothing the domain record already said. The pattern
  // is the only real signal here, and it is right 81.5% of the time.
  if (domainInfo.is_catch_all && patterns.length > 0) {
    const best =
      candidateForPattern(candidates, patterns[0].pattern, identity) ||
      candidates[0];
    const pattern = identifyPatternForSurnames(best, first, identity.surnames);
    const confidence = confidenceForPattern(patterns[0]);
    await recordDomainOutcome(domain, true);
    await logSearch(first, last, domain, best, "catch_all", VerificationMethod.domain_pattern, 0, 0, 0, Date.now() - start);
    return makeResult({
      email: best,
      status: EmailStatus.catch_all,
      confidence,
      method: VerificationMethod.domain_pattern,
      pattern,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 9. Strong pattern: verify exactly one address ──
  if (strongPattern && untried.length > 0 && !deadline.expired) {
    const single =
      candidateForPattern(untried, strongPattern.pattern, identity) || untried[0];
    const verdict = await apiCascade(single, maxTier);
    permutationsTried++;
    apiCalls++;
    totalCost += verdict.cost_usd;

    if (verdict.status === EmailStatus.valid) {
      return await concludeValid(
        single, verdict, first, last, identity, domain, domainInfo, null,
        permutationsTried, apiCalls, totalCost, start, identityInfo
      );
    }
    if (verdict.status === EmailStatus.catch_all) {
      await markDomainCatchAll(domain);
      const pattern = identifyPatternForSurnames(single, first, identity.surnames);
      await recordDomainOutcome(domain, true);
      await cacheVerification(single, "catch_all", confidenceForPattern(strongPattern), VerificationMethod.domain_pattern);
      await logSearch(first, last, domain, single, "catch_all", VerificationMethod.domain_pattern, permutationsTried, apiCalls, totalCost, Date.now() - start);
      return makeResult({
        email: single,
        status: EmailStatus.catch_all,
        confidence: confidenceForPattern(strongPattern),
        method: VerificationMethod.domain_pattern,
        pattern,
        domain_info: domainInfo,
        permutations_tried: permutationsTried,
        cost_usd: totalCost,
        duration_ms: Date.now() - start,
        ...identityInfo,
      });
    }

    // The pattern's spelling is dead — fall through to the scan, minus this one.
    await cacheNegativeVerifications([
      { email: single, status: verdict.status, confidence: verdict.confidence, method: verdict.method },
    ]);
    const idx = untried.indexOf(single);
    if (idx >= 0) untried.splice(idx, 1);
  }

  // ── 10. SERP, cached by domain ──
  // Only worth buying when we have no pattern of our own. It used to run on
  // every search, ahead of the cache check, so even a free cache hit paid it.
  let serpPatterns: { pattern: string; count: number; examples: string[] }[] = [];
  let serpDirectMatch: string | null = null;
  let serpEmailsFound = 0;
  const serpUsed = !!config.serper_api_key;

  if (!strongPattern && untried.length > 0 && !deadline.expired) {
    const cached = await getCachedSerp(domain);
    let serpEmails: string[];

    if (cached) {
      serpEmails = cached.emails;
      serpPatterns = cached.patterns;
    } else {
      const serpResult = await searchSerpForEmails(domain);
      totalCost += serpResult.cost_usd;
      serpEmails = serpResult.emails;
      serpPatterns =
        serpEmails.length > 0 ? identifyPatternsFromEmails(serpEmails) : [];
      await cacheSerp(domain, serpEmails, serpPatterns);
    }

    serpEmailsFound = serpEmails.length;
    for (const serpEmail of serpEmails) {
      if (candidates.includes(serpEmail)) {
        serpDirectMatch = serpEmail;
        break;
      }
    }

    if (serpPatterns.length > 0) {
      const asKnown: KnownPattern[] = serpPatterns.map((sp) => ({
        pattern: sp.pattern,
        confidence: Math.min(1.0, 0.7 + sp.count * 0.1),
        sample_count: sp.count,
      }));
      patterns = mergePatterns(patterns, asKnown);
      await Promise.all(
        serpPatterns.map((sp) => saveDomainPattern(domain, sp.pattern))
      );
    }
  }

  const serpInfo: SerpInfo = {
    used: serpUsed,
    emails_found: serpEmailsFound,
    patterns_detected: serpPatterns,
    direct_match: serpDirectMatch,
  };

  // A SERP hit that spells this exact person is worth jumping the queue for.
  let toTry = prioritizePermutations(untried, patterns, first, last);
  if (serpDirectMatch && toTry.includes(serpDirectMatch)) {
    toTry = [serpDirectMatch, ...toTry.filter((e) => e !== serpDirectMatch)];
  }
  toTry = toTry.slice(0, config.max_permutations_to_try);

  // ── 11. Verify the short list ──
  let riskyCandidate: VerificationResult | null = null;
  let catchAllCandidate: { email: string; result: VerificationResult } | null = null;
  const negatives: { email: string; status: EmailStatus; confidence: number; method: string | null }[] = [];
  const BATCH_SIZE = 5;
  const tier2Budget: TierBudget = { remaining: TIER2_BUDGET_PER_SEARCH };

  for (let i = 0; i < toTry.length; i += BATCH_SIZE) {
    if (deadline.expired) break;

    const batch = toTry.slice(i, i + BATCH_SIZE);
    const results = await apiCascadeParallel(batch, maxTier, BATCH_SIZE, tier2Budget);

    permutationsTried += batch.length;
    apiCalls += batch.length;
    for (const r of results) totalCost += r.cost_usd;

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const email = batch[j];

      if (result.status === EmailStatus.valid) {
        await cacheNegativeVerifications(negatives);
        return await concludeValid(
          email, result, first, last, identity, domain, domainInfo, serpInfo,
          permutationsTried, apiCalls, totalCost, start, identityInfo
        );
      }

      if (result.status === EmailStatus.catch_all && !catchAllCandidate) {
        catchAllCandidate = { email, result };
      } else if (result.status === EmailStatus.risky && !riskyCandidate) {
        riskyCandidate = result;
      } else {
        negatives.push({
          email,
          status: result.status,
          confidence: result.confidence,
          method: result.method,
        });
      }
    }

    // Catch-all is a property of the domain, not of this address: once seen,
    // scanning more candidates cannot tell them apart. Record it and answer
    // from the pattern.
    if (catchAllCandidate) break;
  }

  await cacheNegativeVerifications(negatives);

  // ── 12. Catch-all: answer from the pattern, not from the probe ──
  if (catchAllCandidate) {
    await markDomainCatchAll(domain);

    const top = patterns[0] || null;
    const best =
      (top && candidateForPattern(toTry, top.pattern, identity)) ||
      catchAllCandidate.email;
    const pattern = identifyPatternForSurnames(best, first, identity.surnames);
    const confidence = top ? confidenceForPattern(top) : 0.4;

    await cacheVerification(best, "catch_all", confidence, VerificationMethod.domain_pattern);
    await recordDomainOutcome(domain, true);
    await logSearch(first, last, domain, best, "catch_all", VerificationMethod.domain_pattern, permutationsTried, apiCalls, totalCost, Date.now() - start);
    return makeResult({
      email: best,
      status: EmailStatus.catch_all,
      confidence,
      method: VerificationMethod.domain_pattern,
      pattern,
      domain_info: domainInfo,
      serp_info: serpInfo,
      permutations_tried: permutationsTried,
      cost_usd: totalCost,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 13. Nothing conclusive ──
  await recordDomainOutcome(domain, false);

  if (riskyCandidate) {
    await logSearch(first, last, domain, riskyCandidate.email, "risky", riskyCandidate.method, permutationsTried, apiCalls, totalCost, Date.now() - start);
    return { ...riskyCandidate, serp_info: serpInfo, duration_ms: Date.now() - start, cost_usd: totalCost, ...identityInfo };
  }

  await logSearch(first, last, domain, null, "unknown", null, permutationsTried, apiCalls, totalCost, Date.now() - start);
  return makeResult({
    status: EmailStatus.unknown,
    domain_info: domainInfo,
    serp_info: serpInfo,
    permutations_tried: permutationsTried,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
    ...identityInfo,
  });
}

/**
 * Confidence for an address we built from a pattern rather than confirmed.
 *
 * Anchored on the leave-one-out measurement: with three or more samples the
 * domain's dominant pattern picks the right address 81.5% of the time. Thinner
 * evidence gets a lower number rather than the same optimistic one, so a
 * downstream filter on confidence actually separates the two.
 */
function confidenceForPattern(pattern: KnownPattern): number {
  if (pattern.sample_count >= 5) return 0.85;
  if (pattern.sample_count >= 3) return 0.8;
  if (pattern.sample_count === 2) return 0.6;
  return 0.45;
}

/** Shared tail for "we confirmed this address": learn, cache, log, return. */
async function concludeValid(
  email: string,
  result: VerificationResult,
  first: string,
  last: string,
  identity: ResolvedIdentity,
  domain: string,
  domainInfo: VerificationResult["domain_info"],
  serpInfo: SerpInfo | null,
  permutationsTried: number,
  apiCalls: number,
  totalCost: number,
  start: number,
  identityInfo: Record<string, unknown>
): Promise<VerificationResult> {
  const pattern = identifyPatternForSurnames(email, first, identity.surnames);
  if (pattern) await saveDomainPattern(domain, pattern);
  await cacheVerification(email, "valid", result.confidence, result.method);
  await recordDomainOutcome(domain, true);
  await logSearch(first, last, domain, email, "valid", result.method, permutationsTried, apiCalls, totalCost, Date.now() - start);

  return makeResult({
    email,
    status: EmailStatus.valid,
    confidence: result.confidence,
    method: result.method,
    pattern,
    domain_info: domainInfo,
    serp_info: serpInfo,
    permutations_tried: permutationsTried,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
    ...identityInfo,
  });
}

export async function verifySingleEmail(
  email: string,
  maxTier: number = 2
): Promise<VerificationResult> {
  const start = Date.now();

  // 1. Syntax check
  if (!email.includes("@")) {
    return makeResult({
      email,
      status: EmailStatus.invalid,
      confidence: 1.0,
      method: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start,
    });
  }

  const domain = email.split("@")[1];

  // 2. Cache check
  const cached = await getCachedVerification(email);
  if (cached) {
    return makeResult({
      email,
      status: cached.status,
      confidence: cached.confidence,
      method: cached.method,
      duration_ms: Date.now() - start,
    });
  }

  // 3. Domain analysis
  const domainInfo = await analyzeDomain(domain);
  if (!domainInfo.has_mx) {
    return makeResult({
      email,
      status: EmailStatus.no_mx,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }
  if (domainInfo.is_disposable) {
    return makeResult({
      email,
      status: EmailStatus.disposable,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }

  // 4. API cascade
  const cappedTier = Math.min(maxTier, 2); // No Tier 3 yet
  const result = await apiCascade(email, cappedTier);

  // 5. Cache and return. Every verdict is kept now, not just the good ones:
  // an `invalid` we paid for is worth exactly as much as a `valid` next time.
  if (result.status !== EmailStatus.unknown) {
    await cacheVerification(email, result.status, result.confidence, result.method);
  }
  if (result.status === EmailStatus.catch_all) {
    await markDomainCatchAll(domain);
  }

  return makeResult({
    email,
    status: result.status,
    confidence: result.confidence,
    method: result.method,
    domain_info: domainInfo,
    cost_usd: result.cost_usd,
    duration_ms: Date.now() - start,
  });
}

async function logSearch(
  firstName: string | null,
  lastName: string | null,
  domain: string | null,
  resultEmail: string | null,
  resultStatus: string | null,
  methodUsed: string | VerificationMethod | null,
  permutationsTried: number,
  apiCallsMade: number,
  costUsd: number,
  durationMs: number
): Promise<void> {
  try {
    await prisma.searchLog.create({
      data: {
        first_name: firstName,
        last_name: lastName,
        domain,
        result_email: resultEmail,
        result_status: resultStatus,
        method_used: methodUsed,
        permutations_tried: permutationsTried,
        api_calls_made: apiCallsMade,
        cost_usd: costUsd,
        duration_ms: durationMs,
      },
    });
  } catch {
    // Non-critical — don't fail pipeline on log errors
  }
}

// `normalizeName` is re-exported for the backfill script, which needs the same
// normalization the pipeline uses to keep mined patterns comparable.
export { normalizeName };
