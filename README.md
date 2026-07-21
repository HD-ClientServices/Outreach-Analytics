# Outreach Analytics

Rendimiento de las secuencias SMS outbound de GoHighLevel, con la métrica que importa:

```
CR de secuencia = live transfers ÷ contactos ingresados
```

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
"¿qué workflow mandó este SMS?". Se atribuye el **contacto** comparando su **primer SMS
outbound** contra el SMS 1 de cada workflow; a partir de ahí toda su conversación
pertenece a esa secuencia.

Además la API limita a 100 req/10s: bajar ~9.500 contactos son ~40 min, y una edge function
muere a los ~150s. Por eso el pipeline es **por lotes**, empujado por cron.

### Tablas

| Tabla | Qué guarda |
|---|---|
| `config` | `ghl_api_key` (read-only), `ghl_location`, `dash_token`. **Los secretos viven acá, no en el código.** |
| `cohort` | Un registro por contacto (9.508). `entered_at` = fecha del 1er SMS = ingreso real a la secuencia. Es el **denominador**. |
| `msg_events` | Un registro por SMS enviado (220.649), con fecha, posición en la cadencia, si tuvo respuesta y si derivó en LT. |
| `templates` | Diccionario `tmpl_key → texto`, para no repetir el texto en cada evento. |
| `snapshots_v2` | Salida del `build`: las 3 ventanas precalculadas. |
| `run` | Estado del backfill. |

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

---

## Dashboard

`dashboard/index.html` — autocontenido, lee `?action=data` en vivo. Sigue el design system
de Intro (tokens tomados de tryintro.com): Inter 300 con tracking `-0.03em`, superficie
`#fdfcfc`, accent negro, highlight `#fef8d4`, verde `#16a34a`, JetBrains Mono para números.

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
