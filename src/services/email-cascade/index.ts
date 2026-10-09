/**
 * Email cascade: cache first, then Blitz → Prospeo → Findymail, with a spend
 * cap per job, a persistent circuit breaker per provider, pending people kept
 * apart from real misses, and hourly reactivation. See each module.
 */
export { findEmailCascade, Budget } from "./cascade";
export type { CascadeResult, CascadeDeps, PendingReason, AttemptContext } from "./cascade";
export { lookupCachedEmail, saveFoundEmail, personKey } from "./cache";
export type { CacheHit } from "./cache";
export { CASCADE_PROVIDERS, unitCost } from "./providers";
export type { CascadePerson, CascadeProviderId } from "./providers";
export { defaultDeps, defaultBudgetUsd, queueRetry, jobPendingSummary, pendingGroups, processGroups } from "./pending";
export type { RetryFilter } from "./pending";
export { startEmailCascadeSchedule, hourlyTick } from "./schedule";
