import { Request, Response } from "express";
import { findEmail, verifySingleEmail } from "../email-finder";
import prisma from "../db/prisma";
import { dncService } from "../services/dnc.service";
import { resolveClientOr404 } from "./client-resolver";
import { findJobService, BatchItem } from "../services/find-job.service";
import { scoreRecentAnswers } from "../services/finder-quality.service";
import { debounceQueueDepth } from "../email-finder/providers/debounce";

/** Muted domains, or null when the table isn't there yet. */
async function countMutedDomains(): Promise<number | null> {
  try {
    return await prisma.domainHealth.count({
      where: { muted_until: { gt: new Date() } },
    });
  } catch {
    return null;
  }
}

export const emailFinderController = {
  async find(req: Request, res: Response) {
    try {
      const {
        first_name,
        last_name,
        domain,
        full_name,
        linkedin_url,
        linkedin_slug,
        max_tier,
        dnc_client,
      } = req.body;

      if (!domain) {
        res.status(400).json({ error: "domain is required" });
        return;
      }

      if (!first_name && !last_name && !full_name && !linkedin_url && !linkedin_slug) {
        res.status(400).json({
          error:
            "At least one of first_name, last_name, full_name, linkedin_url or linkedin_slug is required",
        });
        return;
      }

      // Optional Do-Not-Contact check. Only kicks in when `dnc_client` is
      // provided so existing callers see unchanged behavior/response shape.
      const dncRequested = !!dnc_client;
      let dncClientId: string | undefined;
      if (dncRequested) {
        const client = await resolveClientOr404(res, dnc_client);
        if (!client) return;
        dncClientId = client.id;

        // Check the domain up front, before spending on the search.
        const domainCheck = await dncService.checkDomain(dncClientId, domain);
        if (domainCheck.do_not_contact) {
          res.status(200).json({
            do_not_contact: true,
            matched_by: domainCheck.matched_by,
          });
          return;
        }
      }

      const result = await findEmail({
        first_name,
        last_name,
        domain,
        full_name,
        linkedin_url,
        linkedin_slug,
        max_tier: max_tier || 2,
      });

      if (dncClientId && result.email) {
        const emailCheck = await dncService.check(dncClientId, result.email);
        if (emailCheck.do_not_contact) {
          res.status(200).json({
            do_not_contact: true,
            matched_by: emailCheck.matched_by,
          });
          return;
        }
      }

      res.json({
        success: true,
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        pattern: result.pattern,
        domain_info: result.domain_info,
        serp_info: result.serp_info,
        permutations_tried: result.permutations_tried,
        identity_source: result.identity_source,
        surnames_tried: result.surnames_tried,
        timed_out: result.timed_out,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    } catch (error: any) {
      console.error("Email Finder Find Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async verify(req: Request, res: Response) {
    try {
      const { email, max_tier, dnc_client } = req.body;

      if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
      }

      // Optional Do-Not-Contact check. Only kicks in when `dnc_client` is
      // provided so existing callers see unchanged behavior/response shape.
      const dncRequested = !!dnc_client;
      if (dncRequested) {
        const client = await resolveClientOr404(res, dnc_client);
        if (!client) return;

        const emailCheck = await dncService.check(client.id, email);
        if (emailCheck.do_not_contact) {
          res.status(200).json({
            do_not_contact: true,
            matched_by: emailCheck.matched_by,
          });
          return;
        }
      }

      const result = await verifySingleEmail(email, max_tier || 2);

      res.json({
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        domain_info: result.domain_info,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        ...(dncRequested ? { do_not_contact: false } : {}),
      });
    } catch (error: any) {
      console.error("Email Finder Verify Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  /**
   * Queue a batch of searches and answer immediately with a job id.
   *
   * The synchronous endpoint is fine for a handful of lookups. For a campaign
   * list it loses a race it cannot win: the work gets done and billed whether
   * or not the caller is still connected, and answers that took over an hour
   * were used only 29.4% of the time. Here the POST returns in milliseconds.
   */
  async createBatch(req: Request, res: Response) {
    try {
      const { requests } = req.body;

      if (!Array.isArray(requests) || requests.length === 0) {
        res.status(400).json({ error: "requests must be a non-empty array" });
        return;
      }
      if (requests.length > findJobService.max_batch) {
        res.status(400).json({
          error: `requests is limited to ${findJobService.max_batch} items per job`,
        });
        return;
      }

      const invalid = requests.findIndex(
        (r: BatchItem) =>
          !r ||
          !r.domain ||
          (!r.first_name && !r.last_name && !r.full_name && !r.linkedin_url && !r.linkedin_slug)
      );
      if (invalid !== -1) {
        res.status(400).json({
          error: `requests[${invalid}] needs a domain and at least one of first_name, last_name, full_name, linkedin_url or linkedin_slug`,
        });
        return;
      }

      const job = await findJobService.create(requests as BatchItem[]);
      res.status(202).json({
        job_id: job.id,
        total: job.total,
        status: "queued",
        poll: `/find/batch/${job.id}`,
      });
    } catch (error: any) {
      console.error("Email Finder Batch Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async getBatch(req: Request, res: Response) {
    try {
      const job = await findJobService.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: "job not found" });
        return;
      }
      res.json({
        job_id: job.id,
        status: job.status,
        total: job.total,
        completed: job.completed,
        error: job.error,
        results: job.status === "done" ? job.results : undefined,
        created_at: job.created_at,
        updated_at: job.updated_at,
      });
    } catch (error: any) {
      console.error("Email Finder Batch Status Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  /**
   * The recorded history behind `stats.quality`.
   *
   * `/stats` computes a rolling window live, which cannot answer "was this
   * better than last month" — once the window slides, the old number is gone.
   * The daily job writes a dated row; this reads them back, the same way
   * `/credits/history` does for provider balances.
   */
  async statsHistory(req: Request, res: Response) {
    try {
      const days = Math.min(Number(req.query.days) || 90, 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      since.setUTCHours(0, 0, 0, 0);

      const rows = await prisma.finderMetric.findMany({
        where: { measured_on: { gte: since } },
        orderBy: [{ measured_on: "desc" }, { status: "asc" }],
      });

      res.json({
        days,
        count: rows.length,
        metrics: rows.map((r) => ({
          measured_on: r.measured_on.toISOString().slice(0, 10),
          window_days: r.window_days,
          status: r.status,
          answered: r.answered,
          comparable: r.comparable,
          agreed: r.agreed,
          agreement_rate: r.agreement_rate,
          delivered: r.delivered,
          delivery_rate: r.delivery_rate,
          searches: r.searches,
          api_calls: r.api_calls,
          cost_usd: r.cost_usd,
          cost_per_search: r.searches > 0 ? r.cost_usd / r.searches : null,
          calls_per_search: r.searches > 0 ? r.api_calls / r.searches : null,
          p50_ms: r.p50_ms,
          p90_ms: r.p90_ms,
        })),
      });
    } catch (error: any) {
      console.error("Email Finder Stats History Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async stats(req: Request, res: Response) {
    try {
      const windowDays = Math.min(Number(req.query.window_days) || 7, 90);

      const [
        totalSearches,
        validFound,
        totalCost,
        methodBreakdown,
        domainsCached,
        patternsLearned,
        catchAllCount,
        mutedDomains,
        quality,
      ] = await Promise.all([
        prisma.searchLog.count(),
        prisma.searchLog.count({ where: { result_status: "valid" } }),
        prisma.searchLog.aggregate({ _sum: { cost_usd: true } }),
        prisma.searchLog.groupBy({
          by: ["method_used"],
          where: { result_status: "valid" },
          _count: true,
        }),
        prisma.domainIntel.count(),
        prisma.domainPattern.count(),
        prisma.searchLog.count({ where: { result_status: "catch_all" } }),
        // Both of these are new surfaces. A stats page that 500s because one
        // extra table isn't migrated yet is worse than a stats page missing one
        // number, so each degrades to null on its own.
        countMutedDomains(),
        scoreRecentAnswers(windowDays).catch(() => null),
      ]);

      const methods: Record<string, number> = {};
      for (const m of methodBreakdown) {
        if (m.method_used) methods[m.method_used] = m._count;
      }

      const total = totalCost._sum.cost_usd || 0;

      res.json({
        total_searches: totalSearches,
        total_valid_found: validFound,
        // Kept for backwards compatibility, but it measures volume, not
        // correctness — read `quality.by_status[*].agreement_rate` instead.
        success_rate: totalSearches > 0 ? validFound / totalSearches : 0,
        methods_breakdown: methods,
        total_cost_usd: total,
        avg_cost_per_email: totalSearches > 0 ? total / totalSearches : 0,
        domains_in_cache: domainsCached,
        patterns_learned: patternsLearned,
        catch_all_domains: catchAllCount,
        muted_domains: mutedDomains,
        debounce_queue: debounceQueueDepth(),
        quality,
      });
    } catch (error: any) {
      console.error("Email Finder Stats Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
