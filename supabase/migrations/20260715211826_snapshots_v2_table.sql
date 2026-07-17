-- Tabla separada: el dashboard viejo sigue leyendo sms_analytics.snapshots
-- (formato v1) hasta que el nuevo lo reemplace.
create table if not exists sms_analytics.snapshots_v2 (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
