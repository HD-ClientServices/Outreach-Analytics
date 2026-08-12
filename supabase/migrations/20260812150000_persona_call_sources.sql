-- Segunda fuente de transcripción: las llamadas de los AI setters.
--
-- El scan de MCA salió limpio (71 de 72 ganados tienen una llamada del closer,
-- TYPE_CALL, con grabación en GHL). El de Credit Card devolvió 2 ganados y CERO
-- llamadas — y el motivo no era que no hubiera llamadas, sino que las de CC son
-- de otro tipo: TYPE_CUSTOM_CALL, logueadas por el marketplace app de Retell
-- (Anna/Sara/Kate). Su `altId` es un call_id de Retell.
--
-- Eso es una buena noticia: Retell YA guarda la transcripción, así que esas
-- llamadas no pasan por Deepgram. Son gratis, instantáneas y más fieles que
-- transcribir el audio nosotros.
--
-- Consecuencia de diseño: la fuente es por LLAMADA, no por persona.
--   source='ghl'    -> grabación de GHL -> Deepgram (cuesta: se encola SOLO la más larga)
--   source='retell' -> transcripción nativa de Retell (gratis: se encolan todas)

alter table sms_analytics.call_transcript
  add column if not exists source text not null default 'ghl',
  add column if not exists ext_id text;

-- El extract vive en la OPORTUNIDAD, no en la llamada: una persona se construye
-- sobre compradores, no sobre audios. Un contacto puede tener varias llamadas
-- (todas las de Retell) y todas juntas describen a UNA sola persona.
alter table sms_analytics.persona_won_opp
  add column if not exists extract jsonb,
  add column if not exists extract_at timestamptz;

create index if not exists persona_won_opp_extract_idx
  on sms_analytics.persona_won_opp(expanded) where extract is null;
