import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { startCreditCheckSchedule } from './jobs/credit-check-schedule';
import { findJobService } from './services/find-job.service';
import { tableJobService } from './services/table-job.service';
import { tableBuildService } from './services/table-build.service';
import { startEvidenceSweeper } from './services/evidence-push.service';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Daily provider-balance check. Runs in-process because this service is
    // already up 24/7 and a separate Railway cron service silently stopped
    // firing after its first run.
    startCreditCheckSchedule();

    // A deploy in the middle of a batch leaves its row `running` with nobody
    // working it. Pick those up rather than letting the caller poll forever.
    void findJobService
        .reclaimStaleJobs()
        .then((n) => n > 0 && console.log(`[find-jobs] reanudados ${n} trabajos interrumpidos`))
        .catch((e) => console.error('[find-jobs] no se pudieron reanudar:', e));

    // Rows waiting to reach MailBridge (POST /tables/:id/rows): resume what a
    // deploy interrupted and keep sweeping for retries whose backoff is over.
    void tableJobService.start().catch((e) => console.error('[table-jobs] no se pudo arrancar:', e));
    // Provenance MailBridge doesn't have yet (outage, restart): re-queue it every few minutes.
    startEvidenceSweeper();
    // Blitz builds a deploy interrupted resume from their last saved chunk.
    void tableBuildService
        .resume()
        .then((n) => n > 0 && console.log(`[table-build] reanudadas ${n} construcciones`))
        .catch((e) => console.error('[table-build] no se pudieron reanudar:', e));
    // Email cascade: hourly balance check of Prospeo/Findymail — reopens a
    // provider out of credits once it's topped up and retries its pending people.
});
