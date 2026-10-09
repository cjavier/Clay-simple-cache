-- Background Blitz builds for a list (POST /tables with `build`).
ALTER TABLE "table_jobs" ADD COLUMN "build" JSONB;
ALTER TABLE "table_jobs" ADD COLUMN "build_status" TEXT;
ALTER TABLE "table_jobs" ADD COLUMN "build_state" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "table_jobs" ADD COLUMN "build_error" TEXT;
CREATE INDEX "table_jobs_build_status_idx" ON "table_jobs"("build_status");
