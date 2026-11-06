-- Dos locations de GHL.
--
-- Hasta acá la app leía UNA location: `ghl_location` + `ghl_api_key` de config,
-- que son GHL 1 (NXZFG9aQz6r1UXzZoedy). Desde el 27/10/2026 todo lead de tarjeta
-- vive en GHL 2 (oFkuULV6csxWj4T6RdT6): GHL 1 no tiene un solo contacto de CC
-- después del 26/10 y GHL 2 juntó 1.324. El workflow vivo es el "PARTNER
-- SEQUENCE - CREDIT CARD" de GHL 2; el homónimo de GHL 1 quedó en borrador. El
-- dashboard mostraba 0 contactos entrando a la secuencia de CC en 7 días, y un
-- A/B test de esa secuencia no se podía medir.
--
-- Ahora cada fila sabe de qué location es:
--   workflows.location   la location del workflow. Los tags se buscan solo entre
--                        los workflows de la location del contacto, así que el
--                        mismo tag en GHL 1 y en GHL 2 no se pisa.
--   cohort.location      con qué location (y con qué key) se baja el contacto.
--   msg_events.location  de dónde salió el SMS.
--   cohort.phone_key     hash del teléfono normalizado. La rotación de tokens dejó
--                        ~1.460 teléfonos con un contacto en cada location
--                        (sep–nov); build() cuenta a la persona una sola vez. No
--                        es anonimización —un teléfono de 10 dígitos se puede
--                        recuperar por fuerza bruta—, es para no tenerlo a la
--                        vista. '' = el contacto no tiene teléfono.
--
-- El default de `location` es GHL 1 a propósito: todo lo que hay hoy es de GHL 1,
-- se agrega sin reescribir las tablas (default constante = solo metadata) y la
-- versión vieja de la edge function, que no conoce la columna, sigue andando
-- entre que se corre esto y se despliega la nueva. La nueva escribe la location
-- siempre.
--
-- ORDEN: correr esta migración ANTES de pushear a main (el push despliega).

alter table sms_analytics.workflows
  add column if not exists location text not null default 'NXZFG9aQz6r1UXzZoedy';

alter table sms_analytics.cohort
  add column if not exists location  text not null default 'NXZFG9aQz6r1UXzZoedy',
  add column if not exists phone_key text;

alter table sms_analytics.msg_events
  add column if not exists location text not null default 'NXZFG9aQz6r1UXzZoedy';

create index if not exists cohort_location_idx on sms_analytics.cohort(location, done);
create index if not exists cohort_phone_key_idx on sms_analytics.cohort(phone_key) where phone_key <> '';

-- La segunda location. GHL n se configura con `ghl_location_n` + `ghl_api_key_n`;
-- GHL 1 sigue siendo `ghl_location` + `ghl_api_key`. Sin key, la location se
-- ignora (y ?action=status / "+ Add a sequence" lo avisan).
--
-- La key NO va acá: se carga a mano desde el SQL editor de Supabase —
--   insert into sms_analytics.config(key, value) values ('ghl_api_key_2', '<token de GHL 2>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
insert into sms_analytics.config(key, value)
values ('ghl_location_2', 'oFkuULV6csxWj4T6RdT6')
on conflict (key) do nothing;

-- La secuencia de CC de GHL 2. Pone `secuencia partner cc` al entrar y lo cambia
-- por `cc sequence finished` al terminar (en GHL 1 el fin era `debtmd sequence
-- finished`): sin el tag de fin, un contacto que ya terminó cae en 'none' y
-- pierde sus eventos. `debtmd sequence` / `debtmd sequence finished` también
-- existen en GHL 2, del tramo 17/09–20/10 en que tarjeta ya operaba ahí.
--
-- Sin copies en OFFICIAL a propósito: la tabla de mensajes muestra lo que salió
-- bajo el tag, así la rama B del A/B test aparece sola en vez de quedar filtrada
-- contra el guion de la A. La fila `cc` (GHL 1) queda para el histórico y se
-- vacía sola cuando sus contactos salgan de la ventana (~28/11).
insert into sms_analytics.workflows(key, label, keywords, tags, ghl_id, sort, location)
values ('cc_ghl2', 'PARTNER SEQUENCE - CREDIT CARD', '',
        'secuencia partner cc,cc sequence finished,debtmd sequence,debtmd sequence finished',
        'fab9d8f8-01dc-4513-bd22-9911ce7b8722', 25, 'oFkuULV6csxWj4T6RdT6')
on conflict do nothing;
