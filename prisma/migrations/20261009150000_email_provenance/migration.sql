-- Provenance per email: who FOUND an address and who VERIFIED it, as history.
--
-- Until now `verification_cache.method` / `search_log.method_used` mixed the two
-- (a finder spelled the address, a verifier probed it) and kept only the last
-- answer. MailBridge grades finders and verifiers separately against real
-- bounces (its spec 104), so each fact is stored with its own provider.
--
-- Additive and idempotent: one new table, nothing existing is touched. The
-- backfill of historical rows is NOT here (a re-runnable script with a dry run:
-- scripts/backfill_provenance.ts), so this stays instant on startup.

CREATE TABLE IF NOT EXISTS "email_provenance" (
    "id"         UUID NOT NULL,
    "email"      TEXT NOT NULL,
    "finder"     TEXT,
    "verifier"   TEXT,
    "verdict"    TEXT NOT NULL,
    "raw_status" TEXT,
    "confidence" DOUBLE PRECISION,
    "method"     TEXT,
    "origin"     TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "pushed_at"  TIMESTAMPTZ(6),
    "push_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_provenance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_provenance_email_idx" ON "email_provenance" ("email");
CREATE INDEX IF NOT EXISTS "email_provenance_pushed_at_created_at_idx" ON "email_provenance" ("pushed_at", "created_at");
CREATE INDEX IF NOT EXISTS "email_provenance_finder_idx" ON "email_provenance" ("finder");
CREATE INDEX IF NOT EXISTS "email_provenance_verifier_verdict_idx" ON "email_provenance" ("verifier", "verdict");

-- Same posture as the other tables (supabase/enable_rls.sql): addresses must not
-- be readable through Supabase's auto-generated REST API. Prisma connects with
-- the postgres role, which bypasses RLS. Re-enabling is a no-op.
ALTER TABLE "email_provenance" ENABLE ROW LEVEL SECURITY;
