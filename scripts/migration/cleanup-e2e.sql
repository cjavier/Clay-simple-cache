-- Rows the smoke run of contract-e2e.mjs leaves behind (synthetic identity on
-- improvitz-e2e-test.com). Run with search_path set to the schema to clean:
--   psql "$URL" -v ON_ERROR_STOP=1 -c "set search_path = clay_cache" -f cleanup-e2e.sql
--   psql "$URL" -v ON_ERROR_STOP=1 -c "set search_path = public"     -f cleanup-e2e.sql
begin;
delete from profiles where email like '%@improvitz-e2e-test.com' or linkedin_url like 'https://www.linkedin.com/in/e2e-%';
delete from email_provenance where email like '%@improvitz-e2e-test.com';
delete from email_outcomes where email like '%@improvitz-e2e-test.com';
delete from verification_cache where email like '%@improvitz-e2e-test.com';
delete from search_log where domain = 'improvitz-e2e-test.com';
delete from domain_intel where domain = 'improvitz-e2e-test.com';
delete from domain_patterns where domain = 'improvitz-e2e-test.com';
delete from domain_health where domain = 'improvitz-e2e-test.com';
commit;
