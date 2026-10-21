-- work_tick() pasa de "solo drenar" a llevar la corrida hasta el snapshot.
--
-- Lección de octubre 2026: el dashboard quedó congelado en el 30/08 aunque la
-- ingesta siguió andando. markwon + build corrían pegados al ÚLTIMO lote de
-- `work`, en el mismo request: ~100s de lote + hasta ~115s de markwon + el build
-- no entran en los 150s de la edge function, así que se cortaba siempre. Y como
-- al cortarse ya no quedaba nada pendiente, el early-return de work_tick no
-- volvía a llamar a nadie. Mismo síntoma que en agosto: cron todo verde, datos
-- viejos.
--
-- Ahora el cierre son dos fases, cada una en su propio request:
--
--   pendientes > 0                       -> work (lote de 45s)
--   drenado, note <> 'marked'/'building' -> markwon  (note='marking'; al terminar 'marked')
--   note = 'marked'                      -> build    (note='building'; al terminar 'built' + finished_at)
--
-- Una fase en vuelo (phase_at < 3 min, más que el timeout de 150s) no se pisa.
-- Si se corta, el tick siguiente la reintenta, hasta 4 veces por fase.

create or replace function sms_analytics.work_tick()
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  t text; req_id bigint; pending int;
  r record; act text; nxt text;
  fn text := 'https://voivhkugeepawdxoubgx.supabase.co/functions/v1/outreach-analytics';
begin
  select value into t from sms_analytics.config where key = 'dash_token';
  if t is null then raise exception 'dash_token ausente'; end if;

  select count(*) into pending from sms_analytics.cohort where not done and attempts < 3;
  if pending > 0 then
    -- 45s y no 100s: el tope de CPU de Supabase cortaba casi la mitad de los
    -- lotes largos (546 "CPU Time exceeded").
    select net.http_post(
      url := fn || '?action=work&ms=45000&token=' || t,
      body := '{}'::jsonb, headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 150000) into req_id;
    return req_id;
  end if;

  select note, finished_at, phase_at, phase_tries into r
    from sms_analytics.run where id = 1 for update;
  if not found or r.finished_at is not null then return null; end if;
  if r.note in ('marking', 'building') and r.phase_at > now() - interval '3 minutes' then
    return null;
  end if;
  if coalesce(r.phase_tries, 0) >= 4 then return null; end if;

  if r.note in ('marked', 'building') then act := 'build'; nxt := 'building';
  else act := 'markwon'; nxt := 'marking';
  end if;

  update sms_analytics.run
     set note = nxt, phase_at = now(),
         phase_tries = case when r.note = nxt then coalesce(r.phase_tries, 0) + 1 else 1 end
   where id = 1;

  select net.http_post(
    url := fn || '?action=' || act || '&token=' || t,
    body := '{}'::jsonb, headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000) into req_id;
  return req_id;
end; $function$;

-- Lotes de la mitad, el doble de seguido: mismo caudal, sin solapar.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'outreach-analytics-backfill'),
  schedule := '* * * * *');
