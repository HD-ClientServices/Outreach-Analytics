# Outreach Analytics

Rendimiento de las secuencias SMS outbound de GoHighLevel, con la métrica que importa:

```
CR de secuencia = live transfers ÷ contactos ingresados
```

…y, desde el tab **Buyer Persona**, quién compra: dos verticales (MCA y Credit Card) escritas
desde las transcripciones de las llamadas que terminaron en WON.

Estado: **backfill completo, clasificación incompleta.** Ver [Pendientes](#pendientes).

---

## Cómo funciona

Todo corre en Supabase (proyecto `voivhkugeepawdxoubgx` · *Outreach Analytics*), esquema aislado
`sms_analytics`. Nada depende de una máquina local.

```
GHL API v2 ──▶ edge function `outreach-analytics` ──▶ sms_analytics.* ──▶ dashboard HTML
                        ▲
                   pg_cron + pg_net
```

### El problema que resuelve el diseño

La API de GHL **no expone `workflowId` en los mensajes**. No hay forma de preguntar
"¿qué workflow mandó este SMS?". La señal es el **tag**: cada workflow medido pone un tag
al contacto apenas entra, y ese tag dice a qué secuencia pertenece toda su conversación.
(El histórico previo a los tags se atribuyó comparando el **primer SMS outbound** contra el
SMS 1 de cada workflow; para las ramas ese respaldo sigue vivo en `branchOf()`.)

Además la API limita a 100 req/10s: bajar ~9.500 contactos son ~40 min, y una edge function
muere a los ~150s. Por eso el pipeline es **por lotes**, empujado por cron.

### Tablas

| Tabla | Qué guarda |
|---|---|
| `config` | `ghl_api_key` (read-only), `ghl_location`, `dash_token`, `anthropic_api_key`, `retell_api_key`, `deepgram_api_key`. **Los secretos viven acá, no en el código.** |
| `cohort` | Un registro por contacto (9.508). `entered_at` = fecha del 1er SMS = ingreso real a la secuencia. Es el **denominador**. |
| `msg_events` | Un registro por SMS enviado (220.649), con fecha, posición en la cadencia, si tuvo respuesta y si derivó en LT. |
| `templates` | Diccionario `tmpl_key → texto`, para no repetir el texto en cada evento. |
| `snapshots_v2` | Salida del `build`: las 3 ventanas precalculadas. |
| `run` | Estado del backfill. |
| `workflows` | Una fila por secuencia medida: `key`, `label`, `tags` (los tags de GHL que la marcan), `ghl_id`, `sort`. **Es el registro que da de alta una secuencia** — ver [Sumar una secuencia](#sumar-una-secuencia-nueva). |
| `persona_config` · `persona_pipeline` | Una fila por vertical (`mca`, `cc`, …) y sus pipelines de Closing. **La selección de pipelines de la interfaz vive acá**, no en el código. |
| `persona_won_opp` | Una fila por oportunidad ganada, con `extract` = la ficha del comprador. |
| `call_transcript` | Cola **y** almacén de transcripciones. `unique(message_id, rec_index)`. |
| `persona_doc` · `persona_run` | El documento generado (JSON + markdown) y la fase de la corrida. |

> **Las ventanas 7/14/30 salen de UNA sola extracción de 30 días**, filtrando `sent_at`/`entered_at`.
> Nunca correr tres extracciones.

### Acciones de la edge function

Dos niveles de acceso (ver [Seguridad](#seguridad)):
- **Lectura (abiertas, sin token):** `data`, `status`, `context`. Las consume el dashboard directo.
- **Operador (exigen `?token=<dash_token>`):** `seed`, `refresh`, `markwon`, `work`, `build`, `generate`, `insight_ai`. Mutan la base o gastan API (GHL/Anthropic).

| Acción | Nivel | Qué hace |
|---|---|---|
| `?action=seed` | operador | Arma la cohorte desde `opportunities/search` (30d). **Trunca `cohort` y `msg_events`.** |
| `?action=work&ms=100000` | operador | Procesa una tanda acotada por tiempo. Devuelve `{processed, remaining}`. Al llegar a 0 dispara `build` solo. |
| `?action=build` | operador | Recalcula las 3 ventanas e inserta en `snapshots_v2`. |
| `?action=refresh` | operador | Actualización incremental on-demand. |
| `?action=generate` / `insight_ai` | operador | Llaman a la API de Anthropic (**gastan plata**). |
| `?action=status` | lectura | Progreso del backfill. |
| `?action=data` | lectura | Último snapshot. Lo consume el dashboard. |
| `?action=personas` / `persona_data` / `persona_status` | lectura | Verticales configuradas, el documento vigente y el estado de una corrida. |
| `?action=ghl_pipelines` | lectura | Los pipelines de GHL, para la UI de selección. |
| `?action=ghl_workflows` | lectura | Los workflows de GHL, marcando cuáles ya se miden y con qué tag. Lo consume "+ Add a sequence". |
| `?action=workflow_add` | operador | POST `{id,name}` → da de alta la secuencia y devuelve el tag exacto que hay que poner en GHL. |
| `?action=workflow_remove` | operador | POST `{key}` → deja de medirla. No borra `cohort`/`msg_events`. |
| `?action=persona_save` | operador | Guarda una vertical y sus pipelines. Crear una nueva = POST con `key` nuevo. |
| `?action=persona_scan&key=` | operador | Barre los WON de esos pipelines y encola sus llamadas. `&dry=1` no escribe. **Gratis.** |
| `?action=persona_transcribe&key=` | operador | Drena la cola. Retell es gratis; GHL pasa por **Deepgram (gasta)**. |
| `?action=persona_extract&key=` | operador | Una ficha por comprador. **Gasta Anthropic** (poco, y queda cacheada). |
| `?action=persona_build&key=` | operador | Agrega en código + una llamada a Claude → nuevo documento. |

### Correr un backfill de cero

```sql
-- 1. sembrar (usa curl, tarda ~65s)
--    GET .../outreach-analytics?action=seed&token=...

-- 2. empujar con cron cada 2 min (~40 min en total)
select cron.schedule('outreach-analytics-backfill', '*/2 * * * *',
                     $$select sms_analytics.work_tick();$$);

-- 3. cuando termine, apagarlo
select cron.alter_job(job_id := <id>, active := false);
```

`work` es **idempotente y seguro ante solapamiento**: reclama filas con
`for update skip locked` y borra los eventos previos del contacto antes de insertar.

### Sumar una secuencia nueva

Desde el dashboard: **Performance → “+ Add a sequence”** lista los workflows de la location,
y al elegir uno muestra los tags exactos que hay que configurar en GHL. Sumar una secuencia
**ya no es tocar código**: es una fila en `workflows`.

El contrato son dos tags, y el nombre lo elige el sistema — si se escribe distinto, no clasifica:

| Tag | Dónde va | Para qué |
|---|---|---|
| `secuencia <nombre del workflow>` | Primera acción del workflow, antes del 1er mensaje | Marca a qué secuencia pertenece el contacto |
| `rama a`, `rama b`, … | Dentro de **cada** rama del split | Separa las ramas del A/B test |

El tag lo deriva `tagFromName()` del nombre del workflow (sin acentos ni emojis, cortado en
palabras enteras) y se desambigua con un sufijo si ya existe. La prioridad, cuando un contacto
trae tags de dos secuencias, es la columna `sort` — la misma que ordena la lista en pantalla.

Dos consecuencias que conviene decir en voz alta:

- **Los tags no son retroactivos.** Solo los contactos que entran *después* de configurarlos
  los llevan, así que una secuencia recién dada de alta arranca vacía y se llena de ahí en más.
- **Las secuencias nuevas no tienen copies oficiales cargados** (`OFFICIAL` en `index.ts` es de
  las 3 viejas). Para ellas el filtro es el tag mismo: se muestra el texto tal cual salió,
  agrupado por esqueleto, con un piso de `NEW_SEQ_MIN_SENDS` envíos para cortar el ruido.

---

## Buyer Persona

Dos verticales — **MCA** y **Credit Card** — generadas desde las transcripciones de las llamadas
de las oportunidades en estado WON de los pipelines de Closing que se eligen **desde la interfaz**.

```
persona_scan  →  persona_transcribe  →  persona_extract  →  persona_build
 (GHL, $0)        (Retell $0 / Deepgram $)   (Anthropic, cacheado)   (1 llamada)
```

### Qué cuenta como "ganado"

`status === 'won'`, no el stage. Es el hecho de negocio, no la posición de una tarjeta: un won
parado en "Contract Sent" sigue siendo un comprador y su llamada sigue siendo evidencia. Eso
explica el 70 vs 61 de RISE. Además no exige que exista un stage llamado "Won", así que un buyer
futuro cuyo stage se llame "Funded" entra sin tocar código. Igual el barrido es `status=all` y
clasifica en código, así que **las dos señales quedan guardadas** en `won_src`: ampliar después
no requiere re-scanear.

### Dos fuentes de transcripción, elegidas por llamada

GHL guarda el **audio**, no el texto. Pero no todas las llamadas son iguales:

| Tipo en GHL | Quién llama | De dónde sale el texto | Costo | Cuántas se encolan |
|---|---|---|---|---|
| `TYPE_CALL` | closer humano (dialer de GHL) | descarga del audio → **Deepgram** (`nova-3`, `language=multi`) | ~US$0,004/min | **solo la más larga** por contacto |
| `TYPE_CUSTOM_CALL` | AI setter (Anna/Sara/Kate) | **Retell**, que ya guarda la transcripción | $0 | **todas** |

`language=multi` es innegociable: ~1 de cada 6 llamadas es en español y con `language=en`
Deepgram devuelve basura con alta confianza, que envenenaría la persona en silencio.

`call_transcript` guarda `pipeline_id`, **no** `persona_key` — la vertical sale de un join contra
`persona_pipeline`. Mover un pipeline entre verticales, o sumar uno nuevo desde la interfaz,
re-agrupa lo ya transcripto **sin volver a pagar**.

### Los números los calcula el código, no el modelo

`personaAggregate()` produce las medianas y los conteos con su denominador en TypeScript. El
modelo recibe esa tabla y **solo escribe la prosa**, atado a la regla de que todo número que
escriba tiene que aparecer textual en el bloque AGGREGATE. Con muestra chica (por debajo de
`min_sample`) se le prohíben los porcentajes —con N=2 un porcentaje es una mentira disfrazada de
dato— y además se limpian en código por si el prompt no alcanzó.

El extract vive en la **oportunidad**, no en la llamada: la unidad de una buyer persona es el
comprador, no el audio.

### Estado actual

| Vertical | Compradores ganados | Fuente | Estado |
|---|--:|---|---|
| MCA | 70 leídos (de 72 ganados) | closer, GHL → Deepgram | ✅ generado · 71/71 llamadas transcriptas · 1.992 min · confianza media |
| Credit Card | 2 | AI setter, Retell | ✅ generado, con aviso de muestra chica |

⚠️ Credit Card tiene **2 deals**. Es direccional, no estadístico, y el dashboard lo dice.

### Validación convergente (MCA, 13/08/2026)

La persona generada desde las 70 llamadas se contrastó contra el documento que
una persona escribió a mano sobre esta misma población. Partiendo de audio
transcripto de forma independiente:

| | Escrito a mano (67) | Generado (70) |
|---|---|---|
| Deuda mediana | $111k | **$118,5k** |
| Posiciones apiladas | 2 a 6 · 9 de cada 10 | mediana **3** · 57/65 con 2+ |
| Pago | $3k-$20k/semana | mediana **$4.500**, semanal en 61 |
| Oficios/contratistas | 55% | **37,1%** |
| Quemado por un bróker previo | 25% | **30%** |
| Acoso o juicios | 24% | **30%** |
| Pago por adelantado | 31% | **25,7%** |
| Impacto en el crédito | 13% | **10%** |
| Alivio ya (driver #1) | 90% | **94,3%** |
| Protección legal | 24% | **35,7%** |

Las objeciones y los drivers caen casi encima. Diverge el share de español
(17% a mano vs 8,6%) y el peso de los oficios, que acá se reparte más entre
food & retail.

> **Lección que dejó el primer intento:** con los campos categóricos en texto
> libre, la persona concluyó *"ninguna industria domina"* — porque "construction",
> "general contracting" y "commercial site work/construction" contaban por
> separado. Y `wants_to_pay` volvió 60 `true` / 0 `false` / 5 con montos en
> dólares: cero desacuerdos no es un dato, es un extractor que infiere. Por eso
> los vocabularios están cerrados y `wants_to_pay` exige mención explícita.

---

## Dashboard

`dashboard/index.html` — autocontenido, lee `?action=data` en vivo. Sigue el design system
de Intro (tokens tomados de tryintro.com): Inter 300 con tracking `-0.03em`, superficie
`#fdfcfc`, accent negro, highlight `#fef8d4`, verde `#16a34a`, JetBrains Mono para números.

Las tarjetas de Buyer Persona se arman desde `?action=persona_data`, pero **el número, el título
y la ayuda de cada sección son copy del código**, no salida del modelo: la IA solo llena las
líneas. Por eso el layout no puede romperse por lo que se le ocurra escribir. El texto se escapa
primero y recién después se le permiten dos cosas, `**negrita**` y `"comillas"` — el endpoint es
abierto y el render nunca confía en lo que viene de la base.

> **Cada request tarda ~4,4s**, y no es el trabajo: son las conexiones a Postgres. Cada
> `withDb()` abre una conexión nueva contra el host directo (~1,9s). Config y workflows ya
> comparten una sola conexión memoizada —eso sacó ~1,8s—, pero cada acción sigue abriendo la
> suya. Falta un pool, o usar el pooler (puerto 6543) en vez del host directo.

Marca monocromática con verde de acento: **no se asignan colores por secuencia** — son filas
rotuladas, no series superpuestas.

> **Supabase bloquea HTML en todo `*.supabase.co`** (reescribe `text/html` → `text/plain` +
> `nosniff`, anti-phishing). Aplica a functions **y** a Storage. Por eso el HTML se sirve desde
> Netlify. `application/json` sí pasa intacto.

---

## Números actuales (30 días)

| Secuencia | LT | Ingresados | CR |
|---|---|---|---|
| V2 · BULK FUP COLD BLAST | 41 | 960 | **4.3%** |
| PARTNER · Defaults & Declined | 57 | 4.347 | **1.3%** |
| Partner CC · DebtMD v2 | 2 | 9 | 22.2% ⚠️ muestra chica |
| *(fuera de las 3)* | 35 | 513 | — |

El Cold Blast convierte **3,3× mejor** que Defaults & Declined.

Los ingresados suman 5.829 de 9.508: el resto entró a su secuencia *antes* de la ventana.
Por eso los LT acá (135) no coinciden con los 218 del dashboard viejo, que contaba distinto.

---

## Pendientes

### 1. La clasificación por workflow está incompleta ⚠️

Los patrones en `WF` (arriba de `index.ts`) salen de los SMS 1 que se aportaron, pero **no
coinciden con lo que se envía de verdad**:

- **Partner CC · DebtMD**: su SMS 1 declarado aparece 2 veces en toda la base. El opener real
  parece ser `"Anna/Sara here… About improving those CC terms"` (~47 contactos).
- **~513 contactos quedan fuera de las 3.** Grupos grandes sin identificar:
  - `"{Maria/Camila/Santiago/James} here from my personal number"` (~338) ← **el más pesado**
  - `"we do MCA relief"` (~91)
  - `"your MCA pays itself first weekly"` (42)

Si esos 338 son del Cold Blast, su denominador casi se duplica y **su CR cae a la mitad**.

**Reclasificar NO requiere re-extraer.** `msg_events.pos = 1` + `templates` tienen el primer
SMS de cada contacto; se rehace con SQL en segundos:

```sql
select count(*), left(t.tmpl,120)
from sms_analytics.msg_events e
join sms_analytics.cohort c on c.contact_id = e.contact_id
join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
where e.pos = 1 and c.wf = 'none'
group by 2 order by 1 desc;
```

### 2. La métrica por mensaje está sin decidir

`build` calcula las dos y el dashboard las togglea:

- **`replyRate`** (respuestas ÷ enviados) — premia **recordatorios de llamada**
  (*"your MCA call starts in 5 MIN"*, 19–60%), que responden alto porque el lead ya dijo que sí.
  No es prospección.
- **`ltRate`** (LT ÷ enviados) — otro ganador (*"Sara at Settlegroup, following up"*, 16.7%).

**Cambia qué mensaje parece el mejor.** No es cosmético.

### 3. Silo paralelo al producto Intro

La misma base ya tiene `leads`, `live_transfers`, `conversation_messages`, `call_recordings`.
`sms_analytics` re-extrae de GHL cosas que en parte ya están ahí → **dos fuentes de verdad que
van a divergir**. (`conversation_messages` no sirvió como sustituto: cubre 806/9.508 de la
cohorte y solo 15 días.)

Antes de meter esto en `app.tryintro.com`, decidir si debe leer de esas tablas.

---

## Crons (ambos pausados)

| Job | Schedule | Estado | Por qué |
|---|---|---|---|
| `sms-secuencias-refresh-domingo` | `0 11 * * 0` | ⏸ pausado | La v3 de `sms-secuencias` guarda otro formato y rompería el dashboard viejo. |
| `outreach-analytics-backfill` | `*/2 * * * *` | ⏸ pausado | Backfill terminado. |

⚠️ **No apretar "Actualizar datos" en el dashboard viejo de Netlify**: llama a
`sms-secuencias?action=refresh`, que guarda formato nuevo y lo rompe.

## Seguridad

Modelo de acceso (rediseñado 21/07/2026 — el token salió de la URL del dashboard):

- **Ver el dashboard es abierto.** El link `outreach-analytics.netlify.app` (sin `?token=`)
  carga métricas, persona e insights. La "privacidad" es el link mismo: quien lo tenga, entra.
  Corolario honesto: las acciones de **lectura** (`data`/`status`/`context`) son accesibles por
  cualquiera que conozca la URL (Netlify **o** la de la edge function). CORS = `*`. No hay login.
- **Las acciones de operador** (`refresh`/`seed`/`generate`/`insight_ai`/`work`/`build`/`markwon`)
  exigen `cfg.dash_token`. El dashboard lo **pide una vez por sesión** (prompt → `sessionStorage`)
  y lo manda por `?token=` **solo** en esas llamadas — nunca vive en la URL de la página ni en el
  JS servido. Así, quien encuentre el link puede mirar pero no puede quemar la cuota de API.
- Los **crons** mandan el `dash_token` server-side (`net.http_post`), siguen funcionando igual.
- Token de GHL y key de Anthropic **read-only/secretas**, en `sms_analytics.config`.
  Nunca en el código ni en el repo. Ningún endpoint las devuelve al cliente.
- Si el link se filtra: rotar `cfg.dash_token` (corta a los operadores) y/o mover el sitio a un
  subdominio nuevo. Para privacidad real haría falta un login (no implementado, fue decisión).

### Control de gasto en un endpoint abierto

El link es la barrera de **acceso**; el `unique(message_id, rec_index)` de `call_transcript` es la
barrera de **gasto**. `persona_transcribe` no se puede apuntar a audio arbitrario: solo procesa
filas que creó un `persona_scan` a partir de WONs de pipelines configurados. Quien loopee el
endpoint recibe `{remaining: 0}` y no gasta nada, porque una llamada ya transcripta no vuelve a
Deepgram. Encima hay un tope diario de minutos (`config.persona_daily_minutes_cap`, 600 por
defecto) que solo cuenta lo que pasa por Deepgram — Retell es gratis y no consume cuota.

⚠️ `retell_api_key` es la key de **producción con acceso total** (puede crear llamadas y gastar
saldo). Acá se usa solo para leer (`GET /v2/get-call`). Ningún endpoint la devuelve al cliente,
pero conviene reemplazarla por una de solo lectura cuando se pueda.
# Rebuilt
