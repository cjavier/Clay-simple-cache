import { Request, Response } from "express";
import prisma from "../db/prisma";
import { checkAllCredits } from "../services/credit-monitor.service";

export const creditsController = {
  /**
   * Live balance of every paid provider, with a green/yellow/red status.
   * Hits each provider's balance endpoint on every call, so it's a real health
   * probe rather than a cached view — that's the point of it.
   */
  async live(_req: Request, res: Response) {
    try {
      const report = await checkAllCredits();
      res.json({
        status: report.worst,
        checked_at: report.checked_at,
        burn_per_day: {
          searches: Math.round(report.burn.searches),
          verifications: Math.round(report.burn.verifications),
        },
        providers: report.checks.map((c) => ({
          provider: c.provider,
          label: c.label,
          status: c.status,
          balance: c.balance,
          unit: c.unit,
          days_left: c.days_left === null ? null : Math.round(c.days_left * 10) / 10,
          error: c.error,
          impact: c.impact,
        })),
      });
    } catch (error: any) {
      console.error("Credits Live Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  /** Recorded history, newest first — useful for spotting burn-rate trends. */
  async history(req: Request, res: Response) {
    try {
      const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const rows = await prisma.providerCredit.findMany({
        where: provider ? { provider } : undefined,
        orderBy: { checked_at: "desc" },
        take: limit,
        select: {
          provider: true,
          status: true,
          balance: true,
          unit: true,
          days_left: true,
          error: true,
          checked_at: true,
        },
      });
      res.json({ count: rows.length, history: rows });
    } catch (error: any) {
      console.error("Credits History Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
