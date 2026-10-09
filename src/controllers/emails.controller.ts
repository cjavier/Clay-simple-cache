import { Request, Response } from "express";
import { lookupCachedEmail } from "../services/email-cascade/cache";
import { defaultBudgetUsd, queueRetry, RetryFilter } from "../services/email-cascade/pending";
import { PendingReason } from "../services/email-cascade/cascade";
import { CASCADE_PROVIDERS, CascadeProviderId } from "../services/email-cascade/providers";
import { tableJobService } from "../services/table-job.service";
import { Policy, POLICIES } from "../services/email-cascade/verify";

const REASONS: PendingReason[] = ["sin_creditos", "rate_limit", "error", "presupuesto", "revalidar"];
const RETRY_PROVIDERS = [...CASCADE_PROVIDERS, "verify"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Body of a retry → filter, or an error message. */
export function parseRetry(b: any): { filter: RetryFilter; budgetUsd: number; policy?: Policy } | string {
  b = b && typeof b === "object" ? b : {};
  const filter: RetryFilter = {};
  if (b.provider !== undefined) {
    if (!(RETRY_PROVIDERS as readonly string[]).includes(b.provider)) return `provider must be one of ${RETRY_PROVIDERS.join(", ")}`;
    filter.provider = b.provider as CascadeProviderId | "verify";
  }
  if (b.reason !== undefined) {
    if (!REASONS.includes(b.reason)) return `reason must be one of ${REASONS.join(", ")}`;
    filter.reason = b.reason;
  }
  if (b.since !== undefined) {
    const d = new Date(String(b.since));
    if (Number.isNaN(d.getTime())) return "since must be a date (ISO 8601)";
    filter.since = d;
  }
  if (b.limit !== undefined) {
    if (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 5000) return "limit must be 1-5000";
    filter.limit = b.limit;
  }
  let budgetUsd = defaultBudgetUsd();
  if (b.budget_usd !== undefined) {
    const n = Number(b.budget_usd);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return "budget_usd must be 0-1000";
    budgetUsd = n;
  }
  let policy: Policy | undefined;
  if (b.policy !== undefined) {
    if (!(POLICIES as readonly string[]).includes(b.policy)) return `policy must be one of ${POLICIES.join(", ")}`;
    policy = b.policy;
  }
  return { filter, budgetUsd, ...(policy ? { policy } : {}) };
}

export const emailsController = {
  /**
   * POST /emails/lookup — free cache read for MailBridge's `clay_cache` provider.
   * Never calls a provider. Contract (keep stable, MailBridge depends on it):
   * {linkedin_url?, first_name?, last_name?, full_name?, company_domain?} →
   * {found, email, email_source, email_verification, email_found_via}.
   */
  async lookup(req: Request, res: Response) {
    try {
      const b = req.body || {};
      const person = {
        linkedin_url: str(b.linkedin_url),
        first_name: str(b.first_name),
        last_name: str(b.last_name),
        full_name: str(b.full_name),
        company_domain: str(b.company_domain),
      };
      const hasName = Boolean(person.full_name || (person.first_name && person.last_name));
      if (!person.linkedin_url && !(hasName && person.company_domain)) {
        res.status(400).json({ error: "linkedin_url, or a name (first_name + last_name, or full_name) with company_domain, is required" });
        return;
      }
      const hit = await lookupCachedEmail(person);
      if (!hit) {
        res.json({ found: false, email: null, email_source: null, email_verification: null, email_found_via: null });
        return;
      }
      res.json({
        found: true,
        email: hit.email,
        email_source: hit.email_source,
        email_verification: hit.email_verification,
        email_found_via: hit.email_found_via,
      });
    } catch (err) {
      console.error("Email lookup error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  /** POST /emails/retry and POST /tables/:id/emails/retry — count now, process in the background. */
  async retry(req: Request, res: Response) {
    try {
      const parsed = parseRetry(req.body);
      if (typeof parsed === "string") {
        res.status(400).json({ error: parsed });
        return;
      }
      let label = "reintento manual";
      if (req.params.id !== undefined) {
        const id = String(req.params.id);
        const job = UUID.test(id) ? await tableJobService.get(id) : null;
        if (!job) {
          res.status(404).json({ error: "Table job not found" });
          return;
        }
        parsed.filter.job_id = job.id;
        label = `reintento manual ${job.campaign} — ${job.niche}`;
      }
      const q = await queueRetry(parsed.filter, { trigger: "manual", budgetUsd: parsed.budgetUsd, policy: parsed.policy, label });
      res.status(202).json({
        retrying: q.persons,
        pending_rows: q.pending_rows,
        budget_usd: parsed.budgetUsd,
        filter: {
          ...(parsed.filter.job_id ? { table_job_id: parsed.filter.job_id } : {}),
          ...(parsed.filter.provider ? { provider: parsed.filter.provider } : {}),
          ...(parsed.filter.reason ? { reason: parsed.filter.reason } : {}),
          ...(parsed.filter.since ? { since: parsed.filter.since.toISOString() } : {}),
        },
        note: "Runs in the background: the cache is read first (free), then only the providers each person is pending for. Found emails go back to their MailBridge table (same row).",
      });
    } catch (err) {
      console.error("Email retry error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
