import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ tableId: string; options: unknown }> = [];
vi.mock("../../src/services/mailbridge.client", () => ({
  mailbridge: {
    addEmailCascadeColumns: vi.fn(async (tableId: string, options: unknown) => {
      calls.push({ tableId, options });
      return { columns: [], order: ["email_cache", "email_prospeo", "email_findymail", "email_clay", "email_verificacion", "email"] };
    }),
  },
}));

import { addEmailCascadeColumns, clayEmailRoutineId } from "../../src/services/email-waterfall";

describe("email columns of a new people table (MailBridge spec 109)", () => {
  beforeEach(() => { calls.length = 0; delete process.env.CLAY_EMAIL_ROUTINE_ID; });

  it("asks MailBridge for its email-cascade preset (one definition, there) with the Clay routine", async () => {
    const r = await addEmailCascadeColumns("t-1");
    expect(calls).toEqual([{ tableId: "t-1", options: { clayRoutineId: "function:t_0tmngkoVgNYaHjSNmeY" } }]);
    expect(r).toBe("added: email_cache → email_prospeo → email_findymail → email_clay → email_verificacion → email");
  });

  it("CLAY_EMAIL_ROUTINE_ID overrides the Clay function", () => {
    process.env.CLAY_EMAIL_ROUTINE_ID = "function:t_other";
    expect(clayEmailRoutineId()).toBe("function:t_other");
  });
});
