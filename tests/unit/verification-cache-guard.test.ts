import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("../../src/db/prisma", () => ({ default: { verificationCache: db } }));

import { cacheVerification } from "../../src/email-finder/cache";

describe("cacheVerification: an unknown never covers a conclusive verdict (2026-10-14)", () => {
  beforeEach(() => { db.findUnique.mockReset(); db.upsert.mockReset(); });

  it("keeps a valid that has not expired", async () => {
    db.findUnique.mockResolvedValue({ email: "a@acme.mx", status: "valid", expires_at: new Date(Date.now() + 86_400_000) });
    await cacheVerification("a@acme.mx", "unknown", 0.3, "emaillistverify");
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("writes the unknown over an expired verdict, or when there is none", async () => {
    db.findUnique.mockResolvedValue({ email: "a@acme.mx", status: "catch_all", expires_at: new Date(Date.now() - 1000) });
    await cacheVerification("a@acme.mx", "unknown", 0.3, "emaillistverify");
    db.findUnique.mockResolvedValue(null);
    await cacheVerification("b@acme.mx", "unknown", 0.3, "debounce");
    expect(db.upsert).toHaveBeenCalledTimes(2);
    expect(db.upsert.mock.calls[1][0].create).toMatchObject({ status: "unknown", method: "debounce" });
  });

  it("a conclusive verdict always replaces what is there", async () => {
    await cacheVerification("a@acme.mx", "invalid", 0.95, "debounce");
    expect(db.findUnique).not.toHaveBeenCalled();
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });
});
