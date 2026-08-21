import {
  EmailVerificationProvider,
  EmailStatus,
  VerificationResult,
  VerificationMethod,
} from "../types";
import { config } from "../config";

/**
 * DeBounce single-email validation (Tier 2).
 *
 * Authentication is `?api=<key>` on `https://api.debounce.io/v1/`. The key is a
 * 13-character alphanumeric token from the dashboard — a longer `public_…` key
 * is the client-side JavaScript credential and the API rejects it with
 * "Authentication Failed - You cannot call the public_api directly from your
 * browser", which reads like a header problem but is really the wrong key.
 *
 * Verdicts are read from the numeric `code`, not the `result` string. The four
 * result strings collapse distinctions we care about: codes 2 (spam trap) and 3
 * (disposable) both report "Invalid", and codes 4 (accept-all) and 8 (role)
 * both report "Risky".
 *
 * https://help.debounce.com/understanding-results/result-codes/
 */

/**
 * DeBounce caps *concurrent* calls, not the request rate: eight strictly
 * sequential calls with no pause all succeed, while five or eight in parallel
 * return HTTP 429 / "Maximum concurrent calls reached". The pipeline verifies 5
 * permutations at a time — fine for Tier 1 — so the cap is enforced here rather
 * than by slowing the whole batch down. Without it, rejected calls came back as
 * silent `unknown` results that were indistinguishable from undeliverable
 * addresses.
 *
 * The cap is per ACCOUNT, so this semaphore can only govern one process. A
 * local run competes with the deployed service for the same slots, which is why
 * the default leaves headroom below the measured ceiling and why throttled
 * attempts back off and retry rather than giving up immediately.
 */
const MAX_CONCURRENT = Number(process.env.DEBOUNCE_MAX_CONCURRENT || 2);
const MAX_ATTEMPTS = 4;

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  waiting.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DeBounce reports the concurrency cap in the body as well as via HTTP 429. */
function isThrottled(status: number, error?: string): boolean {
  return status === 429 || /concurrent|rate limit|too many/i.test(error || "");
}

const CODE_MAP: Record<string, { status: EmailStatus; confidence: number }> = {
  "1": { status: EmailStatus.invalid, confidence: 0.98 }, // Syntax
  // Spam trap. Reported as invalid so it can never be sent to — sending to a
  // trap costs domain reputation, which is worse than losing one address.
  "2": { status: EmailStatus.invalid, confidence: 0.99 },
  "3": { status: EmailStatus.disposable, confidence: 0.95 }, // Disposable
  "4": { status: EmailStatus.catch_all, confidence: 0.5 }, // Accept-All
  "5": { status: EmailStatus.valid, confidence: 0.95 }, // Valid
  "6": { status: EmailStatus.invalid, confidence: 0.95 }, // Invalid / bounce
  "7": { status: EmailStatus.unknown, confidence: 0.3 }, // Unknown / unreachable
  "8": { status: EmailStatus.role_account, confidence: 0.8 }, // Role
};

/** Fallback when a code is absent or unrecognized. */
const RESULT_MAP: Record<string, { status: EmailStatus; confidence: number }> = {
  "safe to send": { status: EmailStatus.valid, confidence: 0.95 },
  invalid: { status: EmailStatus.invalid, confidence: 0.95 },
  risky: { status: EmailStatus.risky, confidence: 0.5 },
  unknown: { status: EmailStatus.unknown, confidence: 0.3 },
};

export class DebounceProvider implements EmailVerificationProvider {
  name = "debounce";
  cost_per_email = 0.0015;
  method = VerificationMethod.debounce;

  is_configured(): boolean {
    return !!config.debounce_api_key;
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

    await acquire();
    try {
      const url = `https://api.debounce.io/v1/?api=${encodeURIComponent(config.debounce_api_key)}&email=${encodeURIComponent(email)}`;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }

        if (isThrottled(response.status)) {
          if (attempt < MAX_ATTEMPTS) {
            await sleep(500 * attempt);
            continue;
          }
          console.error("DeBounce throttled the request after retries (HTTP 429)");
          return base;
        }

        const json = await response.json().catch(() => null);
        const debounce = (json as any)?.debounce;
        if (!debounce) return base;

        // An auth/quota failure arrives as { debounce: { error: "..." } } — an
        // object, so a truthiness check alone lets it through. Charging for it
        // was how a dead provider still reported a cost: $0.0015 per failed
        // call, which is what made the logged spend fictional.
        if (debounce.error) {
          if (isThrottled(response.status, debounce.error) && attempt < MAX_ATTEMPTS) {
            await sleep(500 * attempt);
            continue;
          }
          console.error(`DeBounce rejected the request: ${debounce.error}`);
          return base;
        }

        const code = debounce.code != null ? String(debounce.code) : "";
        const mapped =
          CODE_MAP[code] ??
          RESULT_MAP[String(debounce.result || "").toLowerCase()] ?? {
            status: EmailStatus.unknown,
            confidence: 0.3,
          };

        // A verdict came back, so DeBounce consumed a credit — charge for it
        // even when the verdict is "unknown", because the credit is spent
        // either way.
        return {
          ...base,
          status: mapped.status,
          confidence: mapped.confidence,
          cost_usd: this.cost_per_email,
        };
      }

      return base;
    } catch {
      return base;
    } finally {
      release();
    }
  }
}
