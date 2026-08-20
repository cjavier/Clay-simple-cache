import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    $queryRaw: vi.fn(),
    providerCredit: { createMany: vi.fn() },
  },
}));

import {
  checkAllCredits,
  worstStatus,
  getPreviousStatuses,
  CreditCheck,
  CreditStatus,
} from "../../src/services/credit-monitor.service";
import { shouldNotify, sendCreditAlert } from "../../src/services/slack.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

function check(
  provider: string,
  status: CreditStatus,
  extra: Partial<CreditCheck> = {}
): CreditCheck {
  return {
    provider,
    label: provider,
    impact: "test",
    status,
    balance: 100,
    unit: "credits",
    days_left: 30,
    error: null,
    raw: {},
    ...extra,
  };
}

function report(checks: CreditCheck[]) {
  return {
    checks,
    worst: worstStatus(checks),
    burn: { searches: 1000, verifications: 5000 },
    checked_at: new Date("2026-08-20T12:00:00Z"),
  };
}

describe("worstStatus", () => {
  it("is green only when everything is green", () => {
    expect(worstStatus([check("a", "green"), check("b", "green")])).toBe("green");
  });

  it("reports yellow over green", () => {
    expect(worstStatus([check("a", "green"), check("b", "yellow")])).toBe("yellow");
  });

  it("reports red over yellow — the worst provider decides", () => {
    expect(
      worstStatus([check("a", "green"), check("b", "yellow"), check("c", "red")])
    ).toBe("red");
  });

  it("is green for an empty list", () => {
    expect(worstStatus([])).toBe("green");
  });
});

describe("shouldNotify", () => {
  it("stays quiet when everything is green and unchanged", () => {
    const prev = new Map<string, CreditStatus>([["a", "green"]]);
    const { notify, changes } = shouldNotify(report([check("a", "green")]), prev);
    expect(notify).toBe(false);
    expect(changes).toEqual([]);
  });

  it("alerts every run while a provider is red", () => {
    const prev = new Map<string, CreditStatus>([["a", "red"]]);
    const { notify, changes } = shouldNotify(report([check("a", "red")]), prev);
    expect(notify).toBe(true);
    // Same status as before, so it's a standing alert, not a transition.
    expect(changes).toEqual([]);
  });

  it("alerts on recovery even though the new state is green", () => {
    const prev = new Map<string, CreditStatus>([["a", "red"]]);
    const { notify, changes } = shouldNotify(report([check("a", "green")]), prev);
    expect(notify).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("AGOTADO");
    expect(changes[0]).toContain("OK");
  });

  it("reports a degradation as a change", () => {
    const prev = new Map<string, CreditStatus>([["a", "green"]]);
    const { changes } = shouldNotify(report([check("a", "yellow")]), prev);
    expect(changes[0]).toContain("BAJO");
  });

  it("treats a first-ever run as not-a-change", () => {
    const { notify, changes } = shouldNotify(
      report([check("a", "green")]),
      new Map()
    );
    expect(changes).toEqual([]);
    expect(notify).toBe(false);
  });
});

describe("sendCreditAlert", () => {
  it("refuses to post without a token", async () => {
    const res = await sendCreditAlert(report([check("a", "red")]), {
      token: "",
      channel: "C123",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SLACK_TOKEN");
  });

  it("refuses to post without a channel", async () => {
    const res = await sendCreditAlert(report([check("a", "red")]), {
      token: "xoxb-test",
      channel: "",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SLACK_ALERT_CHANNEL");
  });
});

describe("checkAllCredits — provider classification", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { searches: 30000n, verifications: 30000n },
    ]); // 1000/day of each
    process.env.EMAILLISTVERIFY_API_KEY = "k";
    process.env.DEBOUNCE_API_KEY = "k";
    process.env.SERPER_API_KEY = "k";
    process.env.DEEPSEEK_API_KEY = "k";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(routes: Record<string, unknown>) {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const key = Object.keys(routes).find((k) => u.includes(k));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(key ? routes[key] : {}),
      } as any;
    }) as any;
  }

  it("marks a zero balance red regardless of burn rate", async () => {
    stubFetch({
      "emaillistverify.com": { onDemand: { available: 0 }, subscription: null },
      "debounce.io": { balance: "50000", success: "1" },
      "serper.dev": { balance: 50000, rateLimit: 50 },
      "deepseek.com": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "50.00" }] },
    });
    const r = await checkAllCredits();
    const elv = r.checks.find((c) => c.provider === "emaillistverify")!;
    expect(elv.status).toBe("red");
    expect(elv.balance).toBe(0);
    expect(r.worst).toBe("red");
  });

  it("treats an auth error as red, not as unknown-and-fine", async () => {
    stubFetch({
      "emaillistverify.com": { onDemand: { available: 50000 } },
      "debounce.io": { debounce: { error: "Wrong API", code: "0" }, success: "0" },
      "serper.dev": { balance: 50000 },
      "deepseek.com": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "50.00" }] },
    });
    const r = await checkAllCredits();
    const deb = r.checks.find((c) => c.provider === "debounce")!;
    expect(deb.status).toBe("red");
    expect(deb.error).toBe("Wrong API");
    expect(deb.balance).toBeNull();
  });

  it("classifies by runway: 5 days of credits is yellow, 50 is green", async () => {
    stubFetch({
      // 1000 verifications/day burn -> 5,000 credits = 5 days
      "emaillistverify.com": { onDemand: { available: 5000 } },
      "debounce.io": { balance: "50000", success: "1" },
      "serper.dev": { balance: 50000 },
      "deepseek.com": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "50.00" }] },
    });
    const r = await checkAllCredits();
    expect(r.checks.find((c) => c.provider === "emaillistverify")!.status).toBe("yellow");
    expect(r.checks.find((c) => c.provider === "debounce")!.status).toBe("green");
  });

  it("uses absolute USD floors for DeepSeek, whose burn we don't log", async () => {
    stubFetch({
      "emaillistverify.com": { onDemand: { available: 50000 } },
      "debounce.io": { balance: "50000", success: "1" },
      "serper.dev": { balance: 50000 },
      "deepseek.com": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "12.00" }] },
    });
    const r = await checkAllCredits();
    const ds = r.checks.find((c) => c.provider === "deepseek")!;
    expect(ds.status).toBe("yellow"); // under $20, over $5
    expect(ds.unit).toBe("usd");
    expect(ds.days_left).toBeNull();
  });

  it("marks a missing API key red instead of silently skipping it", async () => {
    process.env.SERPER_API_KEY = "";
    stubFetch({
      "emaillistverify.com": { onDemand: { available: 50000 } },
      "debounce.io": { balance: "50000", success: "1" },
      "deepseek.com": { is_available: true, balance_infos: [{ currency: "USD", total_balance: "50.00" }] },
    });
    const r = await checkAllCredits();
    const serper = r.checks.find((c) => c.provider === "serper")!;
    expect(serper.status).toBe("red");
    expect(serper.error).toContain("no configurada");
  });

  it("marks an unreachable provider red rather than assuming it's fine", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await checkAllCredits();
    expect(r.checks.every((c) => c.status === "red")).toBe(true);
    expect(r.worst).toBe("red");
  });
});

describe("getPreviousStatuses", () => {
  it("returns an empty map when the table isn't there yet", async () => {
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error("relation does not exist"));
    const prev = await getPreviousStatuses();
    expect(prev.size).toBe(0);
  });

  it("maps the latest status per provider", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { provider: "serper", status: "green" },
      { provider: "debounce", status: "red" },
    ]);
    const prev = await getPreviousStatuses();
    expect(prev.get("serper")).toBe("green");
    expect(prev.get("debounce")).toBe("red");
  });
});
