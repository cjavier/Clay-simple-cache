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
  invalid_syntax: { status: EmailStatus.invalid, confidence: 0.98 },
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

// EmailListVerify answers its rate limit with HTTP 429 and a JSON body
// ({"id":"api_too_many_requests",...}). That body is not a status, and on
// 2026-10-13 460 of them were flattened to `unknown` in one list. Back off and
// retry; if it is still throttled, say so (verification_error) instead.
const MAX_ATTEMPTS = Number(process.env.ELV_MAX_ATTEMPTS || 4);
const BACKOFF_MS = [1000, 3000, 8000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isThrottled(status: number, text: string): boolean {
  return status === 429 || /too_?many_?requests|"statuscode":\s*429/.test(text);
}

function retryAfterMs(response: Response, attempt: number): number {
  const s = Number(response.headers.get("retry-after"));
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 30_000);
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

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

    if (Date.now() < creditsExhaustedUntil) return { ...base, verification_error: "provider_error" };

    try {
      const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(config.emaillistverify_api_key)}&email=${encodeURIComponent(email)}`;
      let response: Response | null = null;
      let text = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          response = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        text = (await response.text()).trim().toLowerCase();
        if (!isThrottled(response.status, text)) break;
        if (attempt === MAX_ATTEMPTS) {
          console.error(`EmailListVerify throttled the request after ${MAX_ATTEMPTS} attempts (HTTP 429)`);
          return { ...base, verification_error: "rate_limited" };
        }
        await sleep(retryAfterMs(response, attempt));
      }

      if (text === "error_credit") {
        creditsExhaustedUntil = Date.now() + CREDITS_EXHAUSTED_TTL_MS;
        return { ...base, verification_error: "provider_error" };
      }

      // Generic "error" is transient — don't disable the provider, just
      // report unknown for this call.
      if (text === "error") {
        return { ...base, verification_error: "provider_error" };
      }

      // An unrecognized body (an HTML error page, a new status string) is not a
      // verdict. Charging for it is how a broken provider kept reporting a cost
      // per call while returning nothing usable.
      const mapped = RESPONSE_MAP[text];
      if (!mapped) {
        console.error(`EmailListVerify returned an unrecognized status: ${text.slice(0, 80)}`);
        return { ...base, verification_error: "provider_error" };
      }

      return {
        ...base,
        status: mapped.status,
        confidence: mapped.confidence,
        cost_usd: this.cost_per_email,
      };
    } catch {
      return { ...base, verification_error: "provider_error" };
    }
  }
}
