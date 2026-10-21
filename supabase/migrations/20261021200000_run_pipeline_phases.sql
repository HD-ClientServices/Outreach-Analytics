-- Fases del pipeline en `run`, para que el cierre (markwon + build) sea un paso
-- propio con reintento. Ver 20261021200100_work_tick_phases.sql.
--
-- phase_at    = cuándo work_tick disparó la fase en curso ('marking'/'building').
-- phase_tries = intentos de esa fase; work_tick se rinde a los 4 y queda visible
--               en ?action=status en vez de reintentar para siempre.

alter table sms_analytics.run
  add column if not exists phase_at timestamptz,
  add column if not exists phase_tries int not null default 0;
