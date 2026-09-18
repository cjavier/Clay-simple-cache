import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { startCreditCheckSchedule } from './jobs/credit-check-schedule';
import { findJobService } from './services/find-job.service';

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
});
