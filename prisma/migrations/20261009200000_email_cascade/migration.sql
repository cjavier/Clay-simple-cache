-- Email cascade (Blitz → Prospeo → Findymail) for list builds: one row per
-- person × provider (found / not_found / pending / closed) and a persistent
-- circuit breaker per provider. Additive and idempotent.
CREATE TABLE IF NOT EXISTS "email_attempts" (
    "id" UUID NOT NULL,
    "person_key" TEXT NOT NULL,
    "linkedin_url" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT,
    "company_domain" TEXT,
    "company_name" TEXT,
    "job_id" TEXT NOT NULL DEFAULT '',
    "mb_table_id" TEXT,
    "row_ref" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "email" TEXT,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "attempted_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_attempts_person_key_provider_job_id_key" ON "email_attempts"("person_key", "provider", "job_id");
CREATE INDEX IF NOT EXISTS "email_attempts_status_provider_idx" ON "email_attempts"("status", "provider");
CREATE INDEX IF NOT EXISTS "email_attempts_job_id_status_idx" ON "email_attempts"("job_id", "status");
CREATE INDEX IF NOT EXISTS "email_attempts_person_key_idx" ON "email_attempts"("person_key");

CREATE TABLE IF NOT EXISTS "email_provider_state" (
    "provider" TEXT NOT NULL,
    "exhausted_at" TIMESTAMPTZ(6),
    "exhausted_reason" TEXT,
    "exhausted_detail" TEXT,
    "last_balance" DOUBLE PRECISION,
    "last_balance_at" TIMESTAMPTZ(6),
    "low_alert_on" TEXT,
    "reactivated_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_provider_state_pkey" PRIMARY KEY ("provider")
);
