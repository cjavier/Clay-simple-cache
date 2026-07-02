import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma before importing the service (checkDomain hits the DB).
vi.mock("../../src/db/prisma", () => ({
  default: {
    dncEntry: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

import { dncService } from "../../src/services/dnc.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

describe("dncService.prepareEntry", () => {
  describe("individual list", () => {
    it("accepts and normalizes an email", () => {
      expect(dncService.prepareEntry("  John@Acme.COM ", "individual")).toEqual({
        list_type: "individual",
        email: "john@acme.com",
        domain: null,
      });
    });

    it("rejects a bare domain (not an email)", () => {
      expect(dncService.prepareEntry("acme.com", "individual")).toBeNull();
    });

    it("rejects a malformed email", () => {
      expect(dncService.prepareEntry("john@localhost", "individual")).toBeNull();
    });

    it("rejects empty input", () => {
      expect(dncService.prepareEntry("   ", "individual")).toBeNull();
    });
  });

  describe("domain list", () => {
    it("accepts and normalizes a bare domain", () => {
      expect(dncService.prepareEntry("https://www.Acme.com/", "domain")).toEqual({
        list_type: "domain",
        email: null,
        domain: "acme.com",
      });
    });

    it("decomposes an email: blocks the domain and keeps the original email", () => {
      expect(dncService.prepareEntry("John@Acme.com", "domain")).toEqual({
        list_type: "domain",
        email: "john@acme.com",
        domain: "acme.com",
      });
    });

    it("handles subdomains in emails", () => {
      expect(dncService.prepareEntry("jane@mail.acme.com", "domain")).toEqual({
        list_type: "domain",
        email: "jane@mail.acme.com",
        domain: "mail.acme.com",
      });
    });

    it("rejects an invalid domain", () => {
      expect(dncService.prepareEntry("localhost", "domain")).toBeNull();
    });
  });
});

describe("dncService.checkDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes the input domain before querying and reports a domain match", async () => {
    mockPrisma.dncEntry.findFirst.mockResolvedValueOnce({
      id: "1",
      client_id: "client-1",
      list_type: "domain",
      email: null,
      domain: "acme.com",
    });

    const result = await dncService.checkDomain("client-1", "https://www.Acme.com/");

    expect(mockPrisma.dncEntry.findFirst).toHaveBeenCalledWith({
      where: { client_id: "client-1", domain: "acme.com" },
    });
    expect(result).toEqual({ do_not_contact: true, matched_by: "domain" });
  });

  it("returns do_not_contact: false when no matching entry exists", async () => {
    mockPrisma.dncEntry.findFirst.mockResolvedValueOnce(null);

    const result = await dncService.checkDomain("client-1", "notblocked.com");

    expect(result).toEqual({ do_not_contact: false, matched_by: null });
  });

  it("returns do_not_contact: false without querying the DB for an invalid domain", async () => {
    const result = await dncService.checkDomain("client-1", "not a domain");

    expect(result).toEqual({ do_not_contact: false, matched_by: null });
    expect(mockPrisma.dncEntry.findFirst).not.toHaveBeenCalled();
  });
});
