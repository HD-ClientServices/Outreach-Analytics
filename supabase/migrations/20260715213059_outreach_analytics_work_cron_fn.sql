-- Empuja una tanda del backfill. La invoca pg_cron.
-- El token NO se hardcodea: se lee de sms_analytics.config.
create or replace function sms_analytics.work_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare t text; req_id bigint; pending int;
begin
  -- Si no queda nada pendiente, no gastes una invocacion ni pegues a GHL.
  select count(*) into pending from sms_analytics.cohort where not done and attempts < 3;
  if pending = 0 then return null; end if;

  select value into t from sms_analytics.config where key = 'dash_token';
  if t is null then raise exception 'dash_token ausente'; end if;

  select net.http_post(
    url := 'https://ouszjnrkawvrwxjjgrxx.supabase.co/functions/v1/outreach-analytics?action=work&ms=100000&token=' || t,
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000
  ) into req_id;
  return req_id;
end;
$$;

revoke all on function sms_analytics.work_tick() from public, anon, authenticated;

-- Se agenda/desagenda a mano; queda documentado aca:
--   select cron.schedule('outreach-analytics-backfill', '*/2 * * * *',
--                        $cron$select sms_analytics.work_tick();$cron$);
--   select cron.alter_job(job_id := <id>, active := false);
