-- CreateTable
CREATE TABLE "provider_credits" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "balance" DOUBLE PRECISION,
    "unit" TEXT NOT NULL,
    "days_left" DOUBLE PRECISION,
    "error" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_credits_provider_checked_at_idx" ON "provider_credits"("provider", "checked_at");
