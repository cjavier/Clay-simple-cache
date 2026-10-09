import { describe, it, expect } from "vitest";
import { emailWaterfallColumn, EMAIL_WATERFALL_KEY } from "../../src/services/email-waterfall";

describe("emailWaterfallColumn", () => {
  it("clay_cache lookup (free) → Clay function, on rows without an email", () => {
    const c = emailWaterfallColumn("function:t_test");
    expect(c.key).toBe(EMAIL_WATERFALL_KEY);
    expect(c.kind).toBe("enrichment");
    expect(c.config.providers).toEqual([
      { id: "clay_cache", op: "lookup_email" },
      { id: "clay", op: "routine", routineId: "function:t_test", timeoutMs: 30_000 },
    ]);
    // Prospeo and Findymail now run in this API's build, not in the column.
    expect(c.config.providers.map((p) => p.id)).not.toContain("prospeo");
    expect(c.config.providers.map((p) => p.id)).not.toContain("findymail");
    expect(c.runCondition).toEqual([{ filters: [{ columnKey: "email", operator: "empty" }] }]);
  });

  it("feeds the Clay function its own input names, LinkedIn included", () => {
    const { inputs } = emailWaterfallColumn().config;
    expect(inputs).toMatchObject({
      "First name": "{{first_name}}",
      "Last name": "{{last_name}}",
      "Full Name": "{{full_name}}",
      "Company Domain": "{{domain}}",
      "Company Name": "{{company}}",
      "LinkedIn URL": "{{linkedin_profile}}",
      linkedin_url: "{{linkedin_profile}}",
    });
  });
});
