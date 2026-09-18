import prisma from "../db/prisma";
import { findEmail } from "../email-finder";
import { FindRequest, VerificationResult } from "../email-finder/types";

/**
 * Batch `/find` as a job the caller polls, instead of a request it waits on.
 *
 * The synchronous endpoint loses a race it cannot win: answers delivered inside
 * 30 seconds were kept by the caller 99.3% of the time, answers that took over
 * an hour only 29.4%. The work was done and paid for either way — the only
 * thing that varied was whether anyone was still on the line. A job decouples
 * the two: the POST returns in milliseconds with an id, the work proceeds at
 * whatever pace the providers allow, and the results are read when they're
 * ready.
 *
 * Deliberately in-process rather than a queue service: this API is already up
 * 24/7, and a separate Railway service for scheduled work silently stopped
 * firing once before (see `credit-check-schedule.ts`). A restart mid-job leaves
 * the row `running`; `reclaimStaleJobs()` picks those up on boot.
 */

const CONCURRENCY = Number(process.env.FIND_JOB_CONCURRENCY || 3);
const MAX_BATCH = Number(process.env.FIND_JOB_MAX_ITEMS || 1000);
/** A job untouched for this long is assumed to have died with its process. */
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface BatchItem extends FindRequest {
  /** Echoed back on the result so the caller can line rows up. */
  ref?: string;
}

export const findJobService = {
  max_batch: MAX_BATCH,

  async create(requests: BatchItem[]): Promise<{ id: string; total: number }> {
    const job = await prisma.findJob.create({
      data: {
        status: "queued",
        total: requests.length,
        requests: requests as unknown as object,
      },
    });

    // Fire and forget: the HTTP response must not wait on the work.
    void run(job.id).catch((err) => {
      console.error(`find job ${job.id} failed:`, err);
    });

    return { id: job.id, total: requests.length };
  },

  async get(id: string) {
    return prisma.findJob.findUnique({ where: { id } });
  },

  /**
   * Restart jobs that were mid-flight when the process died.
   *
   * Without this a deploy during a batch strands the row at `running` forever
   * and the caller polls a job that will never finish — the same shape of
   * silent failure as a cron that stops firing.
   */
  async reclaimStaleJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const stale = await prisma.findJob.findMany({
      where: { status: { in: ["queued", "running"] }, updated_at: { lt: cutoff } },
      select: { id: true },
      take: 20,
    });
    for (const job of stale) {
      void run(job.id).catch(() => undefined);
    }
    return stale.length;
  },
};

async function run(jobId: string): Promise<void> {
  const job = await prisma.findJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "done") return;

  const requests = (job.requests as unknown as BatchItem[]) || [];
  // Resume where a killed process left off rather than paying twice.
  const results = ((job.results as unknown as object[]) || []).slice();
  const startAt = results.length;

  await prisma.findJob.update({
    where: { id: jobId },
    data: { status: "running" },
  });

  try {
    for (let i = startAt; i < requests.length; i += CONCURRENCY) {
      const slice = requests.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        slice.map(async (req) => {
          try {
            const result: VerificationResult = await findEmail(req);
            return { ref: req.ref ?? null, ...result };
          } catch (err: any) {
            return {
              ref: req.ref ?? null,
              email: null,
              status: "error",
              error: err?.message || "find failed",
            };
          }
        })
      );
      results.push(...settled);

      await prisma.findJob.update({
        where: { id: jobId },
        data: { completed: results.length, results: results as unknown as object },
      });
    }

    await prisma.findJob.update({
      where: { id: jobId },
      data: { status: "done", completed: results.length, results: results as unknown as object },
    });
  } catch (err: any) {
    await prisma.findJob.update({
      where: { id: jobId },
      data: { status: "failed", error: err?.message || "job failed" },
    });
    throw err;
  }
}
