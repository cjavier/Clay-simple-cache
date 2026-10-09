import crypto from "crypto";
import { UpsertRow } from "./mailbridge.client";
import { provenanceEnforced, validateIngestProvenance } from "../email-finder/provenance";

/**
 * Rows for a MailBridge list: canonical field names in, MailBridge headers out.
 *
 * The headers are the ones MailBridge's promote (`mb_promote_table_rows`)
 * already maps onto a contact — Email, First Name, Job Title, Company, Domain,
 * LinkedIn Profile… — so a table built here can go to a campaign without a
 * mapping step. Fields not listed pass through with their own name and end up
 * as the contact's custom variables when promoted.
 *
 * Every email carries where it came from. `email_source` is required on any
 * row with an email, and travels two ways: as the "Email Source" column (which
 * promote copies into the contact's custom variables, so bounces and replies
 * can be measured per provider later) and as the provenance of the Email cell
 * (`cells.email.provider` in MailBridge).
 */

export const TABLE_KINDS = ["companies", "people"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

const PEOPLE_HEADERS: Record<string, string> = {
  first_name: "First Name",
  last_name: "Last Name",
  full_name: "Full Name",
  job_title: "Job Title",
  job_start_date: "Job Start Date",
  company: "Company",
  domain: "Domain",
  company_linkedin_url: "Company LinkedIn",
  linkedin_url: "LinkedIn Profile",
  city: "City",
  state: "State",
  country: "Country",
  connections: "Connections",
  email: "Email",
  email_source: "Email Source",
  email_status: "Email Status",
  email_verifier: "Email Verifier",
  email_verdict: "Email Verdict",
  email_checked_at: "Email Checked At",
  email_confidence: "Email Confidence",
  email_found: "Email Found",
  // Validation (email cascade): the validator's raw answer and what we know of the recipient's server.
  email_validator_response: "Email Validator Response",
  mx_provider: "MX Provider",
  mail_gateway: "Mail Gateway",
  domain_catch_all: "Domain Catch-All",
  email_evidence: "Email Evidence",
  expected_bounce: "Expected Bounce",
  send_recommendation: "Send Recommendation",
  email_policy: "Email Policy",
  domain_match: "Domain Match",
  discard_reason: "Discard Reason",
  other_emails: "Other Emails",
  industry: "Industry",
  company_size: "Company Size",
  employees_on_linkedin: "Employees on LinkedIn",
  company_state: "Company State",
  company_description: "Company Description",
};

const COMPANY_HEADERS: Record<string, string> = {
  company: "Company",
  domain: "Domain",
  website: "Website",
  linkedin_url: "Company LinkedIn",
  industry: "Industry",
  company_size: "Company Size",
  employees_on_linkedin: "Employees on LinkedIn",
  followers: "Followers",
  founded_year: "Founded Year",
  company_type: "Company Type",
  state: "State",
  city: "City",
  country: "Country",
  description: "Description",
  specialties: "Specialties",
  contacts_found: "Contacts Found",
  contacts_with_email: "Contacts With Email",
};

export const HEADERS: Record<TableKind, Record<string, string>> = {
  people: PEOPLE_HEADERS,
  companies: COMPANY_HEADERS,
};

/** A provider id: lowercase slug, e.g. "blitzapi", "findymail", "clay-cache". */
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{1,40}$/;
const RESERVED = new Set(["ref"]);

export class RowError extends Error {
  constructor(message: string, public readonly index: number) {
    super(`rows[${index}]: ${message}`);
  }
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
}

function normLinkedIn(v: string): string {
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("?")[0].replace(/\/+$/, "");
}

function normDomain(v: string): string {
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/**
 * The row's identity inside its table. MailBridge upserts on it, so it must be
 * stable across retries and across later enrichment of the same person/company.
 */
export function rowRef(kind: TableKind, row: Record<string, unknown>): string {
  if (present(row.ref)) return String(row.ref).trim();
  if (present(row.linkedin_url)) return `li:${normLinkedIn(String(row.linkedin_url))}`;
  if (kind === "people" && present(row.email)) return `email:${String(row.email).trim().toLowerCase()}`;
  if (kind === "companies" && present(row.domain)) return `domain:${normDomain(String(row.domain))}`;
  const stable = JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
  return `hash:${crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}

/** Validate and map one caller row. Throws RowError with the index on bad input. */
export function toUpsertRow(
  kind: TableKind,
  row: unknown,
  index: number,
  opts: { enforceProvenance?: boolean } = {}
): UpsertRow {
  const enforce = opts.enforceProvenance ?? provenanceEnforced();
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new RowError("must be an object", index);
  const r = { ...(row as Record<string, unknown>) };
  const headers = HEADERS[kind];

  const sources: Record<string, string> = {};
  if (kind === "people" && present(r.email)) {
    const source = typeof r.email_source === "string" ? r.email_source.trim().toLowerCase() : "";
    if (!source) throw new RowError("a row with an email needs email_source (e.g. \"blitzapi\")", index);
    if (!PROVIDER.test(source)) throw new RowError(`email_source '${r.email_source}' is not a provider id (lowercase, e.g. "blitzapi")`, index);
    r.email_source = source;
    sources[headers.email] = source;

    // Who verified it and what they said. `email_verification` ({provider|null, verdict, ...}) or the flat
    // `email_verifier`/`email_verdict`; the legacy `email_status: "valido"` counts as a `valid` verdict.
    const given: Record<string, unknown> = {
      email_source: source,
      email_verification: r.email_verification,
      email_verifier: r.email_verifier,
      email_verdict: r.email_verdict ?? (typeof r.email_status === "string" && r.email_status.trim().toLowerCase() === "valido" ? "valid" : undefined),
      email_checked_at: r.email_checked_at,
      email_confidence: r.email_confidence,
    };
    const check = validateIngestProvenance(given);
    if (check.ok) {
      const p = check.provenance;
      delete r.email_verification;
      r.email_verifier = p.verifier ?? undefined;
      r.email_verdict = p.verdict;
      r.email_checked_at = p.checked_at;
      r.email_confidence = p.confidence ?? undefined;
      if (p.verifier) sources[headers.email_verdict] = p.verifier;
    } else if (enforce) {
      throw new RowError(check.message, index);
    } else {
      delete r.email_verification; // an object has no column; the flat fields (if any) pass through
    }
  }

  const data: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(r)) {
    if (RESERVED.has(field) || value === undefined) continue;
    data[headers[field] ?? field] = value;
  }
  if (Object.keys(data).length === 0) throw new RowError("has no fields", index);

  return { ref: rowRef(kind, r), data, ...(Object.keys(sources).length ? { sources } : {}) };
}

/** Table names: "<CAMP> — Empresas <niche>" / "<CAMP> — Personas <niche>", versioned only on collision. */
export function tableNames(existing: Set<string>, campaign: string, niche: string, kinds: readonly TableKind[]): Record<TableKind, string> {
  const label: Record<TableKind, string> = { companies: "Empresas", people: "Personas" };
  const base = Object.fromEntries(kinds.map((k) => [k, `${campaign} — ${label[k]} ${niche}`.trim()])) as Record<TableKind, string>;
  if (kinds.every((k) => !existing.has(base[k]))) return base;
  let n = 2;
  while (kinds.some((k) => existing.has(`${base[k]} v${n}`))) n++;
  return Object.fromEntries(kinds.map((k) => [k, `${base[k]} v${n}`])) as Record<TableKind, string>;
}
