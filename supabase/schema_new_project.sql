-- ============================================================================
-- Outreach Analytics — CONSOLIDATED schema for the NEW dedicated project.
-- Captured read-only from HappyDebt Platform (ouszjnrkawvrwxjjgrxx) on 2026-07-20
-- before the surgical revert. Faithful reproduction + 2 audit-gap fixes
-- (context_docs, msg_events.led_to_dnd) + RLS enabled.
--
-- Target project ref: voivhkugeepawdxoubgx (org "Intro", us-west-2).
-- The legacy v1 `snapshots` table is intentionally NOT recreated.
-- After running this whole file once, run:  select net.worker_restart();
-- ============================================================================

-- Extensions used by the cron payload functions (async HTTP + scheduler).
create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists sms_analytics;

-- ---- config: secrets + small settings (key/value) --------------------------
create table if not exists sms_analytics.config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz default now()
);

-- ---- context_docs: AI-consumable markdown (persona, brandvoice) ------------
create table if not exists sms_analytics.context_docs (
  key        text primary key,
  md         text not null,
  updated_at timestamptz default now()
);

-- ---- cohort: every contact texted in the window ----------------------------
create table if not exists sms_analytics.cohort (
  contact_id     text primary key,
  name           text,
  opp_created_at timestamptz,
  won            boolean not null default false,
  won_at         timestamptz,
  wf             text,
  entered_at     timestamptz,
  trigger_key    text,
  trigger_pos    int,
  replied        boolean not null default false,
  done           boolean not null default false,
  attempts       int not null default 0,
  fetched_at     timestamptz
);
create index if not exists cohort_pending_idx on sms_analytics.cohort (done, attempts) where (not done);
create index if not exists cohort_wf_idx on sms_analytics.cohort (wf, entered_at);

-- ---- templates: distinct message skeletons ---------------------------------
create table if not exists sms_analytics.templates (
  tmpl_key text primary key,
  tmpl     text not null
);

-- ---- msg_events: one row per outbound SMS (incl. led_to_dnd) ----------------
create table if not exists sms_analytics.msg_events (
  id         bigserial primary key,
  contact_id text not null,
  wf         text,
  tmpl_key   text not null,
  pos        int,
  sent_at    timestamptz,
  got_reply  boolean not null default false,
  led_to_lt  boolean not null default false,
  led_to_dnd boolean not null default false
);
create index if not exists msg_events_contact_idx on sms_analytics.msg_events (contact_id);
create index if not exists msg_events_tmpl_idx on sms_analytics.msg_events (tmpl_key);
create index if not exists msg_events_wf_idx on sms_analytics.msg_events (wf, sent_at);

-- ---- run: singleton progress row -------------------------------------------
create table if not exists sms_analytics.run (
  id          int primary key default 1 check (id = 1),
  started_at  timestamptz,
  seeded      int not null default 0,
  finished_at timestamptz,
  note        text
);
insert into sms_analytics.run (id) values (1) on conflict (id) do nothing;

-- ---- snapshots_v2: the built dashboard payload -----------------------------
create table if not exists sms_analytics.snapshots_v2 (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null
);

-- ---- RLS: enable on all tables; no public policies. ------------------------
-- The edge function connects via SUPABASE_DB_URL (owner/service role) which
-- bypasses RLS, so no policies are needed. This closes the "RLS disabled"
-- advisory (anon/authenticated get zero access).
alter table sms_analytics.config       enable row level security;
alter table sms_analytics.context_docs enable row level security;
alter table sms_analytics.cohort        enable row level security;
alter table sms_analytics.templates     enable row level security;
alter table sms_analytics.msg_events    enable row level security;
alter table sms_analytics.run           enable row level security;
alter table sms_analytics.snapshots_v2  enable row level security;

-- ============================================================================
-- Cron payload functions (pg_net async HTTP -> the edge function).
-- ============================================================================

-- Drain the work queue (backfill cron, every 2 min; pause when idle).
create or replace function sms_analytics.work_tick()
returns bigint language plpgsql security definer set search_path to '' as $fn$
declare t text; req_id bigint; pending int;
begin
  select count(*) into pending from sms_analytics.cohort where not done and attempts < 3;
  if pending = 0 then return null; end if;
  select value into t from sms_analytics.config where key = 'dash_token';
  if t is null then raise exception 'dash_token ausente'; end if;
  select net.http_post(
    url := 'https://voivhkugeepawdxoubgx.supabase.co/functions/v1/outreach-analytics?action=work&ms=100000&token=' || t,
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000
  ) into req_id;
  return req_id;
end;
$fn$;
revoke all on function sms_analytics.work_tick() from public, anon, authenticated;

-- Weekly Sunday auto-refresh (incremental if cohort populated, else full seed).
create or replace function sms_analytics.refresh_weekly()
returns bigint language plpgsql security definer set search_path to '' as $fn$
declare t text; req_id bigint;
begin
  select value into t from sms_analytics.config where key = 'dash_token';
  if t is null or t = '' then raise exception 'dash_token ausente en sms_analytics.config'; end if;
  select net.http_post(
    url := 'https://voivhkugeepawdxoubgx.supabase.co/functions/v1/outreach-analytics?action=refresh&token=' || t,
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000
  ) into req_id;
  return req_id;
end;
$fn$;
revoke all on function sms_analytics.refresh_weekly() from public, anon, authenticated;

-- Full seed (kept for manual/occasional full rebuild).
create or replace function sms_analytics.seed_weekly()
returns bigint language plpgsql security definer set search_path to '' as $fn$
declare t text; req_id bigint;
begin
  select value into t from sms_analytics.config where key = 'dash_token';
  if t is null then raise exception 'dash_token ausente'; end if;
  select net.http_post(
    url := 'https://voivhkugeepawdxoubgx.supabase.co/functions/v1/outreach-analytics?action=seed&token=' || t,
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 150000
  ) into req_id;
  return req_id;
end;
$fn$;
revoke all on function sms_analytics.seed_weekly() from public, anon, authenticated;

-- After creating pg_net for the first time in the new project, run once:
--   select net.worker_restart();
-- Then schedule (in the new project):
--   select cron.schedule('outreach-analytics-backfill','*/2 * * * *', $$select sms_analytics.work_tick();$$);
--   -- pause when the initial backfill finishes:  select cron.alter_job(<id>, active := false);
--   select cron.schedule('outreach-weekly-refresh','0 11 * * 0', $$select sms_analytics.refresh_weekly();$$);
