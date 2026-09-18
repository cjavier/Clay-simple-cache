-- Record the dimensions the optimization changed, so its effect stays
-- measurable after the fact, and keep a dated snapshot of finder quality.

ALTER TABLE "search_log" ADD COLUMN "identity_source" TEXT;
ALTER TABLE "search_log" ADD COLUMN "timed_out" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "search_log" ADD COLUMN "candidates_built" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "search_log_created_at_idx" ON "search_log" ("created_at");

CREATE TABLE "finder_metrics" (
    "id" UUID NOT NULL,
    "measured_on" DATE NOT NULL,
    "window_days" INTEGER NOT NULL DEFAULT 7,
    "status" TEXT NOT NULL,
    "answered" INTEGER NOT NULL DEFAULT 0,
    "comparable" INTEGER NOT NULL DEFAULT 0,
    "agreed" INTEGER NOT NULL DEFAULT 0,
    "agreement_rate" DOUBLE PRECISION,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "delivery_rate" DOUBLE PRECISION,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "api_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "p50_ms" INTEGER,
    "p90_ms" INTEGER,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "finder_metrics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finder_metrics_measured_on_window_days_status_key"
    ON "finder_metrics"("measured_on", "window_days", "status");
CREATE INDEX "finder_metrics_measured_on_idx" ON "finder_metrics"("measured_on");
