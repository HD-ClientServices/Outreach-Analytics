-- Ingesta automática semanal.
--
-- `refresh_weekly()` existía, estaba deployada y era correcta desde el arranque
-- del proyecto: la línea que la agenda vivía en el bloque de instrucciones de
-- schema_new_project.sql y simplemente nunca se corrió. Se descomentó solo la
-- del drenador.
--
-- El efecto fue que la app parecía automática y no lo era: `work_tick()` corre
-- cada 2 minutos pero arranca con un early-return si no hay filas pendientes, o
-- sea DRENA lo que otro encoló y nunca sale a buscar datos. Sin este job, las
-- únicas dos acciones que traen datos de GHL (`seed` y `refresh`) dependían del
-- botón del dashboard. Entre el 21/07 y el 14/08 el cron registró 17.412
-- corridas "exitosas" sin traer un solo dato — porque no hacer nada también
-- cuenta como éxito.
--
-- Se agenda acá para que quede en el repo y no se vuelva a perder en un
-- bloque comentado.

select cron.schedule(
  'outreach-weekly-refresh',
  '0 11 * * 0',                      -- domingos 11:00 UTC = 7am ET
  $$select sms_analytics.refresh_weekly();$$
);

-- Nota operativa: el 19/07/2026 el refresco semanal falló por rate limit (429)
-- del token de GHL, que se comparte con el producto Intro. Si vuelve a pasar, la
-- salida no es reintentar más seguido sino un token dedicado — `refresh()` es
-- incremental y aditivo, así que un 429 no borra nada, solo enumera de menos, y
-- desde el fix de `last_refresh_ms` el tramo que no llegó a recorrer queda
-- pendiente para la corrida siguiente en vez de saltearse para siempre.
