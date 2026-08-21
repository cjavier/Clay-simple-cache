import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailListVerifyProvider } from "../../src/email-finder/providers/emaillistverify";
import { DebounceProvider } from "../../src/email-finder/providers/debounce";
import { EmailStatus, VerificationMethod } from "../../src/email-finder/types";

// Mock config
vi.mock("../../src/email-finder/config", () => ({
  config: {
    emaillistverify_api_key: "test-key",
    debounce_api_key: "test-key",
    serper_api_key: "test-key",
    max_permutations_to_try: 15,
    domain_cache_ttl: 604800,
    verification_cache_ttl: 2592000,
  },
}));

describe("EmailListVerifyProvider", () => {
  let provider: EmailListVerifyProvider;

  beforeEach(() => {
    provider = new EmailListVerifyProvider();
    vi.restoreAllMocks();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("emaillistverify");
    expect(provider.cost_per_email).toBe(0.0004);
    expect(provider.method).toBe(VerificationMethod.emaillistverify);
  });

  it("is_configured returns true when key is set", () => {
    expect(provider.is_configured()).toBe(true);
  });

  it("maps 'ok' to valid status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("ok"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.valid);
    expect(result.confidence).toBe(0.95);
    expect(result.cost_usd).toBe(0.0004);
  });

  it("maps 'fail' to invalid status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("fail"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.invalid);
    expect(result.confidence).toBe(0.95);
  });

  it("maps 'ok_for_all' to catch_all status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("ok_for_all"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.catch_all);
  });

  it("maps 'disposable' correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("disposable"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.disposable);
  });

  it("maps 'role' to role_account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("role"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.role_account);
  });

  it("returns unknown on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
    expect(result.cost_usd).toBe(0);
  });

  it("handles 'email_disabled' response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("email_disabled"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.invalid);
    expect(result.confidence).toBe(0.9);
  });

  describe("credits-exhausted breaker", () => {
    // creditsExhaustedUntil is module-level state, so each test needs a
    // fresh module instance to avoid bleeding into other tests.
    async function freshProvider() {
      vi.resetModules();
      const mod = await import("../../src/email-finder/providers/emaillistverify");
      return new mod.EmailListVerifyProvider();
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a generic 'error' response does NOT disable the provider for subsequent calls", async () => {
      const p = await freshProvider();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ text: () => Promise.resolve("error") })
        .mockResolvedValueOnce({ text: () => Promise.resolve("ok") });
      vi.stubGlobal("fetch", fetchMock);

      const first = await p.verify("test@example.com");
      expect(first.status).toBe(EmailStatus.unknown);

      // Provider must still be enabled: the second call should reach fetch
      // again and reflect its (successful) response, not short-circuit.
      const second = await p.verify("test2@example.com");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(second.status).toBe(EmailStatus.valid);
    });

    it("'error_credit' disables the provider until the TTL elapses", async () => {
      const p = await freshProvider();
      const fetchMock = vi.fn().mockResolvedValue({
        text: () => Promise.resolve("error_credit"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const first = await p.verify("test@example.com");
      expect(first.status).toBe(EmailStatus.unknown);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Immediately after: breaker is open, fetch must not be called again.
      const second = await p.verify("test2@example.com");
      expect(second.status).toBe(EmailStatus.unknown);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance past the TTL (10 minutes) — breaker should reset and the
      // provider should hit the API again.
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      fetchMock.mockResolvedValueOnce({ text: () => Promise.resolve("ok") });

      const third = await p.verify("test3@example.com");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(third.status).toBe(EmailStatus.valid);
    });
  });
});

describe("DebounceProvider", () => {
  let provider: DebounceProvider;

  beforeEach(() => {
    provider = new DebounceProvider();
    vi.restoreAllMocks();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("debounce");
    expect(provider.cost_per_email).toBe(0.0015);
    expect(provider.method).toBe(VerificationMethod.debounce);
  });

  // Codes come from the live API and are authoritative; the four `result`
  // strings collapse distinctions we act on (2 and 3 both say "Invalid",
  // 4 and 8 both say "Risky").
  // https://help.debounce.com/understanding-results/result-codes/
  it.each([
    ["1", "Invalid", EmailStatus.invalid],       // Syntax
    ["2", "Invalid", EmailStatus.invalid],       // Spam trap — must never be sent to
    ["3", "Invalid", EmailStatus.disposable],    // Disposable
    ["4", "Risky", EmailStatus.catch_all],       // Accept-All
    ["5", "Safe to Send", EmailStatus.valid],    // Valid
    ["6", "Invalid", EmailStatus.invalid],       // Bounce
    ["7", "Unknown", EmailStatus.unknown],       // Unreachable
    ["8", "Risky", EmailStatus.role_account],    // Role
  ])("maps code %s (%s) to %s", async (code, resultText, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: resultText, code, email: "test@example.com" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(expected);
    // A verdict means DeBounce spent a credit, "unknown" included.
    expect(result.cost_usd).toBe(0.0015);
  });

  it("falls back to the result string when the code is unrecognized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: "Safe to Send", code: "99" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.valid);
  });

  // Regression: an auth failure arrives as { debounce: { error } } — an object,
  // so a truthiness check lets it through. Charging for it is what made the
  // logged spend fictional while the provider was dead.
  it("charges nothing when DeBounce returns an error object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { error: "Wrong API", code: "0" },
        success: "0",
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
    expect(result.cost_usd).toBe(0);
  });

  it("returns unknown on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
    expect(result.cost_usd).toBe(0);
  });

  it("returns unknown when debounce field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
  });
});

describe("EmailListVerifyProvider — status mapping", () => {
  let elv: EmailListVerifyProvider;
  beforeEach(() => {
    elv = new EmailListVerifyProvider();
  });

  const stub = (text: string) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve(text),
    }));

  it.each([
    ["ok", EmailStatus.valid],
    ["fail", EmailStatus.invalid],
    ["invalid", EmailStatus.invalid],
    ["ok_for_all", EmailStatus.catch_all],
    ["accept_all", EmailStatus.catch_all],
    ["disposable", EmailStatus.disposable],
    ["role", EmailStatus.role_account],
    ["invalid_mx", EmailStatus.no_mx],
    // Observed live and absent from the published docs.
    ["antispam_system", EmailStatus.unknown],
    ["attempt_rejected", EmailStatus.unknown],
  ])("maps %s to %s", async (text, expected) => {
    stub(text);
    const r = await elv.verify("a@b.com");
    expect(r.status).toBe(expected);
    expect(r.cost_usd).toBe(0.0004);
  });

  // Regression: the old fallback charged for any unrecognized body — an HTML
  // error page or a status they added — while reporting a useless "unknown".
  it("charges nothing for an unrecognized status", async () => {
    stub("some_status_we_have_never_seen");
    const r = await elv.verify("a@b.com");
    expect(r.status).toBe(EmailStatus.unknown);
    expect(r.cost_usd).toBe(0);
  });

  it("charges nothing when credits are exhausted", async () => {
    stub("error_credit");
    const r = await elv.verify("a@b.com");
    expect(r.status).toBe(EmailStatus.unknown);
    expect(r.cost_usd).toBe(0);
  });
});

describe("DebounceProvider — concurrency and throttling", () => {
  // Measured live: 3 parallel calls pass, 5 and 8 get HTTP 429. The pipeline
  // verifies 5 permutations at a time, so without a cap here the extra calls
  // came back as silent `unknown` and looked like undeliverable addresses.
  it("never exceeds 3 concurrent calls even when 8 are requested at once", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 12));
      inFlight--;
      return {
        status: 200,
        json: () => Promise.resolve({ debounce: { code: "5", result: "Safe to Send" } }),
      } as any;
    }));

    const provider = new DebounceProvider();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => provider.verify(`u${i}@example.com`))
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.status === EmailStatus.valid)).toBe(true);
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return { status: 429, json: () => Promise.resolve({}) } as any;
      return {
        status: 200,
        json: () => Promise.resolve({ debounce: { code: "5", result: "Safe to Send" } }),
      } as any;
    }));

    const r = await new DebounceProvider().verify("a@b.com");
    expect(calls).toBe(2);
    expect(r.status).toBe(EmailStatus.valid);
    expect(r.cost_usd).toBe(0.0015);
  });

  it("gives up after repeated 429s without charging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 429,
      json: () => Promise.resolve({}),
    } as any)));

    const r = await new DebounceProvider().verify("a@b.com");
    expect(r.status).toBe(EmailStatus.unknown);
    expect(r.cost_usd).toBe(0);
  });

  it("releases its slot when the call throws, so the queue can't deadlock", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const provider = new DebounceProvider();
    // More failures than the concurrency cap: if the slot leaked, this hangs.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => provider.verify("a@b.com"))
    );
    expect(results.every((r) => r.status === EmailStatus.unknown)).toBe(true);
  });
});
