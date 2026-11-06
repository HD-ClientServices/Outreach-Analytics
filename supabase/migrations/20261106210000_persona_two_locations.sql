-- Buyer Persona, también desde GHL 2.
--
-- La ingesta de secuencias ya lee las dos locations (20261106200000_two_ghl_locations.sql);
-- la persona seguía leyendo solo GHL 1. Como todo lead de tarjeta vive en GHL 2
-- desde el 27/10, los WON de Century desde entonces —los compradores que la
-- persona de Credit Card tiene que describir— no se veían: la vertical tenía 2
-- deals.
--
-- Cada paso sabe de qué location es, y se lee con la key de esa location:
--   persona_pipeline.location  la location del pipeline (los ids son únicos, pero
--                              el nombre no: hay un CENTURY CLOSING en cada una)
--   persona_won_opp.location   de dónde se expande el contacto -> conversaciones
--   call_transcript.location   de dónde se baja la grabación (la URL lleva la location)
--
-- Default = GHL 1 por lo mismo que en la migración anterior: todo lo que hay es
-- de GHL 1, se agrega sin reescribir las tablas, y la función vieja sigue andando
-- hasta el deploy. Correr DESPUÉS de 20261106200000 y ANTES de pushear.

alter table sms_analytics.persona_pipeline
  add column if not exists location text not null default 'NXZFG9aQz6r1UXzZoedy';

alter table sms_analytics.persona_won_opp
  add column if not exists location text not null default 'NXZFG9aQz6r1UXzZoedy';

alter table sms_analytics.call_transcript
  add column if not exists location text not null default 'NXZFG9aQz6r1UXzZoedy';

-- El CENTURY CLOSING de GHL 2 alimenta la persona de Credit Card, al lado del de
-- GHL 1 (que guarda los WON hasta el 26/10). Se puede destildar desde
-- "⚙ Pipelines". Sumarlo no gasta nada: el scan y la transcripción los dispara
-- un operador.
insert into sms_analytics.persona_pipeline(persona_key, pipeline_id, pipeline_name, location)
select 'cc', 'Y8J15LMCcNbdoHE3fb97', 'CENTURY CLOSING', 'oFkuULV6csxWj4T6RdT6'
 where exists (select 1 from sms_analytics.persona_config where key = 'cc')
on conflict do nothing;
