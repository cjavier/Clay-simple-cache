import {
  EmailVerificationProvider,
  EmailStatus,
  VerificationMethod,
  VerificationResult,
} from "../types";
import { config } from "../config";

// EmailListVerify's published status list is incomplete — `antispam_system`
// appeared in 3 of 12 live searches and was in no documentation. Anything not
// listed here is logged and charged nothing (see verify()), so the next
// undocumented status shows up in the logs instead of being silently billed
// and flattened to "unknown".
//
// Statuses that leave deliverability genuinely undecided map to `unknown` on
// purpose: it isn't in CONCLUSIVE_STATUSES, so the cascade falls through to
// Tier 2 (DeBounce) instead of the pipeline accepting a non-answer.
const RESPONSE_MAP: Record<string, { status: EmailStatus; confidence: number }> = {
  ok: { status: EmailStatus.valid, confidence: 0.95 },
  fail: { status: EmailStatus.invalid, confidence: 0.95 },
  invalid: { status: EmailStatus.invalid, confidence: 0.95 },
  syntax_error: { status: EmailStatus.invalid, confidence: 0.98 },
  email_disabled: { status: EmailStatus.invalid, confidence: 0.9 },
  domain_error: { status: EmailStatus.invalid, confidence: 0.9 },
  dead_server: { status: EmailStatus.invalid, confidence: 0.9 },
  invalid_mx: { status: EmailStatus.no_mx, confidence: 0.95 },
  dns_error: { status: EmailStatus.no_mx, confidence: 0.9 },
  ok_for_all: { status: EmailStatus.catch_all, confidence: 0.5 },
  accept_all: { status: EmailStatus.catch_all, confidence: 0.5 },
  disposable: { status: EmailStatus.disposable, confidence: 0.95 },
  role: { status: EmailStatus.role_account, confidence: 0.8 },
  // Mailbox sits behind an anti-spam gateway or greylisting: the probe was
  // refused, not answered. Undecided, so hand it to Tier 2.
  antispam_system: { status: EmailStatus.unknown, confidence: 0.3 },
  attempt_rejected: { status: EmailStatus.unknown, confidence: 0.3 },
  smtp_protocol: { status: EmailStatus.unknown, confidence: 0.3 },
  relay_error: { status: EmailStatus.unknown, confidence: 0.3 },
  unknown_email: { status: EmailStatus.unknown, confidence: 0.3 },
  unknown: { status: EmailStatus.unknown, confidence: 0.3 },
};

// EmailListVerify's "error" response is a generic/transient failure (e.g. a
// bad request or a momentary upstream hiccup) and does NOT mean the account
// is out of credits — only "error_credit" does. Disabling the provider on
// every "error" was effectively a permanent outage after a single bad call.
// Instead, only "error_credit" trips the breaker, and it self-heals after a
// TTL instead of requiring a process restart.
const CREDITS_EXHAUSTED_TTL_MS = 10 * 60 * 1000; // 10 minutes
let creditsExhaustedUntil = 0;

export class EmailListVerifyProvider implements EmailVerificationProvider {
  name = "emaillistverify";
  cost_per_email = 0.0004;
  method = VerificationMethod.emaillistverify;

  is_configured(): boolean {
    return !!config.emaillistverify_api_key;
  }

  async verify(email: string): Promise<VerificationResult> {
    const base: VerificationResult = {
      email,
      status: EmailStatus.unknown,
      confidence: 0.3,
      method: this.method,
      pattern: null,
      domain_info: null,
      serp_info: null,
      permutations_tried: 0,
      cost_usd: 0,
      duration_ms: 0,
    };

    if (Date.now() < creditsExhaustedUntil) return base;

    try {
      const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(config.emaillistverify_api_key)}&email=${encodeURIComponent(email)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      const text = (await response.text()).trim().toLowerCase();

      if (text === "error_credit") {
        creditsExhaustedUntil = Date.now() + CREDITS_EXHAUSTED_TTL_MS;
        return base;
      }

      // Generic "error" is transient — don't disable the provider, just
      // report unknown for this call.
      if (text === "error") {
        return base;
      }

      // An unrecognized body (an HTML error page, a new status string) is not a
      // verdict. Charging for it is how a broken provider kept reporting a cost
      // per call while returning nothing usable.
      const mapped = RESPONSE_MAP[text];
      if (!mapped) {
        console.error(`EmailListVerify returned an unrecognized status: ${text.slice(0, 80)}`);
        return base;
      }

      return {
        ...base,
        status: mapped.status,
        confidence: mapped.confidence,
        cost_usd: this.cost_per_email,
      };
    } catch {
      return base;
    }
  }
}
