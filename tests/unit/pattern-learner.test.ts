import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma before importing pattern-learner
vi.mock("../../src/db/prisma", () => ({
  default: {
    $executeRaw: vi.fn().mockResolvedValue(1),
    domainPattern: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import prisma from "../../src/db/prisma";
import { saveDomainPattern, getDomainPatterns } from "../../src/email-finder/pattern-learner";

const mockPrisma = prisma as any;

describe("saveDomainPattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a single atomic upsert statement instead of a find-then-write", async () => {
    // The old implementation did findUnique() followed by create()/update(),
    // which races under concurrent calls for the same (domain, pattern) and
    // can throw a P2002 unique constraint violation. The fix must do the
    // whole thing in exactly one DB round trip (an INSERT ... ON CONFLICT
    // upsert), so there is nothing to interleave between a read and a write.
    await saveDomainPattern("acme.com", "first.last");

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);

    const [, ...values] = mockPrisma.$executeRaw.mock.calls[0];
    expect(values).toContain("acme.com");
    expect(values).toContain("first.last");
  });

  it("makes no separate read call before writing", async () => {
    await saveDomainPattern("acme.com", "flast");
    expect(mockPrisma.domainPattern.findMany).not.toHaveBeenCalled();
  });
});

describe("getDomainPatterns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps DB rows into KnownPattern shape", async () => {
    mockPrisma.domainPattern.findMany.mockResolvedValueOnce([
      { domain: "acme.com", pattern: "first.last", confidence: 0.9, sample_count: 3 },
    ]);

    const result = await getDomainPatterns("acme.com");
    expect(result).toEqual([
      { pattern: "first.last", confidence: 0.9, sample_count: 3 },
    ]);
  });
});
