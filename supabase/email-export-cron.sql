-- One Thing daily export: pg_cron calls the email-export Edge Function at 7am US Eastern.
--
-- Run in the Supabase SQL editor in two parts.
--
-- PART 1 (once): creates a random cron secret in Vault and shows it. Copy the value into
-- Edge Functions → Secrets as CRON_SECRET, so the function can tell the cron's calls apart.
--
--   select vault.create_secret(
--     replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
--     'email_export_cron_secret');
--   select decrypted_secret from vault.decrypted_secrets where name = 'email_export_cron_secret';
--
-- PART 2: everything below. Safe to re-run: cron.schedule updates a job with the same name.
-- Replace YOUR-LOGIN-EMAIL with the One Thing login; the function's EXPORT_TO secret then
-- decides where the email actually goes.
--
-- Check it's working:
--   select status_code, content, created from net._http_response order by created desc limit 5;
-- 200 = sent. 401 = CRON_SECRET doesn't match the Vault value. 404 = login email not found.

-- 1) The scheduler (pg_cron) and outbound web requests (pg_net).
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- 2) 7am Eastern is 11:00 UTC in winter (EST) and 12:00 UTC in summer (EDT). pg_cron runs
--    in UTC, so it fires at both and only sends on the one that is 7am in New York.
--    The Authorization header is the public anon key (it's in index.html too); it only gets
--    the call past the Edge Function gateway. x-cron-secret is what the function checks.
select cron.schedule(
  'one-thing-daily-export',
  '0 11,12 * * *',
  $$
  select net.http_post(
    url := 'https://ikxwpjsytrzloyjvysnt.supabase.co/functions/v1/email-export',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_kkkCjaUdDiFYKeE8bkB-7g_clq8LFiO',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'email_export_cron_secret')
    ),
    body := jsonb_build_object('email', 'YOUR-LOGIN-EMAIL'),
    timeout_milliseconds := 30000
  )
  where extract(hour from now() at time zone 'America/New_York') = 7;
  $$
);
