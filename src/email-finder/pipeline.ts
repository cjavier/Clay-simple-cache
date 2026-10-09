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
  isKnownAddress,
  KnownEmail,
} from "./known-emails";
import { getCachedSerp, cacheSerp } from "./serp-cache";
import {
  getDomainOutcomes,
  getOutcomesForEmails,
  isBadMailDomain,
  mailGateway,
  rankPatterns,
  stricter,
  EVIDENCE,
  EvidenceTier,
  RankedPattern,
  DomainOutcomes,
  SendRecommendation,
} from "./outcomes";
import { namePartsFromSlug } from "./identity";
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

/**
 * What to tell the caller about an answer: the evidence tier's measured bounce
 * rate, made stricter when a security gateway sits in front of the mailbox.
 */
interface Advice {
  send_recommendation: SendRecommendation;
  evidence: EvidenceTier | "bad_mail_domain" | "no_answer";
  expected_bounce?: number;
  mail_gateway: string | null;
}

function advise(
  tier: EvidenceTier,
  gateway: { name: string; recommendation: SendRecommendation } | null
): Advice {
  const e = EVIDENCE[tier];
  // A gateway rejects cold mail by policy; only a delivery to this very
  // address proves it lets ours through.
  const recommendation =
    gateway && tier !== "address_confirmed"
      ? stricter(e.recommendation, gateway.recommendation)
      : e.recommendation;
  return {
    send_recommendation: recommendation,
    evidence: tier,
    expected_bounce: e.expected_bounce,
    mail_gateway: gateway?.name ?? null,
  };
}

/**
 * Rank the domain's patterns by mail history first, `profiles` second, and
 * turn them into the KnownPattern list the permutator orders candidates by.
 * Contradicted patterns go last: they are tried only if nothing else is left.
 */
function orderingFromRanked(ranked: RankedPattern[]): KnownPattern[] {
  return ranked.map((r, i) => ({
    pattern: r.pattern,
    confidence: r.tier === "pattern_contradicted" ? 0 : 1 - i * 0.01,
    sample_count: ranked.length - i,
  }));
}

/**
 * The address to answer with when probing can't tell candidates apart
 * (catch-all), and the evidence tier it rests on. Walks the ranked patterns
 * and takes the first one this person's name can be spelled in.
 */
function guessFromRanked(
  candidates: string[],
  ranked: RankedPattern[],
  identity: ResolvedIdentity
): { email: string; tier: EvidenceTier } | null {
  for (const r of ranked) {
    const email = candidateForPattern(candidates, r.pattern, identity);
    if (email) return { email, tier: r.tier };
  }
  return candidates[0] ? { email: candidates[0], tier: "no_evidence" } : null;
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
    await logSearch({
      first_name: null, last_name: null, domain: request.domain || null,
      result_status: "invalid", method_used: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start,
    });
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
    await logSearch({
      first_name: null, last_name: null, domain,
      result_status: "invalid", method_used: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start, identity_source: identity.source,
    });
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
    await logSearch({
      first_name: first, last_name: last, domain,
      result_status: "unknown", method_used: VerificationMethod.domain_muted,
      duration_ms: Date.now() - start, identity_source: identity.source,
    });
    return makeResult({
      status: EmailStatus.unknown,
      method: VerificationMethod.domain_muted,
      duration_ms: Date.now() - start,
      ...identityInfo,
    });
  }

  // ── 4. Domain analysis and early exits ──
  const domainInfo = await analyzeDomain(domain);

  // The early exits are logged too. They cost nothing in API calls, but a
  // search that never reaches the cascade is still a search Clay asked for,
  // and leaving it out of `search_log` silently understates the traffic and
  // overstates the average cost per search.
  if (!domainInfo.has_mx) {
    await logSearch({
      first_name: first, last_name: last, domain,
      result_status: "no_mx", method_used: VerificationMethod.local_dns,
      duration_ms: Date.now() - start, identity_source: identity.source,
      send_recommendation: "do_not_send", evidence: "no_answer",
    });
    return makeResult({
      status: EmailStatus.no_mx,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
      send_recommendation: "do_not_send",
      evidence: "no_answer",
    });
  }
  if (domainInfo.is_disposable) {
    await logSearch({
      first_name: first, last_name: last, domain,
      result_status: "disposable", method_used: VerificationMethod.local_dns,
      duration_ms: Date.now() - start, identity_source: identity.source,
      send_recommendation: "do_not_send", evidence: "no_answer",
    });
    return makeResult({
      status: EmailStatus.disposable,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
      send_recommendation: "do_not_send",
      evidence: "no_answer",
    });
  }

  // ── 4b. What happened when we actually mailed this domain ──
  const outcomes: DomainOutcomes = await getDomainOutcomes(domain);
  const gateway = mailGateway(domainInfo.mx_records || []);

  if (isBadMailDomain(outcomes)) {
    await logSearch({
      first_name: first, last_name: last, domain,
      result_status: "unknown", method_used: VerificationMethod.domain_bounces,
      duration_ms: Date.now() - start, identity_source: identity.source,
      send_recommendation: "do_not_send", evidence: "bad_mail_domain",
    });
    return makeResult({
      status: EmailStatus.unknown,
      method: VerificationMethod.domain_bounces,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
      send_recommendation: "do_not_send",
      evidence: "bad_mail_domain",
      mail_gateway: gateway?.name ?? null,
    });
  }

  const bouncedHere = (email: string) => outcomes.addresses.get(email)?.status === "bounced";
  const confirmedHere = (email: string) => {
    const s = outcomes.addresses.get(email)?.status;
    return s === "replied" || s === "delivered";
  };

  // ── 5. Everything we already own about this domain (one indexed query) ──
  // An address that bounced is not knowledge, it is the opposite: it is
  // dropped here so it can neither be served back nor teach a pattern.
  // Addresses that were delivered or answered join the list with their names,
  // so a person MailBridge already reached is recognized directly.
  const fromProfiles = (await getKnownEmailsForDomain(domain)).filter((k) => !bouncedHere(k.email));
  const seen = new Set(fromProfiles.map((k) => k.email));
  const fromOutcomes: KnownEmail[] = [];
  for (const s of outcomes.addresses.values()) {
    if (seen.has(s.email) || !(s.status === "replied" || s.status === "delivered")) continue;
    fromOutcomes.push({
      email: s.email,
      first: s.first_name || "",
      last: s.last_name || "",
      slug_parts: s.linkedin_slug ? namePartsFromSlug(s.linkedin_slug) : [],
    });
  }
  const knownEmails = [...fromOutcomes, ...fromProfiles];

  // 5a. Do we already have this exact person? 7.4% of past searches were for
  // someone whose address was already sitting in `profiles`.
  const alreadyKnown = matchPerson(knownEmails, first, identity.surnames);
  if (alreadyKnown) {
    const pattern = identifyPatternForSurnames(alreadyKnown.email, first, identity.surnames);
    const viaMail = confirmedHere(alreadyKnown.email);
    const advice = advise(viaMail ? "address_confirmed" : "known_address", gateway);
    const method = viaMail ? VerificationMethod.mailbridge_outcome : VerificationMethod.known_email;
    await recordDomainOutcome(domain, true);
    await logSearch({
      first_name: first, last_name: last, domain,
      result_email: alreadyKnown.email, result_status: "valid",
      method_used: method,
      duration_ms: Date.now() - start, identity_source: identity.source,
      ...advice,
    });
    return makeResult({
      email: alreadyKnown.email,
      status: EmailStatus.valid,
      confidence: 1 - (advice.expected_bounce ?? 0.05),
      method,
      pattern,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
      ...advice,
    });
  }

  // ── 6. Candidates, ordered by what this domain is known to do ──
  let candidates = generateCandidates(
    first,
    identity.surnames,
    domain,
    identity.second_given
  );

  // Everything the permutator could offer, before any budget truncates it.
  // Logged alongside `permutations_tried` so the saving the budget produces is
  // a measured number rather than an assumption.
  const candidatesBuilt = candidates.length;

  // A spelling that already bounced is dead: never verify it, never guess it.
  // A spelling that belongs to someone else is worse than dead: `mariana@` at a
  // domain where Mariana Castillo already reads her mail is not where Mariana
  // Quiroga's goes, and an email for one landing with the other is a mistake a
  // bounce would at least have hidden. Short patterns (`first`, `last`) collide
  // this way, so any address we already hold under another person's name is out.
  const knownByEmail = new Map(knownEmails.map((k) => [k.email, k]));
  const isNamed = (k: KnownEmail | undefined) => !!k && (!!k.first || k.slug_parts.length > 0);
  const ownedByOther = (email: string) => {
    const k = knownByEmail.get(email);
    return isNamed(k) && !matchPerson([k!], first, identity.surnames);
  };
  candidates = candidates.filter((email) => !bouncedHere(email) && !ownedByOther(email));

  const dbPatterns = await getDomainPatterns(domain);
  const inferredPatterns = inferPatternsFromKnownEmails(knownEmails);
  let patterns = mergePatterns(inferredPatterns, dbPatterns);
  let ranked = rankPatterns(patterns, outcomes);
  candidates = prioritizePermutations(candidates, orderingFromRanked(ranked), first, last);

  // "Strong" = good enough to spend a single verification on before scanning.
  const STRONG_TIERS: EvidenceTier[] = [
    "pattern_confirmed", "pattern_mostly_ok", "profiles_strong", "profiles_moderate",
  ];
  const strongPattern =
    ranked.length > 0 && STRONG_TIERS.includes(ranked[0].tier)
      ? ranked[0]
      : null;

  // ── 6b. A candidate MailBridge already delivered to or heard back from ──
  // Only when nothing says the mailbox is someone else's: either it is filed
  // under no name at all and the spelling carries one of this person's
  // surnames, or it is filed under this person (matchPerson above would
  // usually have caught that already).
  const surnameTokens = identity.surnames
    .flatMap((x) => x.split(/\s+/))
    .map((x) => x.replace(/[^a-z]/g, ""))
    .filter((x) => x.length >= 3);
  const confirmed = candidates.find(
    (email) =>
      confirmedHere(email) &&
      (isNamed(knownByEmail.get(email)) ||
        surnameTokens.some((t) => email.split("@")[0].includes(t)))
  );
  if (confirmed) {
    const advice = advise("address_confirmed", gateway);
    await recordDomainOutcome(domain, true);
    await logSearch({
      first_name: first, last_name: last, domain,
      result_email: confirmed, result_status: "valid",
      method_used: VerificationMethod.mailbridge_outcome,
      duration_ms: Date.now() - start, identity_source: identity.source,
      candidates_built: candidatesBuilt, ...advice,
    });
    return makeResult({
      email: confirmed,
      status: EmailStatus.valid,
      confidence: 0.99,
      method: VerificationMethod.mailbridge_outcome,
      pattern: identifyPatternForSurnames(confirmed, first, identity.surnames),
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
      ...identityInfo,
      ...advice,
    });
  }

  // ── 7. Verification cache ──
  const cachedByEmail = await getCachedVerificationsBatch(candidates);
  for (const email of candidates) {
    const cached = cachedByEmail.get(email);
    if (cached?.status === EmailStatus.valid) {
      const pattern = identifyPatternForSurnames(email, first, identity.surnames);
      const advice = advise(
        cached.method === VerificationMethod.known_email ? "known_address" : "smtp_verified",
        gateway
      );
      await recordDomainOutcome(domain, true);
      await logSearch({
        first_name: first, last_name: last, domain,
        result_email: email, result_status: "valid",
        method_used: cached.method, duration_ms: Date.now() - start,
        identity_source: identity.source, candidates_built: candidatesBuilt,
        ...advice,
      });
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
        ...advice,
      });
    }
  }

  // Candidates we already know are dead cost nothing to skip. This is the
  // payoff of caching negatives: 20.1% of searches repeat a person+domain.
  const untried = candidates.filter((email) => {
    const cached = cachedByEmail.get(email);
    return !cached || cached.status === EmailStatus.catch_all;
  });

  /** Answer a catch-all from the best-evidenced pattern, and log it. */
  const answerCatchAll = async (
    pool: string[],
    extra: { permutations_tried?: number; api_calls_made?: number; cost_usd?: number; timed_out?: boolean; serp_info?: SerpInfo | null } = {}
  ): Promise<VerificationResult> => {
    const guess = guessFromRanked(pool.length > 0 ? pool : candidates, ranked, identity);
    const email = guess?.email ?? null;
    const advice = advise(guess?.tier ?? "no_evidence", gateway);
    const pattern = email ? identifyPatternForSurnames(email, first, identity.surnames) : null;
    const confidence = 1 - (advice.expected_bounce ?? 0.5);
    if (email) {
      await cacheVerification(email, "catch_all", confidence, VerificationMethod.domain_pattern);
    }
    await recordDomainOutcome(domain, true);
    await logSearch({
      first_name: first, last_name: last, domain,
      result_email: email, result_status: "catch_all",
      method_used: VerificationMethod.domain_pattern,
      permutations_tried: extra.permutations_tried ?? 0,
      api_calls_made: extra.api_calls_made ?? 0,
      cost_usd: extra.cost_usd ?? 0, duration_ms: Date.now() - start,
      identity_source: identity.source, timed_out: extra.timed_out ?? false,
      candidates_built: candidatesBuilt, ...advice,
    });
    return makeResult({
      email,
      status: EmailStatus.catch_all,
      confidence,
      method: VerificationMethod.domain_pattern,
      pattern,
      domain_info: domainInfo,
      serp_info: extra.serp_info ?? null,
      permutations_tried: extra.permutations_tried ?? 0,
      cost_usd: extra.cost_usd ?? 0,
      duration_ms: Date.now() - start,
      ...identityInfo,
      ...(extra.timed_out ? { timed_out: true } : {}),
      ...advice,
    });
  };

  // ── 8. Known catch-all domain: probing cannot discriminate ──
  // A catch-all server accepts every local part, so buying five identical
  // "yes" answers tells us nothing the domain record already said. That holds
  // for Google Workspace too: on 240 Google "catch-all" addresses with a known
  // fate, DeBounce and EmailListVerify both said accept-all to 231 of them,
  // bounced or not. The only signal that separates them is mail history, which
  // `ranked` puts first — and the recommendation says how far to trust it.
  if (domainInfo.is_catch_all && (ranked.length > 0 || patterns.length > 0)) {
    return await answerCatchAll(untried);
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
        permutationsTried, apiCalls, totalCost, start, identityInfo, candidatesBuilt,
        advise("smtp_verified", gateway)
      );
    }
    if (verdict.status === EmailStatus.catch_all) {
      await markDomainCatchAll(domain);
      return await answerCatchAll(untried, {
        permutations_tried: permutationsTried, api_calls_made: apiCalls, cost_usd: totalCost,
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
      ranked = rankPatterns(patterns, outcomes);
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
  let toTry = prioritizePermutations(untried, orderingFromRanked(ranked), first, last);
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

  let timedOut = false;
  for (let i = 0; i < toTry.length; i += BATCH_SIZE) {
    if (deadline.expired) {
      timedOut = true;
      break;
    }

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
          permutationsTried, apiCalls, totalCost, start, identityInfo, candidatesBuilt,
          advise("smtp_verified", gateway)
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
    return await answerCatchAll(toTry, {
      permutations_tried: permutationsTried, api_calls_made: apiCalls,
      cost_usd: totalCost, timed_out: timedOut, serp_info: serpInfo,
    });
  }

  // ── 13. Nothing conclusive ──
  // A search that ran out of time did NOT establish that the domain is
  // fruitless, so it must not count against the circuit breaker — otherwise a
  // slow afternoon would mute domains that answer perfectly well.
  if (!timedOut) await recordDomainOutcome(domain, false);

  if (riskyCandidate) {
    const advice: Advice = {
      send_recommendation: "risky", evidence: "no_evidence",
      expected_bounce: EVIDENCE.no_evidence.expected_bounce, mail_gateway: gateway?.name ?? null,
    };
    await logSearch({
      first_name: first, last_name: last, domain,
      result_email: riskyCandidate.email, result_status: "risky",
      method_used: riskyCandidate.method,
      permutations_tried: permutationsTried, api_calls_made: apiCalls,
      cost_usd: totalCost, duration_ms: Date.now() - start,
      identity_source: identity.source, timed_out: timedOut,
      candidates_built: candidatesBuilt, ...advice,
    });
    return { ...riskyCandidate, serp_info: serpInfo, duration_ms: Date.now() - start, cost_usd: totalCost, ...identityInfo, timed_out: timedOut, ...advice };
  }

  await logSearch({
    first_name: first, last_name: last, domain,
    result_status: "unknown", method_used: timedOut ? "timed_out" : null,
    permutations_tried: permutationsTried, api_calls_made: apiCalls,
    cost_usd: totalCost, duration_ms: Date.now() - start,
    identity_source: identity.source, timed_out: timedOut,
    candidates_built: candidatesBuilt,
    send_recommendation: "do_not_send", evidence: "no_answer",
  });
  return makeResult({
    status: EmailStatus.unknown,
    domain_info: domainInfo,
    serp_info: serpInfo,
    permutations_tried: permutationsTried,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
    ...identityInfo,
    timed_out: timedOut,
    send_recommendation: "do_not_send",
    evidence: "no_answer",
    mail_gateway: gateway?.name ?? null,
  });
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
  identityInfo: Record<string, unknown>,
  candidatesBuilt: number,
  advice: Advice
): Promise<VerificationResult> {
  const pattern = identifyPatternForSurnames(email, first, identity.surnames);
  if (pattern) await saveDomainPattern(domain, pattern);
  await cacheVerification(email, "valid", result.confidence, result.method);
  await recordDomainOutcome(domain, true);
  await logSearch({
    first_name: first, last_name: last, domain,
    result_email: email, result_status: "valid", method_used: result.method,
    permutations_tried: permutationsTried, api_calls_made: apiCalls,
    cost_usd: totalCost, duration_ms: Date.now() - start,
    identity_source: identity.source, candidates_built: candidatesBuilt,
    ...advice,
  });

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
    ...advice,
  });
}

/**
 * Verify one address. What happened when it was actually mailed outranks
 * everything else: a hard bounce beats a cached `valid` and beats `profiles`
 * (which held 10,954 bounced addresses that `/verify` used to call valid), and
 * a delivery or a reply beats any SMTP probe.
 */
export async function verifySingleEmail(
  email: string,
  maxTier: number = 2
): Promise<VerificationResult> {
  const start = Date.now();
  const lower = email.trim().toLowerCase();
  const outcome = lower.includes("@")
    ? (await getOutcomesForEmails([lower])).get(lower)
    : undefined;
  if (outcome?.status === "bounced") {
    return makeResult({
      email,
      status: EmailStatus.invalid,
      confidence: 0.99,
      method: VerificationMethod.mailbridge_outcome,
      duration_ms: Date.now() - start,
      ...advise("address_bounced", null),
    });
  }
  if (outcome?.status === "replied" || outcome?.status === "delivered") {
    return makeResult({
      email,
      status: EmailStatus.valid,
      confidence: 0.99,
      method: VerificationMethod.mailbridge_outcome,
      duration_ms: Date.now() - start,
      ...advise("address_confirmed", null),
    });
  }

  const result = await verifyWithoutOutcomes(email, maxTier, start);
  return { ...adviceForVerdict(result), ...result };
}

/**
 * Advice for a bare verdict, when no name is known and so no pattern evidence
 * applies. A `catch_all` here is unresolved — the server accepts everything —
 * so it is `risky`, never `send`.
 */
function adviceForVerdict(result: VerificationResult): Advice {
  const gateway = result.domain_info ? mailGateway(result.domain_info.mx_records || []) : null;
  switch (result.status) {
    case EmailStatus.valid:
      return advise(result.method === VerificationMethod.known_email ? "known_address" : "smtp_verified", gateway);
    case EmailStatus.catch_all:
      return {
        send_recommendation: stricter("risky", gateway?.recommendation ?? "risky"),
        evidence: "no_evidence",
        expected_bounce: EVIDENCE.profiles_moderate.expected_bounce,
        mail_gateway: gateway?.name ?? null,
      };
    default:
      return {
        send_recommendation: "do_not_send",
        evidence: "no_answer",
        mail_gateway: gateway?.name ?? null,
      };
  }
}

async function verifyWithoutOutcomes(
  email: string,
  maxTier: number,
  start: number
): Promise<VerificationResult> {

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

  // 2b. Already in `profiles`? Then a provider found it and Clay kept it —
  // better evidence than a fresh probe, and free. Written into the verification
  // cache on the way out so the next call doesn't even pay the query.
  if (await isKnownAddress(email)) {
    await cacheVerification(email, "valid", 0.95, VerificationMethod.known_email);
    return makeResult({
      email,
      status: EmailStatus.valid,
      confidence: 0.95,
      method: VerificationMethod.known_email,
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

/**
 * One row per search.
 *
 * Positional arguments were a liability here: ten of them, three of which were
 * numbers in a row, and every new dimension made a silent mis-ordering more
 * likely. An object also means a caller that forgets `identity_source` records
 * a null instead of shifting every field after it.
 */
interface SearchLogEntry {
  first_name: string | null;
  last_name: string | null;
  domain: string | null;
  result_email?: string | null;
  result_status: string | null;
  method_used?: string | VerificationMethod | null;
  permutations_tried?: number;
  api_calls_made?: number;
  cost_usd?: number;
  duration_ms: number;
  identity_source?: string | null;
  timed_out?: boolean;
  candidates_built?: number;
  send_recommendation?: string | null;
  evidence?: string | null;
  /** Carried along by `...advice`; not stored. */
  expected_bounce?: number;
  mail_gateway?: string | null;
}

async function logSearch(entry: SearchLogEntry): Promise<void> {
  try {
    await prisma.searchLog.create({
      data: {
        first_name: entry.first_name,
        last_name: entry.last_name,
        domain: entry.domain,
        result_email: entry.result_email ?? null,
        result_status: entry.result_status,
        method_used: (entry.method_used as string) ?? null,
        permutations_tried: entry.permutations_tried ?? 0,
        api_calls_made: entry.api_calls_made ?? 0,
        cost_usd: entry.cost_usd ?? 0,
        duration_ms: entry.duration_ms,
        identity_source: entry.identity_source ?? null,
        timed_out: entry.timed_out ?? false,
        candidates_built: entry.candidates_built ?? 0,
        send_recommendation: entry.send_recommendation ?? null,
        evidence: entry.evidence ?? null,
      },
    });
  } catch {
    // Non-critical — don't fail pipeline on log errors
  }
}

// `normalizeName` is re-exported for the backfill script, which needs the same
// normalization the pipeline uses to keep mined patterns comparable.
export { normalizeName };
