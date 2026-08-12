-- Buyer Persona por vertical (MCA / Credit Card), generada desde las transcripciones
-- de las llamadas que terminaron en WON.
--
-- Dos decisiones de diseño viven en este esquema y conviene no perderlas de vista:
--
--  1. `call_transcript` guarda `pipeline_id`, NO `persona_key`. La persona se deriva
--     por join contra `persona_pipeline`. Así, mover un pipeline de una persona a otra
--     (o sumar uno nuevo) re-agrupa las transcripciones existentes sin re-transcribir
--     y sin volver a gastar en Deepgram.
--
--  2. `unique (message_id, rec_index)` es el control de gasto. El endpoint es abierto
--     (ver Seguridad en el README): quien loopee ?action=persona_transcribe recibe
--     {remaining: 0} y no gasta nada, porque una llamada ya transcripta nunca se
--     vuelve a mandar a Deepgram.

create table if not exists sms_analytics.persona_config (
  key         text primary key,
  label       text not null,
  headline    text,
  sort        int  not null default 100,
  active      boolean not null default true,
  min_sample  int  not null default 15,   -- por debajo de esto, el dashboard avisa muestra chica
  since_days  int,                        -- null = todos los WON, sin recorte temporal
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- La selección de pipelines de la interfaz vive acá. Agregar un buyer nuevo
-- (p.ej. "United Settlement Closing" cuando exista) es insertar una fila.
create table if not exists sms_analytics.persona_pipeline (
  persona_key   text not null references sms_analytics.persona_config(key) on delete cascade,
  pipeline_id   text not null,
  pipeline_name text,
  won_stage_id  text,
  added_at      timestamptz not null default now(),
  primary key (persona_key, pipeline_id)
);

-- Staging del scan. Existe porque la fase 2 (contacto -> conversaciones -> mensajes,
-- 2-4 requests a GHL por deal) es la que puede pasarse de los 150s de una edge
-- function; se drena por tandas resumibles, igual que cohort.done.
create table if not exists sms_analytics.persona_won_opp (
  opportunity_id text primary key,
  pipeline_id    text not null,
  contact_id     text,
  won_src        text,   -- 'status' | 'stage' | 'both'
  stage_id       text,
  won_at         timestamptz,
  expanded       boolean not null default false,
  n_calls        int not null default 0,
  attempts       int not null default 0,
  seen_at        timestamptz not null default now()
);
create index if not exists persona_won_opp_pending_idx
  on sms_analytics.persona_won_opp(expanded, attempts) where not expanded;
create index if not exists persona_won_opp_pipeline_idx
  on sms_analytics.persona_won_opp(pipeline_id);

-- La cola Y el almacén, en la misma tabla (mismo idioma que sms_analytics.cohort).
create table if not exists sms_analytics.call_transcript (
  id              bigserial primary key,
  pipeline_id     text not null,
  opportunity_id  text,
  contact_id      text not null,
  conversation_id text,
  message_id      text not null,
  rec_index       int  not null default 1,   -- 1 = pata del closer; 0 = setter/default
  call_at         timestamptz,
  duration_s      int,                       -- meta.call.duration de GHL; puede ser null
  status          text not null default 'queued',
                  -- queued | done | no_audio | failed | short
  attempts        int  not null default 0,
  bytes           int,
  lang            text,                      -- detected_language de Deepgram
  words           int,
  transcript      text,
  extract         jsonb,                     -- ficha por llamada (etapa A), cacheada
  extract_at      timestamptz,
  err             text,
  queued_at       timestamptz not null default now(),
  done_at         timestamptz,
  unique (message_id, rec_index)
);
create index if not exists call_transcript_queue_idx
  on sms_analytics.call_transcript(status, attempts) where status = 'queued';
create index if not exists call_transcript_pipeline_idx
  on sms_analytics.call_transcript(pipeline_id, status);
create index if not exists call_transcript_extract_idx
  on sms_analytics.call_transcript(status) where status = 'done' and extract is null;

create table if not exists sms_analytics.persona_doc (
  id          bigserial primary key,
  persona_key text not null references sms_analytics.persona_config(key) on delete cascade,
  created_at  timestamptz not null default now(),
  n_calls     int not null default 0,
  n_opps      int,
  n_words     bigint,
  pipelines   jsonb,       -- snapshot de la config con la que se generó
  doc         jsonb not null,
  md          text  not null,
  model       text,
  is_current  boolean not null default false
);
create unique index if not exists persona_doc_current_idx
  on sms_analytics.persona_doc(persona_key) where is_current;

create table if not exists sms_analytics.persona_run (
  persona_key text primary key references sms_analytics.persona_config(key) on delete cascade,
  phase       text,   -- idle|scanning|transcribing|extracting|generating|done|error
  started_at  timestamptz,
  updated_at  timestamptz default now(),
  finished_at timestamptz,
  found       int default 0,
  note        text
);

alter table sms_analytics.persona_config   enable row level security;
alter table sms_analytics.persona_pipeline enable row level security;
alter table sms_analytics.persona_won_opp  enable row level security;
alter table sms_analytics.call_transcript  enable row level security;
alter table sms_analytics.persona_doc      enable row level security;
alter table sms_analytics.persona_run      enable row level security;

-- Seed: los pipelines verificados contra la API de GHL el 2026-08-12.
-- "United Settlement Closing" no existe todavía en GHL; se suma desde la interfaz.
insert into sms_analytics.persona_config(key, label, headline, sort, min_sample) values
  ('mca', 'MCA',         'The drowning operator', 10, 15),
  ('cc',  'Credit Card', null,                    20, 15)
on conflict (key) do nothing;

insert into sms_analytics.persona_pipeline(persona_key, pipeline_id, pipeline_name) values
  ('mca', 'xXSPcEgGwRNwxndym0c7', 'RISE CLOSING'),
  ('mca', 'AMMYRDoaZAGs6zXocz0V', 'NCN CLOSING'),
  ('cc',  'iIh48orDyaximvS4yaJY', 'CENTURY CLOSING'),
  ('cc',  '8BvnouxKHxcYnK2vHZHH', 'QUANTUM CLOSING'),
  ('cc',  'nrmarRelNFc4GwgaehvV', 'FIRST CHOICE CLOSING')
on conflict do nothing;

insert into sms_analytics.persona_run(persona_key, phase) values ('mca','idle'), ('cc','idle')
on conflict (persona_key) do nothing;

-- Red de contención por cron: drena la cola de transcripción si quedó a medias.
-- NUNCA llama a persona_build — eso gasta Anthropic y es una decisión humana.
create or replace function sms_analytics.persona_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare t text; req_id bigint; pending int;
begin
  select count(*) into pending from sms_analytics.call_transcript
   where status = 'queued' and attempts < 3;
  if pending = 0 then return null; end if;

  select value into t from sms_analytics.config where key = 'dash_token';

  select net.http_post(
    url := 'https://voivhkugeepawdxoubgx.supabase.co/functions/v1/outreach-analytics'
           || '?action=persona_transcribe&ms=100000&token=' || coalesce(t, ''),
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000
  ) into req_id;
  return req_id;
end;
$$;

revoke all on function sms_analytics.persona_tick() from public, anon, authenticated;

-- Se agenda a mano cuando haga falta:
--   select cron.schedule('persona-transcribe', '*/2 * * * *',
--                        $cron$select sms_analytics.persona_tick();$cron$);
--   select cron.alter_job(job_id := <id>, active := false);
