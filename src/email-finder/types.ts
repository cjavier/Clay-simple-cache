export enum EmailStatus {
  valid = "valid",
  invalid = "invalid",
  catch_all = "catch_all",
  unknown = "unknown",
  risky = "risky",
  disposable = "disposable",
  no_mx = "no_mx",
  role_account = "role_account",
}

export enum VerificationMethod {
  local_syntax = "local_syntax",
  local_dns = "local_dns",
  emaillistverify = "emaillistverify",
  debounce = "debounce",
  bouncer = "bouncer",
  neverbounce = "neverbounce",
  serp_pattern = "serp_pattern",
  /** Answered from an address already in `profiles`. No API call, no cost. */
  known_email = "known_email",
  /** Built from the domain's learned mailbox convention rather than probed. */
  domain_pattern = "domain_pattern",
  /** Refused up front: this domain has never produced a result. */
  domain_muted = "domain_muted",
}

export enum ProviderType {
  google_workspace = "google_workspace",
  office365 = "office365",
  yahoo = "yahoo",
  other = "other",
}

export interface DomainInfo {
  domain: string;
  has_mx: boolean;
  mx_records: string[];
  provider: ProviderType;
  is_catch_all: boolean;
  is_disposable: boolean;
  is_free_provider: boolean;
  smtp_verifiable: boolean;
}

export interface SerpInfo {
  used: boolean;
  emails_found: number;
  patterns_detected: { pattern: string; count: number; examples: string[] }[];
  direct_match: string | null;
}

export interface VerificationResult {
  email: string | null;
  status: EmailStatus;
  confidence: number;
  method: VerificationMethod | null;
  pattern: string | null;
  domain_info: DomainInfo | null;
  serp_info: SerpInfo | null;
  permutations_tried: number;
  cost_usd: number;
  duration_ms: number;
  /**
   * Where the surnames we spelled came from. "linkedin" means we recovered the
   * paternal surname from the slug instead of trusting the `last_name` field,
   * which carries the maternal surname 74.9% of the time.
   */
  identity_source?: "linkedin" | "full_name" | "given";
  /** The surnames actually tried, in the order they were tried. */
  surnames_tried?: string[];
}

export interface FindRequest {
  first_name?: string;
  last_name?: string;
  domain: string;
  full_name?: string;
  /**
   * The person's LinkedIn profile, as a URL or a bare slug. Optional, and by
   * far the most valuable thing a caller can send: the slug carries the full
   * name, which is where the paternal surname lives.
   */
  linkedin_url?: string;
  linkedin_slug?: string;
  max_tier?: number;
  force_premium?: boolean;
  /** Override the wall-clock budget for this one search. */
  time_budget_ms?: number;
}

export interface EmailVerificationProvider {
  name: string;
  cost_per_email: number;
  method: VerificationMethod;
  is_configured(): boolean;
  verify(email: string): Promise<VerificationResult>;
}

/** Conclusive statuses that stop the cascade */
export const CONCLUSIVE_STATUSES: EmailStatus[] = [
  EmailStatus.valid,
  EmailStatus.invalid,
  EmailStatus.catch_all,
];
