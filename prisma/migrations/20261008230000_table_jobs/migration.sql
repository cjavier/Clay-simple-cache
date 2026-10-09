-- Lists built for MailBridge clients (POST /tables) and the row batches that
-- are forwarded to MailBridge in the background (POST /tables/:id/rows).

CREATE TABLE "table_jobs" (
    "id" UUID NOT NULL,
    "mb_client_id" UUID NOT NULL,
    "mb_client_name" TEXT,
    "campaign" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT,
    "tables" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "table_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "table_jobs_mb_client_id_idx" ON "table_jobs"("mb_client_id");

CREATE TABLE "table_job_batches" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "rows" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "table_job_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "table_job_batches_job_id_fkey" FOREIGN KEY ("job_id")
        REFERENCES "table_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "table_job_batches_status_next_attempt_at_idx" ON "table_job_batches"("status", "next_attempt_at");
CREATE INDEX "table_job_batches_job_id_idx" ON "table_job_batches"("job_id");
