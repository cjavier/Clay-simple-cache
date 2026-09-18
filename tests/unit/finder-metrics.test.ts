import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    finderMetric: { upsert: vi.fn() },
    profiles: {},
    $queryRaw: vi.fn(),
  },
}));

import prisma from "../../src/db/prisma";
import {
  persistQualityReport,
  QualityReport,
} from "../../src/services/finder-quality.service";
import { isKnownAddress } from "../../src/email-finder/known-emails";

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.finderMetric.upsert.mockResolvedValue({});
});

function report(over: Partial<QualityReport> = {}): QualityReport {
  return {
    window_days: 7,
    sampled: 1500,
    by_status: {
      valid: {
        answered: 600,
        comparable: 500,
        agreed: 478,
        agreement_rate: 0.956,
        delivered: 590,
        delivery_rate: 0.983,
      },
      catch_all: {
        answered: 900,
        comparable: 400,
        agreed: 330,
        agreement_rate: 0.825,
        delivered: 880,
        delivery_rate: 0.978,
      },
    },
    latency: { p50_ms: 1800, p90_ms: 9000, over_2min_pct: 0.01 },
    volume: { searches: 4200, api_calls: 7100, cost_usd: 6.35 },
    ...over,
  };
}

describe("persistQualityReport", () => {
  it("writes one row per verdict plus an _overall row", async () => {
    await persistQualityReport(report());
    expect(mockPrisma.finderMetric.upsert).toHaveBeenCalledTimes(3);
    const statuses = mockPrisma.finderMetric.upsert.mock.calls.map(
      (c: any[]) => c[0].where.measured_on_window_days_status.status
    );
    expect(statuses.sort()).toEqual(["_overall", "catch_all", "valid"]);
  });

  it("keeps the two verdicts apart instead of averaging them", async () => {
    // The whole point: 95.6% and 82.5% must never collapse into one number.
    await persistQualityReport(report());
    const byStatus = Object.fromEntries(
      mockPrisma.finderMetric.upsert.mock.calls.map((c: any[]) => [
        c[0].where.measured_on_window_days_status.status,
        c[0].create,
      ])
    );
    expect(byStatus.valid.agreement_rate).toBeCloseTo(0.956);
    expect(byStatus.catch_all.agreement_rate).toBeCloseTo(0.825);
  });

  it("puts cost and latency on the _overall row so a chart needs one query", async () => {
    await persistQualityReport(report());
    const overall = mockPrisma.finderMetric.upsert.mock.calls
      .map((c: any[]) => c[0].create)
      .find((r: any) => r.status === "_overall");
    expect(overall).toMatchObject({
      searches: 4200,
      api_calls: 7100,
      cost_usd: 6.35,
      p50_ms: 1800,
      p90_ms: 9000,
    });
  });

  it("dates the snapshot at UTC midnight so re-running a day overwrites it", async () => {
    await persistQualityReport(report());
    const day = mockPrisma.finderMetric.upsert.mock.calls[0][0].where
      .measured_on_window_days_status.measured_on as Date;
    expect(day.getUTCHours()).toBe(0);
    expect(day.getUTCMinutes()).toBe(0);
    expect(day.getUTCSeconds()).toBe(0);
    expect(day.getUTCMilliseconds()).toBe(0);
  });

  it("does not throw when one row fails to write", async () => {
    // A monitor that takes the daily job down with it is worse than a gap.
    mockPrisma.finderMetric.upsert.mockRejectedValueOnce(new Error("conflict"));
    await expect(persistQualityReport(report())).resolves.toBeUndefined();
  });

  it("records an empty window without inventing rates", async () => {
    await persistQualityReport(
      report({
        sampled: 0,
        by_status: {},
        latency: { p50_ms: null, p90_ms: null, over_2min_pct: null },
        volume: { searches: 0, api_calls: 0, cost_usd: 0 },
      })
    );
    const overall = mockPrisma.finderMetric.upsert.mock.calls[0][0].create;
    expect(overall.status).toBe("_overall");
    expect(overall.p50_ms).toBeNull();
    expect(overall.agreement_rate).toBeNull();
  });
});

describe("isKnownAddress", () => {
  it("is true when the address is already in profiles", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ one: 1 }]);
    expect(await isKnownAddress("Rlozano@CtsCorp.com")).toBe(true);
  });

  it("is false when it is not", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    expect(await isKnownAddress("nobody@acme.com")).toBe(false);
  });

  it("treats a database failure as a miss rather than an error", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("down"));
    expect(await isKnownAddress("a@b.com")).toBe(false);
  });
});
