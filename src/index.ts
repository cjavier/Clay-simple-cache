import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { startCreditCheckSchedule } from './jobs/credit-check-schedule';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Daily provider-balance check. Runs in-process because this service is
    // already up 24/7 and a separate Railway cron service silently stopped
    // firing after its first run.
    startCreditCheckSchedule();
});
