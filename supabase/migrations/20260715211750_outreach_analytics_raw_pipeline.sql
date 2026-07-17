-- Pipeline por lotes para Outreach Analytics.
-- La API de GHL no permite bajar ~9.600 contactos en una sola invocacion
-- (limite 100 req/10s => ~40 min). Se procesa en tandas via cron.

-- Un registro por contacto de la cohorte (denominador: "contactos ingresados").
create table if not exists sms_analytics.cohort (
  contact_id     text primary key,
  name           text,
  opp_created_at timestamptz,          -- cuando se creo la oportunidad
  won            boolean not null default false,
  won_at         timestamptz,
  wf             text,                 -- 'cc' | 'cold' | 'defdec' | 'none'
  entered_at     timestamptz,          -- fecha del 1er SMS outbound = ingreso real a la secuencia
  trigger_key    text,                 -- template que gatillo la 1a respuesta
  trigger_pos    int,
  replied        boolean not null default false,
  done           boolean not null default false,
  attempts       int not null default 0,
  fetched_at     timestamptz
);
create index if not exists cohort_pending_idx on sms_analytics.cohort(done, attempts) where not done;
create index if not exists cohort_wf_idx on sms_analytics.cohort(wf, entered_at);

-- Diccionario de templates (evita repetir el texto en cada evento).
create table if not exists sms_analytics.templates (
  tmpl_key text primary key,
  tmpl     text not null
);

-- Un registro por SMS outbound enviado. Es lo que da el denominador por mensaje
-- y permite recortar por ventana (7/14/30) sin re-extraer de GHL.
create table if not exists sms_analytics.msg_events (
  id         bigserial primary key,
  contact_id text not null,
  wf         text,
  tmpl_key   text not null,
  pos        int,                      -- posicion en la cadencia
  sent_at    timestamptz,
  got_reply  boolean not null default false,
  led_to_lt  boolean not null default false
);
create index if not exists msg_events_wf_idx on sms_analytics.msg_events(wf, sent_at);
create index if not exists msg_events_tmpl_idx on sms_analytics.msg_events(tmpl_key);
create index if not exists msg_events_contact_idx on sms_analytics.msg_events(contact_id);

-- Estado del run actual.
create table if not exists sms_analytics.run (
  id          int primary key default 1,
  started_at  timestamptz,
  seeded      int not null default 0,
  finished_at timestamptz,
  note        text,
  constraint run_singleton check (id = 1)
);
insert into sms_analytics.run(id) values (1) on conflict (id) do nothing;
