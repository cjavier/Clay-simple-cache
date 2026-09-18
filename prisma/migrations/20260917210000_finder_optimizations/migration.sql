-- Email Finder optimizations: SERP cache, domain circuit breaker, batch jobs.

CREATE TABLE "serp_cache" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "emails" JSONB NOT NULL DEFAULT '[]',
    "patterns" JSONB NOT NULL DEFAULT '[]',
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "serp_cache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "serp_cache_domain_key" ON "serp_cache"("domain");

CREATE TABLE "domain_health" (
    "domain" TEXT NOT NULL,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMPTZ(6),
    "muted_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "domain_health_pkey" PRIMARY KEY ("domain")
);

CREATE TABLE "find_jobs" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "total" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "requests" JSONB NOT NULL DEFAULT '[]',
    "results" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "find_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "find_jobs_status_idx" ON "find_jobs"("status");

-- Look a person up in the 168k emails we already own before spending a cent.
-- Without this index the lookup is a sequential scan of `profiles` on every call.
CREATE INDEX IF NOT EXISTS "profiles_email_domain_idx"
    ON "profiles" ((split_part(lower("email"), '@', 2)));

-- Reading back what a /find answered, to score accuracy, was a full scan too.
CREATE INDEX IF NOT EXISTS "search_log_result_email_idx"
    ON "search_log" (lower("result_email"));
CREATE INDEX IF NOT EXISTS "search_log_created_at_idx"
    ON "search_log" ("created_at");
