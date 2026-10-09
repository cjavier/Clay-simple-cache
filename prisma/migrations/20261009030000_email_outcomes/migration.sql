-- What actually happened when an address was mailed, as reported by the
-- sending platform (MailBridge). Until now the finder graded itself against
-- `profiles` — "does another provider agree?" — and never saw a single bounce:
-- 10,954 addresses that had already bounced sat in `profiles` and were served
-- back as `known_email` at 0.95 confidence. This table is the ground truth.
--
-- One row per (source, source_ref): MailBridge keeps one contact per client,
-- so the same address can arrive more than once. Readers aggregate by email.

CREATE TABLE IF NOT EXISTS "email_outcomes" (
    "source"                TEXT NOT NULL,
    "source_ref"            TEXT NOT NULL,
    "email"                 TEXT NOT NULL,
    "domain"                TEXT NOT NULL,
    "first_name"            TEXT,
    "last_name"             TEXT,
    "linkedin_slug"         TEXT,
    "pattern"               TEXT,
    "bounced_at"            TIMESTAMPTZ(6),
    "bounce_type"           TEXT,
    "replied_at"            TIMESTAMPTZ(6),
    "positive_at"           TIMESTAMPTZ(6),
    "auto_replied"          BOOLEAN NOT NULL DEFAULT false,
    "first_visible_send_at" TIMESTAMPTZ(6),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_outcomes_pkey" PRIMARY KEY ("source", "source_ref")
);

CREATE INDEX IF NOT EXISTS "email_outcomes_email_idx" ON "email_outcomes" ("email");
CREATE INDEX IF NOT EXISTS "email_outcomes_domain_idx" ON "email_outcomes" ("domain");

-- What the finder told the caller to do with its answer, and why.
ALTER TABLE "search_log" ADD COLUMN IF NOT EXISTS "send_recommendation" TEXT;
ALTER TABLE "search_log" ADD COLUMN IF NOT EXISTS "evidence" TEXT;
