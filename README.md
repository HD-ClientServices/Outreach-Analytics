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
GHL 1 ─┐
       ├─ API v2 ──▶ edge function `outreach-analytics` ──▶ sms_analytics.* ──▶ dashboard HTML
GHL 2 ─┘                        ▲
                           pg_cron + pg_net
```

### Dos locations de GHL

Desde el 6/11/2026 la app lee **las dos locations** de GoHighLevel, cada una con su key:

| | Location | Config | Qué vive ahí |
|---|---|---|---|
| GHL 1 | `NXZFG9aQz6r1UXzZoedy` | `ghl_location` + `ghl_api_key` | MCA (Cold Blast, Defaults & Declined) y CC hasta el 26/10 |
| GHL 2 | `oFkuULV6csxWj4T6RdT6` | `ghl_location_2` + `ghl_api_key_2` | CC desde el 27/10 ("PARTNER SEQUENCE - CREDIT CARD") |

Hasta ahí solo se leía GHL 1, y como todo lead de tarjeta pasó a GHL 2 el 27/10, el dashboard
mostraba **0 contactos entrando a la secuencia de CC** en 7 días: un A/B test de esa secuencia
no se podía medir. Una tercera location es `ghl_location_3` + `ghl_api_key_3`, sin tocar código.

- **Cada fila sabe de qué location es** (`workflows`, `cohort`, `msg_events`). Un contacto se
  clasifica solo contra los workflows de su location: GHL 1 y GHL 2 tienen los dos el tag
  `secuencia partner cc` y no se pisan.
- **El cupo de 100 req/10s es por location**, así que se cuenta por key (`ghlSlot()`, con margen
  de 90 porque el token de GHL 1 lo comparte el producto Intro) y las locations se recorren en
  paralelo: dos tardan lo mismo que una.
- **Una persona cuenta una vez.** La rotación de tokens dejó ~1.460 teléfonos con un contacto en
  cada location (sep–nov). `build()` arma `cohort_u`, un contacto por teléfono: el que está en
  una secuencia medida le gana a uno `none`, y entre ésos el que entró **primero** (igual que una
  re-entrada en un mismo contacto, que tampoco es un ingreso nuevo). El LT es de la persona: si
  cualquiera de sus contactos llegó a LT, cuenta para el que quedó. Para el A/B test de GHL 2 eso
  significa que un lead que ya recibió la secuencia en GHL 1 no entra como nuevo a la rama A o B.
  El dashboard dice cuántos contactos se juntaron, al pie.
- **El LT sale igual en las dos**: etapa "Lead Ganado (+60s)" de un pipeline `*OPENING*`. En
  GHL 2 eso es CENTURY OPENING; AI OPENING no tiene esa etapa (su "Transferido" no cuenta),
  igual que en GHL 1.

### El problema que resuelve el diseño

La API de GHL **no expone `workflowId` en los mensajes**. No hay forma de preguntar
"¿qué workflow mandó este SMS?". La señal es el **tag**: cada workflow medido pone un tag
al contacto apenas entra, y ese tag dice a qué secuencia pertenece toda su conversación.
(El histórico previo a los tags se atribuyó comparando el **primer SMS outbound** contra el
SMS 1 de cada workflow; para las ramas ese respaldo sigue vivo en `branchOf()`.)

Además la API limita a 100 req/10s **por location**: bajar ~9.500 contactos son ~40 min, y una
edge function muere a los ~150s. Por eso el pipeline es **por lotes**, empujado por cron. Con dos
locations la regla de los 150s no cambia: cada enumeración corta a los 105s
(`ENUM_DEADLINE_MS`) y corren en paralelo, no una detrás de la otra.

### Tablas

| Tabla | Qué guarda |
|---|---|
| `config` | `ghl_api_key` (read-only) + `ghl_location` = GHL 1; `ghl_api_key_2` + `ghl_location_2` = GHL 2; `last_refresh_ms` / `last_refresh_ms_2` (hasta dónde se leyó cada una); `dash_token`, `anthropic_api_key`, `retell_api_key`, `deepgram_api_key`. **Los secretos viven acá, no en el código.** Una location sin key se ignora y `?action=status` lo avisa. |
| `cohort` | Un registro por contacto (9.508). `entered_at` = fecha del 1er SMS = ingreso real a la secuencia. Es el **denominador**. `location` = de qué location se baja; `phone_key` = hash del teléfono para juntar a la misma persona entre locations (`''` = sin teléfono, `null` = procesada antes de que existiera). |
| `msg_events` | Un registro por SMS enviado (220.649), con fecha, posición en la cadencia, si tuvo respuesta, si derivó en LT y de qué `location` salió. |
| `templates` | Diccionario `tmpl_key → texto`, para no repetir el texto en cada evento. |
| `snapshots_v2` | Salida del `build`: las 3 ventanas precalculadas. |
| `run` | Estado del backfill. |
| `workflows` | Una fila por secuencia medida: `key`, `label`, `tags` (los tags de GHL que la marcan), `ghl_id`, `sort`, `location`. **Es el registro que da de alta una secuencia** — ver [Sumar una secuencia](#sumar-una-secuencia-nueva). `cc` es la de CC en GHL 1 (histórico, se vacía hacia el 28/11) y `cc_ghl2` la viva, en GHL 2. |
| `persona_config` · `persona_pipeline` | Una fila por vertical (`mca`, `cc`, …) y sus pipelines de Closing, cada uno con su `location`. **La selección de pipelines de la interfaz vive acá**, no en el código. |
| `persona_won_opp` | Una fila por oportunidad ganada, con `extract` = la ficha del comprador y la `location` de donde se expande. |
| `call_transcript` | Cola **y** almacén de transcripciones. `unique(message_id, rec_index)`. `location` = de dónde se baja la grabación. |
| `persona_doc` · `persona_run` | El documento generado (JSON + markdown) y la fase de la corrida. |

> **Las ventanas 7/14/30 salen de UNA sola extracción de 30 días**, filtrando `sent_at`/`entered_at`.
> Nunca correr tres extracciones.

### Acciones de la edge function

Dos niveles de acceso (ver [Seguridad](#seguridad)):
- **Lectura (abiertas, sin token):** `data`, `status`, `context`. Las consume el dashboard directo.
- **Operador (exigen `?token=<dash_token>`):** `seed`, `refresh`, `markwon`, `work`, `build`, `generate`, `insight_ai`. Mutan la base o gastan API (GHL/Anthropic).

| Acción | Nivel | Qué hace |
|---|---|---|
| `?action=seed` | operador | Arma la cohorte con las conversaciones de los últimos 30d de cada location. **Trunca `cohort` y `msg_events`.** `&loc=<location id>` re-siembra solo esa location y deja las demás intactas. |
| `?action=work&ms=100000` | operador | Procesa una tanda acotada por tiempo. Devuelve `{processed, remaining}`. Al llegar a 0 dispara `build` solo. |
| `?action=build` | operador | Recalcula las 3 ventanas e inserta en `snapshots_v2`. |
| `?action=refresh` | operador | Actualización incremental on-demand, location por location. Una location **sin filas** en la cohorte (la primera vez que se configura) se siembra sola en ese request; las demás se ponen al día en el refresh siguiente (la respuesta trae `next: "refresh"`). |
| `?action=generate` / `insight_ai` | operador | Llaman a la API de Anthropic (**gastan plata**). |
| `?action=status` | lectura | Progreso del backfill, total y por location (`locations[]`: total, done, pending, failed y si le falta la key). |
| `?action=data` | lectura | Último snapshot. Lo consume el dashboard. |
| `?action=personas` / `persona_data` / `persona_status` | lectura | Verticales configuradas, el documento vigente y el estado de una corrida. |
| `?action=ghl_pipelines` | lectura | Los pipelines de **todas** las locations (cada uno con `location`/`loc`), para la UI de selección. `locations[]` dice si alguna no se pudo leer. |
| `?action=ghl_workflows` | lectura | Los workflows de **todas** las locations (cada uno con `location`/`loc`), marcando cuáles ya se miden y con qué tag. Lo consume "+ Add a sequence". `locations[]` dice si alguna no se pudo leer. |
| `?action=workflow_add` | operador | POST `{id,name,location}` → da de alta la secuencia en esa location y devuelve el tag exacto que hay que poner en GHL. Sin `location`, GHL 1. |
| `?action=workflow_remove` | operador | POST `{key}` → deja de medirla. No borra `cohort`/`msg_events`. |
| `?action=persona_save` | operador | Guarda una vertical y sus pipelines (`{id,name,location}`; sin `location`, la que ya tenía ese pipeline o GHL 1). Crear una nueva = POST con `key` nuevo. |
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
`for update skip locked` y borra los eventos previos del contacto antes de insertar. Cada
contacto se baja de su location con la key de esa location; un lote mezcla locations, así que
mientras una espera su cupo la otra sigue. Si GHL no contesta, el contacto queda pendiente y se
reintenta (hasta 3 veces) en vez de darse por procesado sin secuencia, que es lo que pasaba antes.

Para sumar **una location nueva** no hace falta un seed: cargar `ghl_location_n` + `ghl_api_key_n`
en `config` y apretar **↻ Refresh** dos veces. El primero ve que esa location no tiene filas y
la siembra **sola**; el segundo pone al día a las demás. El cron drena lo que encolen.

La key es un **Private Integration token** creado dentro de esa sub-cuenta (`pit-…`, 40
caracteres). La "API Key" de Business Profile es de la API v1 y GHL la rechaza con
`401 Invalid JWT`: `?action=ghl_workflows` → `locations[].error` muestra la respuesta de GHL.

> ⚠️ **Lección del 10/11/2026.** El primer refresh con GHL 2 sembraba GHL 2 y, en el mismo
> request, ponía al día GHL 1: murió con `WORKER_RESOURCE_LIMIT` (tope de cómputo de la edge
> function). La transacción lo revirtió entero, así que no quedó nada a medias. El mismo trabajo
> en dos requests (`?action=seed&loc=<GHL 2>` y después `?action=refresh`) anduvo: 12s y 131s.
> Por eso ahora el refresh siembra una location nueva sola.

### Sumar una secuencia nueva

Desde el dashboard: **Performance → “+ Add a sequence”** lista los workflows de **las dos
locations** (con su `GHL 1` / `GHL 2` al lado: el "PARTNER SEQUENCE - CREDIT CARD" existe en las
dos, y el vivo es el de GHL 2), y al elegir uno muestra los tags exactos que hay que configurar en
GHL. Sumar una secuencia **ya no es tocar código**: es una fila en `workflows`, con su `location`.
Los tags son de cada location: el que se sugiere solo tiene que ser único dentro de la suya.

El contrato son dos tags, y el nombre lo elige el sistema — si se escribe distinto, no clasifica:

| Tag | Dónde va | Para qué |
|---|---|---|
| `secuencia <nombre del workflow>` | Primera acción del workflow, antes del 1er mensaje | Marca a qué secuencia pertenece el contacto |
| `rama a`, `rama b`, … (o `path a`, `path b`, …) | Dentro de **cada** rama del split | Separa las ramas del A/B test |

El tag lo deriva `tagFromName()` del nombre del workflow (sin acentos ni emojis, cortado en
palabras enteras) y se desambigua con un sufijo si ya existe. La prioridad, cuando un contacto
trae tags de dos secuencias, es la columna `sort` — la misma que ordena la lista en pantalla.

Si el workflow le **saca** el tag al terminar, el tag de fin también tiene que estar en
`workflows.tags`: la clasificación lee los tags del contacto al procesarlo, y un contacto
que ya terminó cae en `none` y pierde sus eventos. Pasaba con el Cold Blast (`ended fcb`)
y con Partner CC (`debtmd sequence finished` en GHL 1, **`cc sequence finished` en GHL 2**). La
UI no puede adivinar el tag de fin: si el workflow lo cambia, hay que sumarlo a mano a la fila.

La secuencia de CC de GHL 2 (`cc_ghl2`) **no tiene copies en `OFFICIAL`, a propósito**: su tabla
de mensajes muestra lo que salió bajo el tag, así la rama B del A/B test aparece sola en vez de
quedar filtrada contra el guion de la A. El split de ese workflow pone **`path a` / `path b`**
(no `rama`), y el clasificador acepta las dos palabras: la letra es la rama. Hasta el 10/11 solo
leía `rama X`; ese día se re-sembró GHL 2 (`?action=seed&loc=oFkuULV6csxWj4T6RdT6`) para que los
contactos ya procesados recuperaran la rama. Fuera de cold y defdec la rama sale **solo** del tag:
un contacto sin tag va a "No branch", nunca se adivina por el texto.

Dos consecuencias que conviene decir en voz alta:

- **Los tags no son retroactivos.** Solo los contactos que entran *después* de configurarlos
  los llevan, así que una secuencia recién dada de alta arranca vacía y se llena de ahí en más.
- **Las secuencias nuevas no tienen copies oficiales cargados** (`OFFICIAL` en `index.ts` es de
  las 3 viejas). Para ellas el filtro es el tag mismo: se muestra el texto tal cual salió,
  agrupado por esqueleto, con un piso de `NEW_SEQ_MIN_SENDS` envíos para cortar el ruido.
- **Si un workflow viejo cambia de copy, hay que recargar `OFFICIAL`.** Sus mensajes nuevos
  desaparecen de la tabla de mensajes hasta entonces (el CR por secuencia no se entera: sale de
  los tags). GHL no expone las acciones de un workflow por API, así que se reconstruye desde lo
  enviado. La última vez (21/10/2026) la tabla mostraba el 17% de los envíos de Partner CC.

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

### Las dos locations

Desde el 6/11/2026 la persona también lee **GHL 2**. Tarjeta vive ahí desde el 27/10, así que
los WON de Century desde entonces no se veían: la vertical Credit Card tenía 2 deals.

- **"⚙ Pipelines" lista los pipelines de las dos locations**, cada uno con su `GHL 1` / `GHL 2`
  al lado: hay un CENTURY CLOSING en cada una (el de GHL 1 guarda los WON hasta el 26/10; el de
  GHL 2, desde el 27/10). `persona_pipeline.location` guarda de cuál es cada uno.
- **Cada paso usa la key de su location.** El barrido de WON y la expansión a llamadas leen el
  pipeline en su location; `persona_won_opp.location` y `call_transcript.location` la heredan, y
  la grabación se baja de esa location (la URL la lleva y la key de GHL 1 no abre las de GHL 2).
- **Una location sin key no traba nada:** sus pipelines salen con `error` en el scan, y sus
  grabaciones no se reclaman: quedan en `blocked` con el motivo, igual que las que frena el tope
  de Deepgram, para que el drenado del dashboard no quede esperando algo que no puede pasar.
- La migración `20261106210000_persona_two_locations.sql` suma el CENTURY CLOSING de GHL 2 a la
  vertical Credit Card. **No gasta nada**: hay que correr `persona_scan` → `persona_transcribe` →
  `persona_extract` → `persona_build` (↻ Regenerate) para que la persona lo use. Las llamadas de
  los AI setters salen de Retell (gratis); la más larga del closer de cada deal pasa por Deepgram.

### Estado actual

| Vertical | Compradores ganados | Fuente | Estado |
|---|--:|---|---|
| MCA | 70 leídos (de 72 ganados) | closer, GHL → Deepgram | ✅ generado · 71/71 llamadas transcriptas · 1.992 min · confianza media |
| Credit Card | 2 | AI setter, Retell | ✅ generado, con aviso de muestra chica · sin los WON de GHL 2 todavía |

⚠️ Credit Card tiene **2 deals**, todos de GHL 1. Es direccional, no estadístico, y el dashboard lo
dice. Los WON de Century en GHL 2 entran recién con un scan + Regenerate después del deploy.

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
> Railway (`server.js` + `Dockerfile`, en `outreach-analytics-production.up.railway.app`).
> `application/json` sí pasa intacto.

> **Un push a `main` NO publica el dashboard.** El workflow de GitHub solo despliega la edge
> function; Railway no está conectado al repo. Entre el 14/08 y el 10/11/2026 producción sirvió
> el `index.html` de agosto sin que nadie lo notara. Para publicar, desde un checkout parado
> en `main`:
>
> ```bash
> railway up . --path-as-root --ci -m "dashboard de main <sha>"
> ```
>
> El `. --path-as-root` importa: sin eso la CLI sube la carpeta **vinculada** (el checkout
> principal), no la actual — desde un worktree publica lo que haya en el checkout principal.
> Para confirmar: `curl -s https://outreach-analytics-production.up.railway.app/ | cmp - dashboard/index.html`.

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

### 4. Lo que deja la segunda location

- **La primera ingesta de GHL 2 fue pesada, una sola vez (10/11/2026):** se sembraron 3.512
  contactos de GHL 2 y se re-encolaron 16.537 filas de GHL 1 de secuencias medidas que no tenían
  `phone_key` (las procesó la versión anterior), para que la deduplicación las alcance. El cron
  lo drena en lotes; mientras tanto el dashboard sigue mostrando el snapshot anterior.
- **El A/B de `cc_ghl2` arrancó a etiquetar hace poco.** Su split pone `path a` / `path b` desde
  ~05/11; los contactos que entraron antes no tienen tag y salen como "No branch" (en la ventana
  de 30 días, ~63% al 10/11). Se corrige solo a medida que la ventana avanza. GHL 2 se re-sembró
  el 10/11 después del arreglo de `path X`, así que no hay contactos con el tag puesto y la rama
  perdida.
- **La fila `cc` (GHL 1) queda en Performance** con 0 ingresos en 7 días: es el histórico hasta el
  26/10 y se vacía sola cuando sus contactos salgan de la ventana (~28/11). Se puede sacar con
  "Stop measuring" después.
- **Si una location deja de contestar** (token rotado, key vencida), `markwon` no le pone sus LT
  en 0: solo resetea las locations que contestaron. `?action=status` muestra `failed` por
  location.
- La deduplicación usa el teléfono **hasheado**, no a la vista. No es anonimización: un teléfono
  de 10 dígitos se recupera por fuerza bruta.

---

## Crons

| Job | Schedule | Qué hace |
|---|---|---|
| `outreach-analytics-backfill` (jobid 1) | `* * * * *` | `work_tick()` → drena (`work`, lotes de 45s) y después cierra la corrida (`markwon` → `build`). |
| `outreach-weekly-refresh` (jobid 2) | `0 11 * * 0` | `refresh_weekly()` → `?action=refresh`. **La ignición.** |

Los dos son necesarios y hacen cosas distintas. `work_tick()` **nunca inicia una
extracción**: procesa lo que otro encoló. El que sale a buscar datos es el semanal.

Cuando ya no quedan pendientes, `work_tick()` lleva la corrida hasta el snapshot
en fases, cada una en su propio request (estado en `run.note`):

```
refresh-inc ─▶ marking ─▶ marked ─▶ building ─▶ built (+ finished_at)
               markwon              build
```

Una fase en vuelo (`run.phase_at` < 3 min) no se pisa; si se corta, el tick
siguiente la reintenta, hasta 4 veces (`run.phase_tries`). Se ve en `?action=status`.

> ⚠️ **Lección de octubre 2026.** El dashboard quedó congelado en el 30/08 con la
> ingesta funcionando. `markwon` + `build` corrían pegados al último lote de `work`,
> en el mismo request, y no entraban en los 150s: se cortaba siempre, y como ya no
> quedaba nada pendiente, nadie lo reintentaba. Además el build se había vuelto
> lento por dos acumulaciones que nadie podaba: los eventos de contactos fuera de
> la ventana (1,66M de 2,06M filas de `msg_events`, borrados el 21/10/2026; ahora
> `refresh` los poda junto con el contacto) y las 104k plantillas que barría el LIKE
> de las ramas de cold. Ver `migrations/20261021200100_work_tick_phases.sql`.

> ⚠️ **Lección de agosto 2026.** El job semanal no existía: la línea que lo
> agenda vivía comentada en el bloque de instrucciones de `schema_new_project.sql`
> y nunca se corrió. Entre el 21/07 y el 14/08 el drenador registró **17.412
> corridas "exitosas" sin traer un solo dato** — no hacer nada también cuenta
> como éxito, así que el monitoreo se veía todo verde mientras la ingesta estaba
> congelada hacía 4 días. Está agendado en
> `migrations/20260814200000_schedule_weekly_refresh.sql` para que no se repita.

Para verificar que la ingesta está viva, mirá el sello del dashboard: dice
`Data through <fecha> · N days old` y se pone ámbar a los 8 días y rojo a los 15.
Sale de `dataThrough`, que `build()` hornea leyendo `max(msg_events.sent_at)` —
es la edad del DATO, no la del snapshot ni la de tu sesión.

## Seguridad

Modelo de acceso (rediseñado 21/07/2026 — el token salió de la URL del dashboard):

> ⚠️ **Estado real (21/10/2026):** el handler ya no valida el token (`void token` en
> `Deno.serve`), así que **todas** las acciones —también `seed`, que trunca la cohorte— están
> abiertas para quien tenga la URL. Lo de abajo describe el diseño, no lo que corre hoy.

- **Ver el dashboard es abierto.** El link `outreach-analytics-production.up.railway.app` (sin
  `?token=`) carga métricas, persona e insights. La "privacidad" es el link mismo: quien lo tenga,
  entra. Corolario honesto: las acciones de **lectura** (`data`/`status`/`context`) son accesibles
  por cualquiera que conozca la URL (Railway **o** la de la edge function). CORS = `*`. No hay login.
- **Las acciones de operador** (`refresh`/`seed`/`generate`/`insight_ai`/`work`/`build`/`markwon`)
  exigen `cfg.dash_token`. El dashboard lo **pide una vez por sesión** (prompt → `sessionStorage`)
  y lo manda por `?token=` **solo** en esas llamadas — nunca vive en la URL de la página ni en el
  JS servido. Así, quien encuentre el link puede mirar pero no puede quemar la cuota de API.
- Los **crons** mandan el `dash_token` server-side (`net.http_post`), siguen funcionando igual.
- Tokens de GHL (uno por location) y key de Anthropic **read-only/secretas**, en `sms_analytics.config`.
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
