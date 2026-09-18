function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const config = {
  get emaillistverify_api_key() { return process.env.EMAILLISTVERIFY_API_KEY || ""; },
  get debounce_api_key() { return process.env.DEBOUNCE_API_KEY || ""; },
  get serper_api_key() { return process.env.SERPER_API_KEY || ""; },

  // How many candidate addresses a single search may pay to verify.
  //
  // This was 15. Replayed over 119,981 known-good corporate addresses, the
  // candidate list now reaches 62.7% at three tries and 66.8% at five, while
  // the old fifteen-deep list on the old name reached 59.1% — so five tries buy
  // more answers than fifteen used to, at a third of the calls. Candidates 6-15
  // add 3.9 points for twice the spend, which is why the default stops at five.
  get max_permutations_to_try() { return num("MAX_PERMUTATIONS", 5); },

  // When a domain's pattern is already known with this much evidence, the
  // search verifies exactly one address instead of scanning. Leave-one-out over
  // the profiles table puts that single guess right 81.5% of the time — against
  // 33.3% for the catch-all guessing it replaces.
  get pattern_confidence_samples() { return num("PATTERN_MIN_SAMPLES", 3); },

  // Hard wall-clock budget for one /find. Answers delivered inside 30s were
  // used by the caller 99.3% of the time; answers over an hour, 29.4%. Past
  // this point the remaining work is being done for nobody, so it stops.
  get find_time_budget_ms() { return num("FIND_TIME_BUDGET_MS", 20_000); },

  // Cache TTL in seconds
  domain_cache_ttl: 604800,        // 7 days
  verification_cache_ttl: 2592000, // 30 days
  get serp_cache_ttl() { return num("SERP_CACHE_TTL_SECONDS", 2592000); }, // 30 days

  // Circuit breaker: consecutive fruitless searches before a domain is muted,
  // and for how long.
  get domain_mute_after() { return num("DOMAIN_MUTE_AFTER", 10); },
  get domain_mute_days() { return num("DOMAIN_MUTE_DAYS", 30); },
};
