import { describe, it, expect } from "vitest";
import { emailWaterfallColumn, EMAIL_WATERFALL_KEY } from "../../src/services/email-waterfall";

describe("emailWaterfallColumn", () => {
  it("Prospeo → Findymail → Clay, in that order, on rows without an email", () => {
    const c = emailWaterfallColumn("function:t_test");
    expect(c.key).toBe(EMAIL_WATERFALL_KEY);
    expect(c.kind).toBe("enrichment");
    expect(c.config.providers.map((p) => p.id)).toEqual(["prospeo", "findymail", "clay"]);
    expect(c.config.providers[2]).toMatchObject({ op: "routine", routineId: "function:t_test" });
    expect(c.runCondition).toEqual([{ filters: [{ columnKey: "email", operator: "empty" }] }]);
  });

  it("feeds the Clay function its own input names from the people row keys", () => {
    const { inputs } = emailWaterfallColumn().config;
    expect(inputs).toMatchObject({
      "First name": "{{first_name}}",
      "Last name": "{{last_name}}",
      "Full Name": "{{full_name}}",
      "Company Domain": "{{domain}}",
      "Company Name": "{{company}}",
      linkedin_url: "{{linkedin_profile}}",
    });
  });
});
