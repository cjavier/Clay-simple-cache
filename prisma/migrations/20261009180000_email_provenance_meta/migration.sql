-- What the finder knew when it gave an address, sent to MailBridge in the
-- evidence row's `raw` so its bounce-risk score (spec 105) can use it as the
-- per-address prior: send_recommendation, evidence_tier, expected_bounce,
-- mail_gateway, mx_provider, pattern, searched_name.
--
-- Additive and idempotent. The checked_at index serves GET /stats, which reads
-- the last N days of provenance and was a sequential scan.
ALTER TABLE "email_provenance" ADD COLUMN IF NOT EXISTS "meta" JSONB;
CREATE INDEX IF NOT EXISTS "email_provenance_checked_at_idx" ON "email_provenance" ("checked_at");
