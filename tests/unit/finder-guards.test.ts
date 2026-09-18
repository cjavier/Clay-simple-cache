import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    domainHealth: { findUnique: vi.fn() },
    serpCache: { findUnique: vi.fn(), upsert: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import prisma from "../../src/db/prisma";
import { checkDomainHealth, recordDomainOutcome } from "../../src/email-finder/domain-health";
import { getCachedSerp, cacheSerp } from "../../src/email-finder/serp-cache";
import { findProblems, THRESHOLDS } from "../../src/jobs/quality-check";
import type { QualityReport } from "../../src/services/finder-quality.service";

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$executeRaw.mockResolvedValue(1);
});

describe("domain circuit breaker", () => {
  it("treats an unseen domain as healthy", async () => {
    mockPrisma.domainHealth.findUnique.mockResolvedValue(null);
    expect(await checkDomainHealth("acme.com")).toEqual({ muted: false, searches: 0, hits: 0 });
  });

  it("reports a domain muted while the mute is in the future", async () => {
    mockPrisma.domainHealth.findUnique.mockResolvedValue({
      searches: 549,
      hits: 0,
      muted_until: new Date(Date.now() + 60_000),
    });
    // banorte.com.mx: 549 searches, 0 results, $10.98.
    expect((await checkDomainHealth("banorte.com.mx")).muted).toBe(true);
  });

  it("re-opens a domain once the mute has expired", async () => {
    mockPrisma.domainHealth.findUnique.mockResolvedValue({
      searches: 549,
      hits: 0,
      muted_until: new Date(Date.now() - 60_000),
    });
    // The breaker is a mute, not a blacklist — a company can change its mail.
    expect((await checkDomainHealth("banorte.com.mx")).muted).toBe(false);
  });

  it("never fails a search because the health table is unreadable", async () => {
    mockPrisma.domainHealth.findUnique.mockRejectedValue(new Error("no such table"));
    expect(await checkDomainHealth("acme.com")).toEqual({ muted: false, searches: 0, hits: 0 });
  });

  it("records a hit and a miss without throwing", async () => {
    await expect(recordDomainOutcome("acme.com", true)).resolves.toBeUndefined();
    await expect(recordDomainOutcome("acme.com", false)).resolves.toBeUndefined();
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("swallows a bookkeeping failure", async () => {
    mockPrisma.$executeRaw.mockRejectedValue(new Error("deadlock"));
    await expect(recordDomainOutcome("acme.com", false)).resolves.toBeUndefined();
  });
});

describe("SERP cache", () => {
  it("returns nothing when the entry has expired", async () => {
    mockPrisma.serpCache.findUnique.mockResolvedValue({
      emails: ["a@acme.com"],
      patterns: [],
      expires_at: new Date(Date.now() - 1000),
    });
    expect(await getCachedSerp("acme.com")).toBeNull();
  });

  it("returns a live entry", async () => {
    mockPrisma.serpCache.findUnique.mockResolvedValue({
      emails: ["ana.ruiz@acme.com"],
      patterns: [{ pattern: "first.last", count: 2, examples: [] }],
      expires_at: new Date(Date.now() + 60_000),
    });
    const cached = await getCachedSerp("acme.com");
    expect(cached?.emails).toEqual(["ana.ruiz@acme.com"]);
    expect(cached?.patterns[0].pattern).toBe("first.last");
  });

  it("treats a read failure as a miss rather than an error", async () => {
    mockPrisma.serpCache.findUnique.mockRejectedValue(new Error("down"));
    expect(await getCachedSerp("acme.com")).toBeNull();
  });

  it("does not throw when the write fails", async () => {
    mockPrisma.serpCache.upsert.mockRejectedValue(new Error("down"));
    await expect(cacheSerp("acme.com", [], [])).resolves.toBeUndefined();
  });
});

function report(partial: Partial<QualityReport>): QualityReport {
  return {
    window_days: 7,
    sampled: 1000,
    by_status: {},
    latency: { p50_ms: 1000, p90_ms: 2000, over_2min_pct: 0 },
    ...partial,
  };
}

const bucket = (over: Partial<QualityReport["by_status"][string]> = {}) => ({
  answered: 500,
  comparable: 200,
  agreed: 190,
  agreement_rate: 0.95,
  delivered: 495,
  delivery_rate: 0.99,
  ...over,
});

describe("quality thresholds", () => {
  it("stays silent when everything is healthy", () => {
    expect(findProblems(report({ by_status: { valid: bucket() } }))).toEqual([]);
  });

  it("flags catch_all precision separately from valid", () => {
    // The exact failure that hid for months: 95.2% and 33.3% under one average.
    const problems = findProblems(
      report({
        by_status: {
          valid: bucket(),
          catch_all: bucket({ agreed: 67, comparable: 200, agreement_rate: 0.333 }),
        },
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("catch_all");
  });

  it("ignores a rate computed from too few comparisons", () => {
    const problems = findProblems(
      report({
        by_status: {
          catch_all: bucket({
            comparable: THRESHOLDS.min_comparable - 1,
            agreed: 1,
            agreement_rate: 0.1,
          }),
        },
      })
    );
    expect(problems).toEqual([]);
  });

  it("flags a median that has drifted past the point of usefulness", () => {
    const problems = findProblems(
      report({ latency: { p50_ms: 1_524_304, p90_ms: 9_000_000, over_2min_pct: 0.74 } })
    );
    expect(problems.some((p) => p.includes("Mediana"))).toBe(true);
  });

  it("flags answers that are produced but never stored", () => {
    const problems = findProblems(
      report({
        by_status: {
          catch_all: bucket({ comparable: 0, agreement_rate: null, delivered: 147, delivery_rate: 0.294 }),
        },
      })
    );
    expect(problems.some((p) => p.includes("profiles"))).toBe(true);
  });
});
