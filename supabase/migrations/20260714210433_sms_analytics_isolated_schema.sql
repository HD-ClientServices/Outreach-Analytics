create schema if not exists sms_analytics;

create table if not exists sms_analytics.config (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

create table if not exists sms_analytics.snapshots (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  window_days int,
  total_won int,
  data jsonb not null
);

alter table sms_analytics.config enable row level security;
alter table sms_analytics.snapshots enable row level security;
