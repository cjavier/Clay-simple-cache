import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: { providerCredit: { findFirst: vi.fn() } },
}));

import {
  nextRunAt,
  shouldCatchUp,
} from "../../src/jobs/credit-check-schedule";

const at = (iso: string) => new Date(iso);

describe("nextRunAt", () => {
  it("picks today's slot when it's still ahead", () => {
    expect(nextRunAt(at("2026-08-21T09:30:00Z"), 14, 0).toISOString()).toBe(
      "2026-08-21T14:00:00.000Z"
    );
  });

  it("rolls to tomorrow once the slot has passed", () => {
    expect(nextRunAt(at("2026-08-21T14:00:01Z"), 14, 0).toISOString()).toBe(
      "2026-08-22T14:00:00.000Z"
    );
  });

  it("rolls forward when called exactly at the slot, so a run can't repeat", () => {
    expect(nextRunAt(at("2026-08-21T14:00:00Z"), 14, 0).toISOString()).toBe(
      "2026-08-22T14:00:00.000Z"
    );
  });

  it("crosses the month boundary", () => {
    expect(nextRunAt(at("2026-08-31T23:00:00Z"), 14, 0).toISOString()).toBe(
      "2026-09-01T14:00:00.000Z"
    );
  });

  it("crosses the year boundary", () => {
    expect(nextRunAt(at("2026-12-31T20:00:00Z"), 14, 0).toISOString()).toBe(
      "2027-01-01T14:00:00.000Z"
    );
  });

  it("honors a non-zero minute", () => {
    expect(nextRunAt(at("2026-08-21T14:20:00Z"), 14, 30).toISOString()).toBe(
      "2026-08-21T14:30:00.000Z"
    );
  });

  it("always lands in the future", () => {
    for (const h of [0, 6, 13, 14, 23]) {
      const now = at("2026-08-21T14:00:00Z");
      expect(nextRunAt(now, h, 0).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("shouldCatchUp", () => {
  // A deploy resets the timer, so without catch-up a restart near the slot
  // would skip that day's check entirely and look like coverage.
  it("runs when the slot passed and nothing was recorded today", () => {
    expect(
      shouldCatchUp(at("2026-08-20T14:00:05Z"), at("2026-08-21T15:00:00Z"), 14, 0)
    ).toBe(true);
  });

  it("does not run when today's check already happened", () => {
    expect(
      shouldCatchUp(at("2026-08-21T14:00:05Z"), at("2026-08-21T15:00:00Z"), 14, 0)
    ).toBe(false);
  });

  it("does not run before the slot, even with no check today", () => {
    expect(
      shouldCatchUp(at("2026-08-20T14:00:05Z"), at("2026-08-21T09:00:00Z"), 14, 0)
    ).toBe(false);
  });

  it("runs on a fresh database once the slot has passed", () => {
    expect(shouldCatchUp(null, at("2026-08-21T15:00:00Z"), 14, 0)).toBe(true);
  });

  it("waits on a fresh database while the slot is still ahead", () => {
    expect(shouldCatchUp(null, at("2026-08-21T09:00:00Z"), 14, 0)).toBe(false);
  });

  it("doesn't re-run for a check recorded one second after the slot", () => {
    expect(
      shouldCatchUp(at("2026-08-21T14:00:01Z"), at("2026-08-21T23:59:00Z"), 14, 0)
    ).toBe(false);
  });

  it("does re-run for a check recorded one second before the slot", () => {
    expect(
      shouldCatchUp(at("2026-08-21T13:59:59Z"), at("2026-08-21T14:01:00Z"), 14, 0)
    ).toBe(true);
  });

  // Restart storms are the common case on a deploy-heavy day: the first boot
  // after the slot catches up, and every boot after that must stay quiet.
  it("catches up only once across repeated restarts", () => {
    const now = at("2026-08-21T15:00:00Z");
    expect(shouldCatchUp(at("2026-08-20T14:00:00Z"), now, 14, 0)).toBe(true);
    // ...that run records a check, so the next boot sees it and does nothing.
    expect(shouldCatchUp(at("2026-08-21T15:00:02Z"), now, 14, 0)).toBe(false);
  });
});
