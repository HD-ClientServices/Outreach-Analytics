-- Dos garantías que el código decía tener y no tenía.
--
-- 1. `call_transcript.status='running'` + `claimed_at`.
--    El comentario de personaTranscribe afirmaba que "cada fila que sale de
--    queued ya no vuelve nunca, que es lo que hace que esto no se pueda usar
--    para quemar la cuota de Deepgram". Falso: el claim solo hacía
--    `attempts = attempts + 1` y dejaba `status='queued'` durante toda la
--    descarga + la llamada a Deepgram. `withDb` no abre transacción, así que
--    el `for update skip locked` se suelta en milisegundos y una segunda
--    invocación (el cron, otra pestaña) reclamaba la MISMA fila y la pagaba de
--    nuevo — hasta 3 veces por llamada.
--    Ahora el claim la saca de la cola. `claimed_at` permite recuperar las que
--    quedaron a medias cuando la edge function muere a los 150s.
--
-- 2. `persona_won_opp.extract_attempts`.
--    El extract no tenía contador de intentos (a diferencia de call_transcript).
--    Si extractOne devolvía null, no se persistía NADA: la fila seguía con
--    extract is null, la volvía a levantar el mismo `limit 4`, y el drain del
--    dashboard la reintentaba cada 600ms — pagando Anthropic cada vez, sin fin.

alter table sms_analytics.call_transcript
  add column if not exists claimed_at timestamptz;

create index if not exists call_transcript_running_idx
  on sms_analytics.call_transcript(claimed_at) where status = 'running';

alter table sms_analytics.persona_won_opp
  add column if not exists extract_attempts int not null default 0;

-- El índice de pendientes ahora tiene que respetar el tope de intentos, si no
-- vuelve el mismo bucle infinito por otra puerta.
drop index if exists sms_analytics.persona_won_opp_extract_idx;
create index if not exists persona_won_opp_extract_idx
  on sms_analytics.persona_won_opp(expanded, extract_attempts) where extract is null;
