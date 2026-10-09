import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../../src/db/prisma", () => ({
  default: {
    emailOutcome: { findMany: vi.fn() },
    searchLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("../../src/email-finder/domain-health", () => ({
  checkDomainHealth: vi.fn(async () => ({ muted: false, searches: 0, hits: 0 })),
  recordDomainOutcome: vi.fn(),
}));
vi.mock("../../src/email-finder/domain-intel", () => ({
  analyzeDomain: vi.fn(),
  markDomainCatchAll: vi.fn(),
}));
vi.mock("../../src/email-finder/known-emails", async (orig) => ({
  ...(await orig<typeof import("../../src/email-finder/known-emails")>()),
  getKnownEmailsForDomain: vi.fn(async () => []),
  isKnownAddress: vi.fn(async () => false),
}));
vi.mock("../../src/email-finder/pattern-learner", () => ({
  getDomainPatterns: vi.fn(async () => []),
  saveDomainPattern: vi.fn(),
}));
vi.mock("../../src/email-finder/cache", () => ({
  getCachedVerification: vi.fn(async () => null),
  getCachedVerificationsBatch: vi.fn(async () => new Map()),
  cacheVerification: vi.fn(),
  cacheNegativeVerifications: vi.fn(),
}));
vi.mock("../../src/email-finder/serp-cache", () => ({
  getCachedSerp: vi.fn(async () => ({ emails: [], patterns: [] })),
  cacheSerp: vi.fn(),
}));
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));
vi.mock("../../src/email-finder/providers/emaillistverify", () => ({
  EmailListVerifyProvider: class {
    name = "emaillistverify";
    is_configured() { return true; }
    verify = verifySpy;
  },
}));
vi.mock("../../src/email-finder/providers/debounce", () => ({
  DebounceProvider: class {
    name = "debounce";
    is_configured() { return false; }
    verify = vi.fn();
  },
}));

import prisma from "../../src/db/prisma";
import { analyzeDomain } from "../../src/email-finder/domain-intel";
import { getKnownEmailsForDomain } from "../../src/email-finder/known-emails";
import { getDomainPatterns } from "../../src/email-finder/pattern-learner";
import { findEmail, verifySingleEmail } from "../../src/email-finder/pipeline";
import {
  summarize,
  patternTier,
  rankPatterns,
  buildDomainOutcomes,
  isBadMailDomain,
  mailGateway,
  derivePattern,
} from "../../src/email-finder/outcomes";
import { verifySignature, toOutcomeRows } from "../../src/controllers/mailbridge-webhook.controller";

const mockPrisma = prisma as any;
const DAY = 24 * 3600 * 1000;
const longAgo = new Date(Date.now() - 10 * DAY);

function row(email: string, over: Partial<Record<string, any>> = {}) {
  const [local] = email.split("@");
  const [first, last] = local.includes(".") ? local.split(".") : [local, ""];
  return {
    email,
    pattern: null,
    first_name: first,
    last_name: last,
    linkedin_slug: null,
    bounced_at: null,
    bounce_type: null,
    replied_at: null,
    positive_at: null,
    auto_replied: false,
    first_visible_send_at: null,
    ...over,
  };
}

function domainInfo(over: Partial<Record<string, any>> = {}) {
  return {
    domain: "acme.com",
    has_mx: true,
    mx_records: ["aspmx.l.google.com"],
    provider: "google_workspace",
    is_catch_all: true,
    is_disposable: false,
    is_free_provider: false,
    smtp_verifiable: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.emailOutcome.findMany.mockResolvedValue([]);
  mockPrisma.searchLog.create.mockResolvedValue({});
  (analyzeDomain as any).mockResolvedValue(domainInfo());
  (getKnownEmailsForDomain as any).mockResolvedValue([]);
  (getDomainPatterns as any).mockResolvedValue([]);
  verifySpy.mockResolvedValue({ email: null, status: "unknown", confidence: 0, method: null, cost_usd: 0 });
});

describe("summarize", () => {
  it("calls an address delivered only after the bounce window and only from a visible mailbox", () => {
    const fresh = new Date(Date.now() - 3600 * 1000);
    expect(summarize([row("a@x.com", { first_visible_send_at: fresh })])!.status).toBe("pending");
    expect(summarize([row("a@x.com", { first_visible_send_at: longAgo })])!.status).toBe("delivered");
    expect(summarize([row("a@x.com")])!.status).toBe("pending");
  });

  it("ignores soft bounces and lets the latest of reply and hard bounce win", () => {
    expect(summarize([row("a@x.com", { bounced_at: longAgo, bounce_type: "soft" })])!.status).toBe("pending");
    const may = new Date("2026-05-01"), sep = new Date("2026-09-01");
    expect(summarize([row("a@x.com", { replied_at: may }), row("a@x.com", { bounced_at: sep })])!.status).toBe("bounced");
    expect(summarize([row("a@x.com", { replied_at: sep }), row("a@x.com", { bounced_at: may })])!.status).toBe("replied");
  });

  it("counts an out-of-office as proof the mailbox exists", () => {
    expect(summarize([row("a@x.com", { auto_replied: true })])!.status).toBe("replied");
  });
});

describe("evidence ladder", () => {
  it("tiers patterns by their mail history", () => {
    expect(patternTier({ ok: 2, bad: 0 })).toBe("pattern_confirmed");
    expect(patternTier({ ok: 3, bad: 1 })).toBe("pattern_mostly_ok");
    expect(patternTier({ ok: 1, bad: 1 })).toBe("pattern_contradicted");
    expect(patternTier({ ok: 1, bad: 0 })).toBe("pattern_mostly_ok");
    expect(patternTier({ ok: 0, bad: 0 })).toBeNull();
  });

  it("puts a pattern mail confirmed ahead of one profiles merely holds more of", () => {
    const outcomes = buildDomainOutcomes(
      new Map([
        ["a@x", { email: "a@x", status: "delivered", pattern: "first.last" } as any],
        ["b@x", { email: "b@x", status: "replied", pattern: "first.last" } as any],
        ["c@x", { email: "c@x", status: "bounced", pattern: "flast" } as any],
      ])
    );
    const ranked = rankPatterns([{ pattern: "flast", sample_count: 40 }], outcomes);
    expect(ranked.map((r) => r.pattern)).toEqual(["first.last", "flast"]);
    expect(ranked[1].tier).toBe("pattern_contradicted");
  });

  it("flags a domain where everything bounced and nothing landed", () => {
    const bounces = (n: number) =>
      new Map(Array.from({ length: n }, (_, i) => [`${i}@x`, { email: `${i}@x`, status: "bounced", pattern: null } as any]));
    expect(isBadMailDomain(buildDomainOutcomes(bounces(3)))).toBe(true);
    expect(isBadMailDomain(buildDomainOutcomes(bounces(2)))).toBe(false);
  });

  it("recognizes security gateways from MX records", () => {
    expect(mailGateway(["us-smtp-inbound-1.mimecast.com"])?.name).toBe("mimecast");
    expect(mailGateway(["aspmx.l.google.com"])).toBeNull();
  });

  it("derives the pattern of an address from the name", () => {
    expect(derivePattern("ana.ruiz@acme.com", "Ana", "Ruiz", null)).toBe("first.last");
    expect(derivePattern("rlozano@acme.com", "Roberto", "Martinez", "roberto-lozano-martinez")).toBe("flast");
  });
});

describe("findEmail with mail history", () => {
  it("answers a Google catch-all with the pattern that was delivered, not the one profiles prefers", async () => {
    (getDomainPatterns as any).mockResolvedValue([{ pattern: "flast", confidence: 1, sample_count: 30 }]);
    mockPrisma.emailOutcome.findMany.mockResolvedValue([
      row("ana.ruiz@acme.com", { pattern: "first.last", first_visible_send_at: longAgo }),
      row("luis.diaz@acme.com", { pattern: "first.last", replied_at: longAgo }),
      row("mgomez@acme.com", { pattern: "flast", bounced_at: longAgo, bounce_type: "hard" }),
    ]);
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.email).toBe("juan.perez@acme.com");
    expect(r.status).toBe("catch_all");
    expect(r.send_recommendation).toBe("send");
    expect(r.evidence).toBe("pattern_confirmed");
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("says do_not_send for a catch-all guess resting on one example", async () => {
    (getDomainPatterns as any).mockResolvedValue([{ pattern: "flast", confidence: 1, sample_count: 1 }]);
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.email).toBe("jperez@acme.com");
    expect(r.send_recommendation).toBe("do_not_send");
  });

  it("never serves back a profiles address that bounced", async () => {
    (getKnownEmailsForDomain as any).mockResolvedValue([
      { email: "jperez@acme.com", first: "Juan", last: "Perez", slug_parts: [] },
    ]);
    mockPrisma.emailOutcome.findMany.mockResolvedValue([
      row("jperez@acme.com", { pattern: "flast", bounced_at: longAgo, bounce_type: "hard" }),
    ]);
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.email).not.toBe("jperez@acme.com");
    expect(r.method).not.toBe("known_email");
  });

  it("answers from a delivery without paying for a probe", async () => {
    (analyzeDomain as any).mockResolvedValue(domainInfo({ is_catch_all: false }));
    mockPrisma.emailOutcome.findMany.mockResolvedValue([
      row("jperez@acme.com", { first_name: null, last_name: null, pattern: "flast", first_visible_send_at: longAgo }),
    ]);
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.email).toBe("jperez@acme.com");
    expect(r.method).toBe("mailbridge_outcome");
    expect(r.send_recommendation).toBe("send");
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("never hands one person another person's mailbox", async () => {
    // mariana@ is Mariana Castillo's, delivered; we're looking for Mariana Quiroga.
    (getDomainPatterns as any).mockResolvedValue([{ pattern: "first", confidence: 1, sample_count: 30 }]);
    mockPrisma.emailOutcome.findMany.mockResolvedValue([
      row("mariana@acme.com", { first_name: "Mariana", last_name: "Castillo", pattern: "first", first_visible_send_at: longAgo }),
      row("pedro@acme.com", { first_name: "Pedro", last_name: "Luna", pattern: "first", first_visible_send_at: longAgo }),
    ]);
    const r = await findEmail({ first_name: "Mariana", last_name: "Quiroga", domain: "acme.com" });
    expect(r.email).not.toBe("mariana@acme.com");
    expect(r.method).not.toBe("mailbridge_outcome");
  });

  it("refuses a domain whose mail only ever bounced, before spending", async () => {
    mockPrisma.emailOutcome.findMany.mockResolvedValue(
      ["a.b", "c.d", "e.f"].map((l) => row(`${l}@acme.com`, { bounced_at: longAgo }))
    );
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.status).toBe("unknown");
    expect(r.method).toBe("domain_bounces");
    expect(r.send_recommendation).toBe("do_not_send");
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("lets a Mimecast gateway veto even a confirmed pattern", async () => {
    (analyzeDomain as any).mockResolvedValue(domainInfo({ mx_records: ["eu-smtp-inbound-1.mimecast.com"], provider: "other" }));
    mockPrisma.emailOutcome.findMany.mockResolvedValue([
      row("ana.ruiz@acme.com", { pattern: "first.last", first_visible_send_at: longAgo }),
      row("luis.diaz@acme.com", { pattern: "first.last", first_visible_send_at: longAgo }),
    ]);
    const r = await findEmail({ first_name: "Juan", last_name: "Perez", domain: "acme.com" });
    expect(r.evidence).toBe("pattern_confirmed");
    expect(r.mail_gateway).toBe("mimecast");
    expect(r.send_recommendation).toBe("do_not_send");
  });
});

describe("verifySingleEmail with mail history", () => {
  it("calls a hard-bounced address invalid before any cache or probe", async () => {
    mockPrisma.emailOutcome.findMany.mockResolvedValue([row("jperez@acme.com", { bounced_at: longAgo })]);
    const r = await verifySingleEmail("jperez@acme.com");
    expect(r.status).toBe("invalid");
    expect(r.method).toBe("mailbridge_outcome");
    expect(r.send_recommendation).toBe("do_not_send");
    expect(verifySpy).not.toHaveBeenCalled();
  });
});

describe("MailBridge webhook", () => {
  const secret = "whsec_test";
  const body = Buffer.from(JSON.stringify({ event_type: "email_outcomes", data: { rows: [] } }));
  const sign = (ts: string) =>
    "sha256=" + createHmac("sha256", secret).update(`${ts}.${body.toString()}`).digest("hex");

  it("accepts MailBridge's signature and rejects a tampered or stale one", () => {
    const now = Date.now();
    const ts = String(now);
    expect(verifySignature(secret, ts, body, sign(ts), now)).toBe(true);
    expect(verifySignature("other", ts, body, sign(ts), now)).toBe(false);
    const old = String(now - 2 * 3600 * 1000);
    expect(verifySignature(secret, old, body, sign(old), now)).toBe(false);
    expect(verifySignature(secret, ts, undefined, sign(ts), now)).toBe(false);
  });

  it("maps only human and positive replies to replied_at", () => {
    const [r] = toOutcomeRows([
      { contact_id: "c1", email: "A@X.com", human_replied_at: null, positive_replied_at: null, bounced_at: "2026-10-01T00:00:00Z" },
    ]);
    expect(r).toMatchObject({ source: "mailbridge", source_ref: "c1", replied_at: null, bounced_at: "2026-10-01T00:00:00Z" });
  });
});
