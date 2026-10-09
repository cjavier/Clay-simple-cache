import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: { tableJobBatch: { update: vi.fn() } },
}));
vi.mock("../../src/services/mailbridge.client", async (orig) => {
  const actual = await orig<typeof import("../../src/services/mailbridge.client")>();
  return { ...actual, mailbridge: { upsertRows: vi.fn() } };
});

import prisma from "../../src/db/prisma";
import { mailbridge, MailBridgeError } from "../../src/services/mailbridge.client";
import { send } from "../../src/services/table-job.service";

const update = (prisma as any).tableJobBatch.update as ReturnType<typeof vi.fn>;
const upsert = (mailbridge as any).upsertRows as ReturnType<typeof vi.fn>;
const rows = [{ ref: "li:x", data: { Email: "a@b.mx" }, sources: { Email: "blitzapi" } }];

beforeEach(() => {
  update.mockReset().mockResolvedValue({});
  upsert.mockReset();
});

describe("table batch sender", () => {
  it("marks the batch sent with MailBridge's counts", async () => {
    upsert.mockResolvedValue({ inserted: 1, updated: 0, rowCount: 1 });
    await send("b1", "people", "t1", rows, 1);
    expect(upsert).toHaveBeenCalledWith("t1", rows);
    expect(update.mock.calls[0][0].data).toMatchObject({ status: "sent", inserted: 1, updated: 0, error: null });
  });

  it("MailBridge down (5xx / no answer / 429) goes back to pending with backoff", async () => {
    for (const status of [502, 0, 429]) {
      update.mockClear();
      upsert.mockRejectedValue(new MailBridgeError("down", status));
      const before = Date.now();
      await send("b1", "people", "t1", rows, 1);
      const data = update.mock.calls[0][0].data;
      expect(data.status).toBe("pending");
      expect(data.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 5000);
    }
  });

  it("a 4xx is the payload's fault: retrying won't help, so it fails at once", async () => {
    upsert.mockRejectedValue(new MailBridgeError("HTTP 400: rows.0.ref", 400));
    await send("b1", "people", "t1", rows, 1);
    expect(update.mock.calls[0][0].data).toMatchObject({ status: "failed" });
    expect(update.mock.calls[0][0].data.error).toContain("rows.0.ref");
  });

  it("gives up after the last attempt even if MailBridge is still down", async () => {
    upsert.mockRejectedValue(new MailBridgeError("down", 503));
    await send("b1", "people", "t1", rows, 8);
    expect(update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("a job without a table for that kind fails instead of looping", async () => {
    await send("b1", "people", undefined, rows, 1);
    expect(upsert).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.status).toBe("failed");
  });
});
