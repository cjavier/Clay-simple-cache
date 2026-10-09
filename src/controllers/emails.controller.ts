import { Request, Response } from "express";
import { lookupCachedEmail, saveFoundEmail } from "../services/email-cascade/cache";
import { EMPTY_FACTS, evidenceFor, POLICIES, Policy, Qualification, serverFacts, ServerFacts } from "../services/email-cascade/facts";
import { normalizeEmail } from "../services/normalization";
import { normalizeProvider, normalizeVerdict } from "../email-finder/provenance";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const EMAIL = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;

function person(b: any) {
  return {
    linkedin_url: str(b.linkedin_url),
    first_name: str(b.first_name),
    last_name: str(b.last_name),
    full_name: str(b.full_name),
    company_domain: str(b.company_domain),
    company_name: str(b.company_name),
  };
}

/** MailBridge's facts (when it sends them) over ours; missing keys are ours. */
function mergeFacts(sent: unknown, own: ServerFacts): ServerFacts {
  if (!isObj(sent)) return own;
  const pick = <K extends keyof ServerFacts>(k: K) => (sent[k] === undefined ? own[k] : (sent[k] as ServerFacts[K]));
  return {
    mx_provider: pick("mx_provider"),
    mail_gateway: pick("mail_gateway"),
    domain_catch_all: pick("domain_catch_all"),
    bad_domain: Boolean(pick("bad_domain")),
    pattern: pick("pattern"),
    pattern_tier: pick("pattern_tier"),
    address_status: pick("address_status"),
  };
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

  /**
   * POST /emails/facts — free: what this cache knows about the recipient's
   * server (MX provider, security gateway, catch-all) and this domain's mail
   * history (bad domain, pattern tier, this address' outcome). MailBridge's
   * "Verificación" column calls it before applying the acceptance policy.
   * Contract: {email, first_name?, last_name?, linkedin_url?} → ServerFacts.
   */
  async facts(req: Request, res: Response) {
    try {
      const b = req.body || {};
      const email = str(b.email)?.toLowerCase() ?? null;
      if (!email || !EMAIL.test(email)) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      res.json(await serverFacts(email, str(b.first_name), str(b.last_name), str(b.linkedin_url)));
    } catch (err) {
      console.error("Email facts error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  /**
   * POST /emails/results — MailBridge sends back what its table columns found
   * and verified (each email with its provider, and each verdict with its
   * verifier), so the next lookup of this person is free. Saved like the old
   * cascade did: profile + provenance (which also reaches MailBridge's
   * email evidence). An invalid verdict never replaces the address a person
   * already has. Never calls a provider.
   */
  async results(req: Request, res: Response) {
    try {
      const b = req.body || {};
      const p = person(b);
      const email = str(b.email)?.toLowerCase() ?? null;
      if (!email || !EMAIL.test(email)) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const hasName = Boolean(p.full_name || (p.first_name && p.last_name));
      if (!p.linkedin_url && !(hasName && p.company_domain)) {
        res.status(400).json({ error: "linkedin_url, or a name with company_domain, is required" });
        return;
      }
      const source = normalizeProvider(str(b.email_source)) || "mailbridge";
      const v = isObj(b.verification) ? b.verification : null;
      const verdict = v ? normalizeVerdict(v.verdict) : null;
      let q: Qualification | undefined;
      if (v && verdict) {
        const facts = mergeFacts(b.facts, b.facts ? EMPTY_FACTS : await serverFacts(email, p.first_name, p.last_name, p.linkedin_url).catch(() => EMPTY_FACTS));
        const ev = evidenceFor(verdict, facts);
        const policy = (POLICIES as readonly string[]).includes(b.policy) ? (b.policy as Policy) : null;
        q = {
          verification: {
            provider: str(v.provider),
            verdict,
            checked_at: str(v.checked_at) ?? new Date().toISOString(),
            confidence: typeof v.confidence === "number" ? v.confidence : null,
          },
          validator_response: b.validator_response ?? null,
          facts,
          evidence: str(b.evidence) ?? ev.tier,
          expected_bounce: typeof b.expected_bounce === "number" ? b.expected_bounce : ev.expected_bounce,
          send_recommendation: ["send", "risky", "do_not_send"].includes(b.send_recommendation) ? b.send_recommendation : ev.recommendation,
          policy,
          decision: policy && ["accept", "discard", "revalidate"].includes(b.decision) ? b.decision : null,
          reason: str(b.reason),
        };
      }
      await saveFoundEmail(
        p,
        { email: normalizeEmail(email), source, verification: verdict && !q ? { provider: str(v?.provider), verdict } : null },
        q,
        { foundVia: str(b.origin) ?? "mailbridge_table" }
      );
      res.json({ saved: true, email, email_source: source, verdict: q?.verification.verdict ?? null });
    } catch (err) {
      console.error("Email results error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
