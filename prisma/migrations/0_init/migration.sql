-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "linkedin_slug" TEXT,
    "linkedin_url" TEXT,
    "phone_e164" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "domain" TEXT,
    "linkedin_slug" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dnc_entries" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "list_type" TEXT NOT NULL,
    "email" TEXT,
    "domain" TEXT,
    "dedup_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dnc_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_cache" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "method" TEXT,
    "verified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_patterns" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "sample_count" INTEGER NOT NULL DEFAULT 1,
    "last_confirmed" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_intel" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "has_mx" BOOLEAN NOT NULL DEFAULT false,
    "mx_records" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT NOT NULL DEFAULT 'other',
    "is_catch_all" BOOLEAN NOT NULL DEFAULT false,
    "is_disposable" BOOLEAN NOT NULL DEFAULT false,
    "is_free_provider" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_intel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_log" (
    "id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "domain" TEXT,
    "result_email" TEXT,
    "result_status" TEXT,
    "method_used" TEXT,
    "permutations_tried" INTEGER NOT NULL DEFAULT 0,
    "api_calls_made" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_linkedin_slug_key" ON "profiles"("linkedin_slug");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_linkedin_url_key" ON "profiles"("linkedin_url");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_phone_e164_key" ON "profiles"("phone_e164");

-- CreateIndex
CREATE INDEX "profiles_email_idx" ON "profiles"("email");

-- CreateIndex
CREATE INDEX "profiles_linkedin_slug_idx" ON "profiles"("linkedin_slug");

-- CreateIndex
CREATE INDEX "profiles_linkedin_url_idx" ON "profiles"("linkedin_url");

-- CreateIndex
CREATE INDEX "profiles_phone_e164_idx" ON "profiles"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "companies_domain_key" ON "companies"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "companies_linkedin_slug_key" ON "companies"("linkedin_slug");

-- CreateIndex
CREATE INDEX "companies_domain_idx" ON "companies"("domain");

-- CreateIndex
CREATE INDEX "companies_linkedin_slug_idx" ON "companies"("linkedin_slug");

-- CreateIndex
CREATE UNIQUE INDEX "clients_handle_key" ON "clients"("handle");

-- CreateIndex
CREATE INDEX "clients_handle_idx" ON "clients"("handle");

-- CreateIndex
CREATE INDEX "dnc_entries_client_id_idx" ON "dnc_entries"("client_id");

-- CreateIndex
CREATE INDEX "dnc_entries_email_idx" ON "dnc_entries"("email");

-- CreateIndex
CREATE INDEX "dnc_entries_domain_idx" ON "dnc_entries"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "dnc_entries_client_id_dedup_key_key" ON "dnc_entries"("client_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "verification_cache_email_key" ON "verification_cache"("email");

-- CreateIndex
CREATE INDEX "verification_cache_email_idx" ON "verification_cache"("email");

-- CreateIndex
CREATE INDEX "domain_patterns_domain_idx" ON "domain_patterns"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "domain_patterns_domain_pattern_key" ON "domain_patterns"("domain", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "domain_intel_domain_key" ON "domain_intel"("domain");

-- CreateIndex
CREATE INDEX "domain_intel_domain_idx" ON "domain_intel"("domain");

-- CreateIndex
CREATE INDEX "search_log_domain_idx" ON "search_log"("domain");

-- AddForeignKey
ALTER TABLE "dnc_entries" ADD CONSTRAINT "dnc_entries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

