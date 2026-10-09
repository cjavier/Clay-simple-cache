/**
 * Emails in the cache: lookup (free), what we know about a recipient's server
 * (free) and saving what MailBridge's table columns found and verified.
 * The paid search and validation run in MailBridge (its spec 109).
 */
export { lookupCachedEmail, saveFoundEmail, personKey, isPersonalEmail } from "./cache";
export type { CacheHit } from "./cache";
export { serverFacts, evidenceFor, decide, POLICIES, EMPTY_FACTS, reusableVerification } from "./facts";
export type { ServerFacts, Policy, Qualification } from "./facts";
export { blitzClient, usable } from "./blitz";
export { applyCacheHit, cacheHitAccepted } from "./rows";
