-- Registro de secuencias medidas.
--
-- Hasta acá la tabla `workflows` solo traía el label y las keywords: el mapa de
-- "qué tag de GHL es qué secuencia" vivía hardcodeado en la edge function, así
-- que sumar una secuencia era editar y deployar código. Con `tags` acá, el alta
-- pasa a ser una fila (?action=workflow_add desde el dashboard).
--
--   tags       tags de GHL que marcan la secuencia, separados por coma. CC tiene
--              dos porque el workflow evolucionó y los contactos viejos quedaron
--              con el tag anterior.
--   ghl_id     id del workflow en GHL. Es lo que permite reconocer una secuencia
--              ya dada de alta aunque después la renombren.
--   sort       orden de listado Y prioridad de clasificación: si un contacto trae
--              tags de dos secuencias, gana la de sort más bajo.

alter table sms_analytics.workflows
  add column if not exists tags       text        not null default '',
  add column if not exists ghl_id     text,
  add column if not exists sort       int         not null default 100,
  add column if not exists created_at timestamptz not null default now();

-- Las 3 secuencias que ya se medían, con los tags que hasta ahora estaban en el
-- código. El sort respeta el orden de prioridad que tenía el if/else original
-- (cold > cc > defdec).
update sms_analytics.workflows
   set tags   = 'secuencia bfcb',
       ghl_id = 'b985c65c-a0c3-4cdc-a737-7da93b77e933',
       sort   = 10
 where key = 'cold';

update sms_analytics.workflows
   set tags   = 'debtmd sequence,secuencia partner cc',
       ghl_id = 'e28be9d2-ce89-4b6f-b85a-494d08912e58',
       sort   = 20
 where key = 'cc';

update sms_analytics.workflows
   set tags   = 'sent from partner',
       ghl_id = '69533301-b2f3-445e-8ebe-3f2227ba8c8e',
       sort   = 30
 where key = 'defdec';

create unique index if not exists workflows_ghl_id_uidx
  on sms_analytics.workflows(ghl_id) where ghl_id is not null;
