import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const BASE = "https://services.leadconnectorhq.com";
const VER = "2021-07-28";
const WINDOW_DAYS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Las 3 secuencias -------------------------------------------------------
// GHL no manda workflowId en los mensajes. Se atribuye el CONTACTO por su
// PRIMER SMS outbound comparado contra el SMS 1 de cada workflow.
const WF: { key: string; label: string; re: RegExp }[] = [
  { key: "cc", label: "Partner CC · DebtMD v2", re: /\bin cc\b|this is anna/i },
  { key: "cold", label: "V2 · BULK FUP COLD BLAST", re: /improve your weekly payments|open to a quick call about your mca/i },
  { key: "defdec", label: "PARTNER · Defaults & Declined", re: /default situation|qualify for an mca|just got your (mca )?file/i },
];
function whichWorkflow(body?: string): string {
  const b = body || "";
  for (const w of WF) if (w.re.test(b)) return w.key;
  return "none";
}

// Firmantes/openers conocidos -> {opener} para agrupar el mismo mensaje con firma distinta.
const OPENERS = /\b(maria|camila|sara|santiago|james|anna|smith|lewis|miller|martinez)\b/ig;

// Copies OFICIALES de cada secuencia. Solo se miden mensajes que pertenecen a la
// secuencia del contacto; el resto (p.ej. bare-name de otra secuencia) NO se cuenta.
const OFFICIAL: Record<string, string[]> = {
  cc: [
    "Hi {nombre}, this is {opener}. We received your submission regarding your {monto} in CC. When's a good time for a quick call?",
    "Hi {nombre}, did you see my last message? We received your submission and would love to review your options",
    "Do you have 5 minutes today, or would tomorrow work better?",
    "Hi {nombre}, just checking in. We saw you have about {monto} in CC. We'd love to see how we can help.",
    "Would tomorrow be a good time for a quick call? We can work around your schedule.",
    "Hi {nombre}, following up on your request. We saw you have about {monto} in CC and wanted to connect.",
    "Are you still interested in reviewing your options? Just reply whenever you can.",
    "{nombre}, if now isn't a good time, let me know when I should reach out.",
    "Hi {nombre}, I wanted to check if you're still looking for help with your {monto} in CC",
    "If you have 5 minutes today, we can go over everything together.",
    "{nombre}, would you rather talk this afternoon or tomorrow?",
    "Hi {nombre}, this is my last follow-up for now. If you'd still like us to review your {monto} in CC, just reply",
    "Are you still interested? If now isn't the best time, let me know what works better.",
    "Thanks, {nombre}! Whenever you're ready, just send me a message and we'll be happy to help.",
  ],
  cold: [
    "Hi {nombre}, we may be able to improve your weekly payments. Open to a quick call about your MCAs? - {opener}",
    "Hi {nombre}, my intention is simply to support you and help you feel less alone with your MCAs. - {opener}",
    "Hi {nombre}, {opener} at Settlegroup, following up. We may be able to ease your payments quickly. Can I call you?",
    "Hi {nombre}, we just helped a client improve terms on their MCAs payments. Can I give you a quick call now? - {opener}",
    "{nombre}, we truly care about the people we work with and take their MCA situation seriously. Can I call you? - {opener}",
    "Hi {nombre}, I've seen how heavy MCA payments can become without guidance. I want to help early. Just reply. - {opener}",
    "{nombre}, I just want to make sure you have someone trustworthy to talk to. Just reply. - {opener}",
    "Final note, {nombre}: if a brief call could help ease your MCA payments, just reply. I'm here to help. - {opener}",
  ],
  defdec: [
    "Hi {nombre}, just got your MCA file. We're aware of your default situation and we'd like to help you. Can I call you now? - {opener}",
    "Hi {nombre}, just got your file. We were informed you didn't qualify for an MCA. We can help you with that. Can I call you now? - {opener}",
    "Just trying to avoid colections... Can I call you now?",
    "We have a better option than an MCA... Can I call you now?",
    "Btw we just got a great result for a client like you. Quick call to share it?",
    "We help owners simplify what they pay each week. Can I call you?",
    "Hi {nombre}, {opener} at Settlegroup. We would really like to help you get ahead of this. Can I call you now?",
    "Taking another MCA may not be the answer. Can I call you? - {opener}",
    "GM {nombre}!, {opener} at Settlegroup. Another MCA may not fix this, but we may. Can I call you?",
    "Any thoughts, {nombre}?",
    "I'm honestly confused... My only goal is to share a solution with you. Can I call you now?",
    "I'll try again tomorrow. Is that ok? Have a good one!",
    "GM! Did you end up taking another MCA?",
    "... Or any liens so far?",
    "Can you give us a shot? Can I call you now?",
    "Hi {nombre}, {opener} at Settlegroup again. We just got a great result for a client like you. Can I share it on a quick call?",
  ],
};
// Esqueleto: toda variable ({nombre},{monto},{opener},{{...}}) -> 'v', se tira la puntuacion.
function skel(t: string): string {
  return (t || "").toLowerCase().replace(/\{+[^{}]*\}+/g, "v").replace(/[^a-z0-9]/g, "");
}
const OFFICIAL_KEYS: Record<string, Set<string>> = {};
const OFF_TEXT: Record<string, Record<string, string>> = {};
for (const k of Object.keys(OFFICIAL)) {
  OFFICIAL_KEYS[k] = new Set();
  OFF_TEXT[k] = {};
  for (const m of OFFICIAL[k]) {
    const sk = skel(m);
    // Esqueleto de <4 chars = mensaje de un solo placeholder ({nombre}?): cajon
    // de sastre que absorbe cualquier mensaje de una palabra. Se ignora.
    if (sk.length < 4) continue;
    OFFICIAL_KEYS[k].add(sk);
    OFF_TEXT[k][sk] = m;
  }
}

function dbClient() { return new Client(Deno.env.get("SUPABASE_DB_URL")!); }
async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = dbClient(); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function getConfig(): Promise<Record<string, string>> {
  return await withDb(async (c) => {
    const r = await c.queryObject<{ key: string; value: string }>("select key,value from sms_analytics.config");
    const m: Record<string, string> = {}; for (const row of r.rows) m[row.key] = row.value; return m;
  });
}
async function gget(url: string, key: string, tries = 5): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + key, Version: VER } });
      if (r.status === 200) return await r.json();
      if ([429, 403, 502, 503].includes(r.status)) { await sleep(1200 + i * 1200); continue; }
      return null;
    } catch (_) { await sleep(800 + i * 800); }
  }
  return null;
}
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length); let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; res[i] = await fn(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, () => worker())); return res;
}
function isStop(b?: string) { return !!b && /^\s*(stop\w*|unsubscribe|cancel|end|quit|remove\s*me|opt\s*out|no\s*more|do\s*not\s*text|leave me alone)\s*[.!]*\s*$/i.test(b.trim()); }
function tmplOf(body?: string, name?: string) {
  let t = (body || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  if (name) { const toks = [...new Set(name.split(/\s+/))].sort((a, b) => b.length - a.length);
    for (const tok of toks) if (tok.length >= 2) t = t.replace(new RegExp("\\b" + tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig"), "{nombre}"); }
  t = t.replace(/\$\s?\d[\d,\.]*\s*(k|\/day|\/month|\/mo|per day|per month|a day|a month|\/wk|\/week)?/ig, "{monto}");
  t = t.replace(/\b\d[\d,\.]*\s*(k|\/day|\/month|\/mo|\/wk|\/week)\b/ig, "{monto}");
  t = t.replace(/\b(mon|tue|wed|thu|fri|sat|sun)\w*\b/ig, "{día}");
  t = t.replace(/\b\d{1,2}:\d{2}\s*(am|pm)?|\b\d{1,2}\s*(am|pm)\b/ig, "{hora}");
  t = t.replace(OPENERS, "{opener}");
  t = t.replace(/\{opener\}(\s+\{opener\})+/g, "{opener}");
  t = t.replace(/\{nombre\}(\s+\{nombre\})+/g, "{nombre}");
  return t.replace(/\s+/g, " ").trim();
}
function hashKey(s: string): string {
  const norm = s.toLowerCase().replace(/[^a-z0-9{}]/g, "");
  let h = 5381; for (let i = 0; i < norm.length; i++) h = ((h * 33) ^ norm.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

// ---- SEED: cohorte = TODOS los contactos texteados en la ventana ------------
// Denominador por MENSAJES (no por oportunidad): enumera las conversaciones
// creadas en la ventana (startDate/endDate filtran por dateAdded ~= inicio de
// secuencia) en PARALELO por franjas de 1 dia, cada franja con su cursor
// asc + startAfterDate. VERIFICADO: el param 'id' rompe la query, NO usarlo;
// 'sort=desc' con startAfterDate devuelve lo ya visto. El 'won' (LT) se marca
// aparte con ?action=markwon. work() atribuye wf por 1er SMS.
async function seed(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const t0 = Date.now();
  const day = 86400000;
  const nDays = WINDOW_DAYS + 2; // margen sobre la ventana de 30d
  const chunks: { s: number; e: number }[] = [];
  for (let i = 0; i < nDays; i++) chunks.push({ s: t0 - (i + 1) * day, e: t0 - i * day });
  const deadline = t0 + 118000;
  let timedOut = false;

  // Cada franja se enumera secuencial (cursor), pero las franjas van en paralelo.
  const maps = await pool(chunks, 8, async (ch) => {
    const local = new Map<string, string>();
    let cursor = "", pages = 0;
    while (pages < 400) {
      if (Date.now() > deadline) { timedOut = true; break; }
      let u = BASE + "/conversations/search?locationId=" + loc + "&limit=100&startDate=" + ch.s + "&endDate=" + ch.e + "&sortBy=last_message_date&sort=asc";
      if (cursor) u += "&startAfterDate=" + cursor;
      const d = await gget(u, key);
      const convs = d?.conversations ?? [];
      if (!convs.length) break;
      for (const cv of convs) { const cid = cv.contactId; if (cid && !local.has(cid)) local.set(cid, cv.contactName || cv.fullName || ""); }
      const lastLmd = convs[convs.length - 1]?.lastMessageDate ?? 0;
      let nc = String(lastLmd); if (nc === cursor) nc = String(lastLmd + 1); // desempate
      cursor = nc; pages++;
      if (convs.length < 100) break;
    }
    return local;
  });
  const contacts = new Map<string, string>();
  for (const m of maps) for (const [cid, name] of m) if (!contacts.has(cid)) contacts.set(cid, name);
  if (timedOut) return { error: "enum timeout", collected: contacts.size };

  // GUARD anti-wipe: si GHL rate-limitea (429), la enumeracion junta 0/pocos y
  // NO hay que truncar la cohorte buena. 0 nunca es legitimo aca (~38k). Si la
  // nueva cae por debajo del 50% de la actual, se aborta SIN tocar la DB.
  const lastGood = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint }>("select count(*)::bigint as n from sms_analytics.cohort");
    return Number(r.rows[0].n);
  });
  const minOk = lastGood > 0 ? Math.floor(lastGood * 0.5) : 1;
  if (contacts.size < minOk) {
    return { error: "seed abortado: enum junto muy pocos (probable 429), cohorte preservada",
      collected: contacts.size, minOk, lastGood };
  }

  // Solo si termino la enumeracion: truncar + insertar (won se marca despues).
  const rows = [...contacts.entries()];
  await withDb(async (c) => {
    await c.queryObject("truncate sms_analytics.cohort, sms_analytics.msg_events");
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = chunk.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2},false)`).join(",");
      const args = chunk.flatMap((r) => [r[0], r[1]]);
      await c.queryArray(
        `insert into sms_analytics.cohort(contact_id,name,won) values ${vals} on conflict (contact_id) do nothing`, args);
    }
    await c.queryObject(
      `update sms_analytics.run set started_at=now(), seeded=$1, finished_at=null, note='seeded-conv' where id=1`, [rows.length]);
    await c.queryArray(
      `insert into sms_analytics.config(key,value) values ('last_refresh_ms',$1) on conflict (key) do update set value=excluded.value`, [String(t0)]);
  });
  return { seeded: rows.length, chunks: nDays, elapsedMs: Date.now() - t0 };
}

// ---- REFRESH: actualizacion on-demand. Si la cohorte no esta poblada -> full
// (seed, ~2h). Si esta poblada -> INCREMENTAL: solo trae los contactos con
// actividad NUEVA desde el ultimo refresh y los re-encola (done=false); el drain
// procesa solo ese delta (minutos). Poda los que quedaron fuera de la ventana.
async function refresh(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const t0 = Date.now();
  const cohortN = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint }>("select count(*)::bigint as n from sms_analytics.cohort");
    return Number(r.rows[0].n);
  });
  if (cohortN < 10000) { const r = await seed(cfg); return { mode: "full", cohortWas: cohortN, ...r }; }

  const lr = await withDb(async (c) => {
    const r = await c.queryObject<{ value: string }>("select value from sms_analytics.config where key='last_refresh_ms'");
    return r.rows[0]?.value ? Number(r.rows[0].value) : (t0 - 3 * 86400000);
  });
  const since = lr - 12 * 3600000; // 12h de overlap para agarrar conversaciones actualizadas
  const contacts = new Map<string, string>();
  let cursor = String(since), pages = 0; const deadline = t0 + 110000;
  while (pages < 800 && Date.now() < deadline) {
    const u = BASE + "/conversations/search?locationId=" + loc + "&limit=100&sortBy=last_message_date&sort=asc&startAfterDate=" + cursor;
    const d = await gget(u, key);
    const convs = d?.conversations ?? [];
    if (!convs.length) break;
    for (const cv of convs) { const cid = cv.contactId; if (cid) contacts.set(cid, cv.contactName || cv.fullName || ""); }
    const lastLmd = convs[convs.length - 1]?.lastMessageDate ?? 0;
    let nc = String(lastLmd); if (nc === cursor) nc = String(lastLmd + 1);
    cursor = nc; pages++;
    if (convs.length < 100) break;
  }
  const rows = [...contacts.entries()];
  await withDb(async (c) => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = chunk.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2},false)`).join(",");
      const args = chunk.flatMap((r) => [r[0], r[1]]);
      // nuevos -> insert (done=false); existentes -> reset a not-done para re-procesar.
      await c.queryArray(
        `insert into sms_analytics.cohort(contact_id,name,won) values ${vals}
         on conflict (contact_id) do update set done=false, attempts=0`, args);
    }
    await c.queryObject(
      `delete from sms_analytics.cohort where entered_at is not null and entered_at < now() - ($1 || ' days')::interval`, [String(WINDOW_DAYS + 3)]);
    await c.queryArray(
      `insert into sms_analytics.config(key,value) values ('last_refresh_ms',$1) on conflict (key) do update set value=excluded.value`, [String(t0)]);
    await c.queryObject(`update sms_analytics.run set started_at=now(), finished_at=null, note='refresh-inc' where id=1`);
  });
  return { mode: "incremental", delta: rows.length, pages, elapsedMs: Date.now() - t0 };
}

// ---- MARKWON: marca cohort.won desde oportunidades ganadas (numerador LT) ----
// LT = oportunidad en la etapa "Lead Ganado (+60s)" de alguna pipeline *OPENING*
// (transferencia en vivo). Se consulta por pipeline_id + pipeline_stage_id en
// PARALELO (trae solo los LT -> pocos, rapido, completo). El code-check por stage
// mantiene la correccion aunque GHL ignore el filtro. Partners Wins = status=won.
// Desacoplado del seed; build() cruza (trigger AND won), asi el orden no afecta.
async function markwon(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const t0 = Date.now();
  const pdata = await gget(BASE + "/opportunities/pipelines?locationId=" + loc, key);
  const pls = pdata?.pipelines ?? []; if (!pls.length) throw new Error("pipelines unavailable");
  const tasks: { pid: string; stage?: string; partner?: boolean }[] = [];
  for (const p of pls) {
    const nm = (p.name || "").toUpperCase();
    if (nm.includes("OPENING")) {
      for (const s of (p.stages || [])) if ((s.name || "").toLowerCase().includes("ganad")) tasks.push({ pid: p.id, stage: s.id });
    } else if (nm.includes("PARTNER") && nm.includes("WIN")) {
      tasks.push({ pid: p.id, partner: true });
    }
  }
  const cutoff = t0 - (WINDOW_DAYS + 7) * 86400000;
  const deadline = t0 + 115000;
  const won = new Set<string>();
  await pool(tasks, 8, async (tk) => {
    let url: string | undefined = BASE + "/opportunities/search?location_id=" + loc + "&pipeline_id=" + tk.pid +
      (tk.stage ? "&pipeline_stage_id=" + tk.stage : "") + "&status=all&limit=100&order=added_desc";
    let pg = 0;
    while (url && pg < 300 && Date.now() < deadline) {
      const d = await gget(url, key); if (!d) break;
      const ops = d.opportunities ?? []; if (!ops.length) break;
      for (const o of ops) {
        const w = tk.stage ? (o.pipelineStageId === tk.stage) : (o.status === "won");
        if (w && o.contactId) won.add(o.contactId);
      }
      url = d.meta?.nextPageUrl; pg++;
      if (ops.length && ops.every((o: any) => (Date.parse(o.createdAt || "") || t0) < cutoff)) break;
    }
  });
  const marked = await withDb(async (c) => {
    await c.queryObject("update sms_analytics.cohort set won=false where won");
    let n = 0; const arr = [...won];
    for (let i = 0; i < arr.length; i += 500) {
      const chunk = arr.slice(i, i + 500);
      const ph = chunk.map((_, j) => `$${j + 1}`).join(",");
      const r = await c.queryObject<{ n: bigint }>(
        `with u as (update sms_analytics.cohort set won=true where contact_id in (${ph}) returning 1)
         select count(*)::bigint as n from u`, chunk);
      n += Number(r.rows[0].n);
    }
    return n;
  });
  return { wonFound: won.size, marked, tasks: tasks.length, elapsedMs: Date.now() - t0 };
}

// ---- WORK: procesa una tanda, acotado por TIEMPO ----------------------------
async function work(cfg: Record<string, string>, budgetMs: number) {
  const t0 = Date.now();
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  let processed = 0;

  while (Date.now() - t0 < budgetMs) {
    const batch = await withDb(async (c) => {
      const r = await c.queryObject<{ contact_id: string; name: string; won: boolean }>(
        `update sms_analytics.cohort set attempts = attempts + 1
         where contact_id in (
           select contact_id from sms_analytics.cohort
           where not done and attempts < 3
           order by attempts, contact_id
           limit 120
           for update skip locked
         )
         returning contact_id, name, won`);
      return r.rows;
    });
    if (!batch.length) break;

    const results = await pool(batch, 14, async (t) => {
      const cd = await gget(BASE + "/conversations/search?locationId=" + loc + "&contactId=" + t.contact_id, key);
      const convs = cd?.conversations ?? [];
      const msgs: any[] = [];
      for (const cv of convs.slice(0, 4)) {
        let last = "";
        for (let p = 0; p < 5; p++) {
          const mu = BASE + "/conversations/" + cv.id + "/messages?limit=100" + (last ? "&lastMessageId=" + last : "");
          const md = await gget(mu, key); const block = md?.messages; const arr = block?.messages ?? [];
          if (!arr.length) break; msgs.push(...arr);
          if (!block?.nextPage) break; last = block?.lastMessageId || ""; if (!last) break;
        }
      }
      const sms = msgs
        .filter((m: any) => m.messageType === "TYPE_SMS" || m.type === 2)
        .sort((a: any, b: any) => (a.dateAdded || "") < (b.dateAdded || "") ? -1 : 1);

      const firstOut = sms.find((m: any) => m.direction === "outbound");
      const wf = whichWorkflow(firstOut?.body);
      const enteredAt = firstOut?.dateAdded || null;

      let fi = -1;
      for (let i = 0; i < sms.length; i++) if (sms[i].direction === "inbound" && !isStop(sms[i].body)) { fi = i; break; }
      let trgIdx = -1;
      if (fi > 0) { for (let j = fi - 1; j >= 0; j--) if (sms[j].direction === "outbound") { trgIdx = j; break; } }

      const events: any[] = [];
      let pos = 0;
      for (let i = 0; i < sms.length; i++) {
        const m = sms[i]; if (m.direction !== "outbound") continue;
        pos++;
        let reply = false, dnd = false;
        if (i + 1 < sms.length && sms[i + 1].direction === "inbound") {
          if (isStop(sms[i + 1].body)) dnd = true; else reply = true;
        }
        const tm = tmplOf(m.body, t.name);
        events.push({ tmpl: tm, key: hashKey(tm), pos, sent: m.dateAdded || null, reply, dnd, isTrigger: i === trgIdx });
      }
      const trg = events.find((e) => e.isTrigger);
      return { t, wf, enteredAt, replied: fi >= 0, events,
        triggerKey: trg?.key ?? null, triggerPos: trg?.pos ?? null };
    });

    await withDb(async (c) => {
      for (const r of results) {
        if (!r) continue;
        const uniq = new Map<string, string>();
        for (const e of r.events) uniq.set(e.key, e.tmpl);
        if (uniq.size) {
          const arr = [...uniq.entries()];
          const vals = arr.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2})`).join(",");
          await c.queryArray(
            `insert into sms_analytics.templates(tmpl_key,tmpl) values ${vals} on conflict (tmpl_key) do nothing`,
            arr.flat());
        }
        await c.queryArray(`delete from sms_analytics.msg_events where contact_id=$1`, [r.t.contact_id]);
        // Solo guardamos msg_events de las 3 secuencias; los 'none' (mayoria) no
        // aportan al dashboard. led_to_lt = isTrigger (el 'won' se cruza en build).
        if (r.events.length && r.wf !== "none") {
          for (let i = 0; i < r.events.length; i += 200) {
            const chunk = r.events.slice(i, i + 200);
            const vals = chunk.map((_, j) => {
              const b = j * 8;
              return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::timestamptz,$${b + 6},$${b + 7},$${b + 8})`;
            }).join(",");
            const args = chunk.flatMap((e: any) => [r.t.contact_id, r.wf, e.key, e.pos, e.sent, e.reply,
              !!e.isTrigger, e.dnd]);
            await c.queryArray(
              `insert into sms_analytics.msg_events(contact_id,wf,tmpl_key,pos,sent_at,got_reply,led_to_lt,led_to_dnd)
               values ${vals}`, args);
          }
        }
        await c.queryArray(
          `update sms_analytics.cohort
           set wf=$2, entered_at=$3::timestamptz, replied=$4, trigger_key=$5, trigger_pos=$6,
               done=true, fetched_at=now()
           where contact_id=$1`,
          [r.t.contact_id, r.wf, r.enteredAt, r.replied, r.triggerKey, r.triggerPos]);
        processed++;
      }
    });
  }

  const remaining = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint }>(
      `select count(*)::bigint as n from sms_analytics.cohort where not done and attempts < 3`);
    return Number(r.rows[0].n);
  });
  return { processed, remaining, elapsedMs: Date.now() - t0 };
}

// ---- BUILD: arma el snapshot con las 3 ventanas -----------------------------
// ---- INSIGHTS: mejores/peores mensajes (deterministico; alimenta UI + generador) ----
// Un mensaje BUENO = alta resp + alto LT + bajo opt-out. MALO = lo inverso (o alto opt-out).
// LT es la metrica-plata (peso x2); el opt-out se penaliza (x2). Devuelve replicate/remove.
function insOneLine(s: string): string {
  return String(s || "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim().slice(0, 140);
}
function computeInsights(win: any): any {
  const seqLabel: Record<string, string> = {};
  for (const s of (win.sequences || [])) seqLabel[s.key] = s.label;
  const pool: any[] = [];
  for (const wf of Object.keys(win.msgs || {})) {
    for (const m of (win.msgs[wf] || [])) pool.push({ ...m, wf, seq: seqLabel[wf] || wf });
  }
  if (!pool.length) return { replicate: [], remove: [], pool: 0, minSends: 0 };

  // Umbral de confianza: preferimos >=10 envios; si hay pocos, relajamos a >=5.
  const minSends = pool.filter((m) => m.sends >= 10).length >= 3 ? 10 : 5;
  const cand = pool.filter((m) => m.sends >= minSends);
  if (!cand.length) return { replicate: [], remove: [], pool: pool.length, minSends };

  const score = (m: any) => m.ltRate * 2 + m.replyRate - m.dndRate * 2;
  const maxLt = Math.max(...cand.map((m) => m.ltRate));
  const maxReply = Math.max(...cand.map((m) => m.replyRate));
  const dndSorted = cand.map((m) => m.dndRate).sort((a, b) => a - b);
  const medDnd = dndSorted[Math.floor(dndSorted.length / 2)] || 0;

  const pack = (m: any, reason: string) => ({
    seq: m.seq, pos: m.pos, text: insOneLine(m.tmpl), sends: m.sends,
    replyRate: m.replyRate, ltRate: m.ltRate, dndRate: m.dndRate, reason,
  });
  const replicReason = (m: any) => {
    const b: string[] = [];
    if (m.ltRate > 0 && m.ltRate === maxLt) b.push("best live-transfer rate (" + m.ltRate + "%)");
    else if (m.ltRate > 0) b.push("converts to LT (" + m.ltRate + "%)");
    if (m.replyRate === maxReply) b.push("top response rate (" + m.replyRate + "%)");
    else if (m.replyRate >= 8) b.push("strong replies (" + m.replyRate + "%)");
    b.push("low opt-out (" + m.dndRate + "%)");
    return b.join(" · ");
  };
  const removeReason = (m: any) =>
    m.dndRate >= 5
      ? "high opt-out (" + m.dndRate + "%) — burning the list"
      : "near-zero conversion (LT " + m.ltRate + "%, replies " + m.replyRate + "%) over " + m.sends + " sends";

  const replicate = cand.slice()
    .sort((a, b) => score(b) - score(a))
    .filter((m) => (m.ltRate > 0 || m.replyRate >= 8) && m.dndRate <= Math.max(medDnd, 3))
    .slice(0, 3).map((m) => pack(m, replicReason(m)));

  const chosen = new Set(replicate.map((r) => r.seq + "#" + r.pos));
  const remove = cand.slice()
    .sort((a, b) => (b.dndRate - a.dndRate) || (score(a) - score(b)))
    .filter((m) => (m.dndRate >= 5 || (m.ltRate === 0 && m.replyRate < 5)) && !chosen.has(m.seq + "#" + m.pos))
    .slice(0, 3).map((m) => pack(m, removeReason(m)));

  return { replicate, remove, pool: pool.length, minSends };
}

async function build() {
  return await withDb(async (c) => {
    const out: any = { generatedAt: new Date().toISOString(), windows: {} };
    for (const win of [7, 14, 30]) {
      const seqs = await c.queryObject<{ wf: string; ing: bigint; lt: bigint }>(
        `select wf, count(*)::bigint as ing, count(*) filter (where won)::bigint as lt
         from sms_analytics.cohort
         where done and entered_at >= now() - ($1 || ' days')::interval
         group by wf`, [String(win)]);
      const byWf: Record<string, { ing: number; lt: number }> = {};
      for (const r of seqs.rows) byWf[r.wf] = { ing: Number(r.ing), lt: Number(r.lt) };

      const msgs = await c.queryObject<{ wf: string; tmpl: string; pos: number; sends: bigint; replies: bigint; lts: bigint; dnds: bigint }>(
        `select e.wf, t.tmpl, min(e.pos)::int as pos,
                count(*)::bigint as sends,
                count(*) filter (where e.got_reply)::bigint as replies,
                count(*) filter (where e.led_to_lt and c.won)::bigint as lts,
                count(*) filter (where e.led_to_dnd)::bigint as dnds
         from sms_analytics.msg_events e
         join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
         join sms_analytics.cohort c on c.contact_id = e.contact_id
         where c.entered_at >= now() - ($1 || ' days')::interval
         group by e.wf, t.tmpl`, [String(win)]);

      const agg: Record<string, Record<string, any>> = {};
      for (const r of msgs.rows) {
        const sk = skel(r.tmpl);
        const text = OFF_TEXT[r.wf] && OFF_TEXT[r.wf][sk];
        if (!text) continue;
        const g = (agg[r.wf] || (agg[r.wf] = {}));
        const e = g[sk] || (g[sk] = { tmpl: text, pos: r.pos, sends: 0, replies: 0, lts: 0, dnds: 0 });
        e.sends += Number(r.sends); e.replies += Number(r.replies); e.lts += Number(r.lts); e.dnds += Number(r.dnds);
        if (r.pos < e.pos) e.pos = r.pos;
      }
      const msgsByWf: Record<string, any[]> = {};
      for (const wf of Object.keys(agg)) {
        msgsByWf[wf] = Object.values(agg[wf]).filter((e: any) => e.sends >= 5).map((e: any) => ({
          tmpl: e.tmpl, pos: e.pos, sends: e.sends, replies: e.replies, lts: e.lts, dnds: e.dnds,
          replyRate: e.sends ? Math.round(1000 * e.replies / e.sends) / 10 : 0,
          ltRate: e.sends ? Math.round(10000 * e.lts / e.sends) / 100 : 0,
          dndRate: e.sends ? Math.round(1000 * e.dnds / e.sends) / 10 : 0,
        })).sort((a: any, b: any) => b.sends - a.sends);
      }
      out.windows[win] = {
        sequences: WF.map((w) => {
          const s = byWf[w.key] || { ing: 0, lt: 0 };
          return { key: w.key, label: w.label, ing: s.ing, lt: s.lt,
            cr: s.ing ? Math.round(10000 * s.lt / s.ing) / 100 : null };
        }),
        unidentified: byWf["none"] || { ing: 0, lt: 0 },
        msgs: msgsByWf,
      };
      out.windows[win].insights = computeInsights(out.windows[win]);
    }
    await c.queryArray(`insert into sms_analytics.snapshots_v2(data) values ($1::jsonb)`, [JSON.stringify(out)]);
    await c.queryObject(`update sms_analytics.run set finished_at=now(), note='built' where id=1`);
    return out;
  });
}

async function status() {
  return await withDb(async (c) => {
    const r = await c.queryObject<any>(
      `select (select count(*) from sms_analytics.cohort)::int as total,
              (select count(*) from sms_analytics.cohort where done)::int as done,
              (select count(*) from sms_analytics.cohort where not done and attempts >= 3)::int as failed,
              (select count(*) from sms_analytics.msg_events)::int as events,
              (select count(*) from sms_analytics.cohort where won)::int as won,
              (select seeded from sms_analytics.run where id=1) as seeded,
              (select note from sms_analytics.run where id=1) as note,
              (select started_at from sms_analytics.run where id=1) as started_at,
              (select finished_at from sms_analytics.run where id=1) as finished_at`);
    return r.rows[0];
  });
}

// ---- CONTEXT: salida markdown estandarizada, consumible por IA (Fase 3) ------
// Cada item (secuencia, set de mensajes, bloque de persona) sale con datos +
// un copy_signal accionable. Rendimiento se genera del snapshot en vivo; la
// persona se lee de context_docs. Se sirve como text/plain markdown.
function perfMd(snap: any, win: string): string {
  const w = snap && snap.windows && snap.windows[win];
  if (!w) return "# SMS PERFORMANCE\n(no data for window " + win + ")\n";
  let md = "# SMS PERFORMANCE — 3 sequences (window: " + win + "d)\n";
  md += "meta:\n  source: GoHighLevel SMS analytics (read-only)\n";
  md += "  snapshot_at: " + (snap.snapshotAt || snap.generatedAt || "") + "\n";
  md += "  window_days: " + win + "\n";
  md += "  metric_defs: { conversion_to_LT: live_transfers/contacts_entered (2 decimals), resp_rate: responses/sent, lt_rate: msg_led_to_LT/sent, optout_rate: opt_outs/sent (opt-out = lead requested STOP, GHL auto-DND) }\n\n";
  md += "## perf.sequences [item: sequence-summary]\n";
  md += "| key | sequence | contacts_entered | live_transfers | conversion_to_LT |\n|---|---|--:|--:|--:|\n";
  const seqs = (w.sequences || []).slice().sort((a: any, b: any) => (b.cr == null ? -1 : b.cr) - (a.cr == null ? -1 : a.cr));
  for (const s of seqs) md += "| " + s.key + " | " + s.label + " | " + (s.ing == null ? "-" : s.ing) + " | " + (s.lt == null ? "-" : s.lt) + " | " + (s.cr == null ? "-" : s.cr + "%") + " |\n";
  const u = w.unidentified || { ing: 0, lt: 0 };
  md += "\nnote: outside these 3 sequences = " + u.ing + " contacts / " + u.lt + " LT (other workflows or manual sends).\n\n";
  const ins = w.insights;
  if (ins && ((ins.replicate || []).length || (ins.remove || []).length)) {
    md += "## perf.insights [item: what-to-replicate-and-kill] (min " + ins.minSends + " sends)\n";
    md += "replicate — model new copy on these winning structures:\n";
    for (const r of (ins.replicate || [])) md += "  - [" + r.seq + " sms#" + r.pos + "] \"" + r.text + "\" -> " + r.reason + "\n";
    md += "remove — retire these, do NOT reuse:\n";
    for (const r of (ins.remove || [])) md += "  - [" + r.seq + " sms#" + r.pos + "] \"" + r.text + "\" -> " + r.reason + "\n";
    md += "copy_signal: replicate the hook/structure of the 'replicate' set; never reuse the 'remove' set.\n\n";
  }
  for (const s of (w.sequences || [])) {
    const rows = ((w.msgs || {})[s.key] || []).slice().sort((a: any, b: any) => a.pos - b.pos);
    md += "## perf.messages." + s.key + " [item: message-set] — " + s.label + "\n";
    if (!rows.length) { md += "(no messages with 5+ sends in this window)\n\n"; continue; }
    md += "| sms# | message | sent | responses | resp% | LT | LT% | opt_out | opt_out% |\n|--:|---|--:|--:|--:|--:|--:|--:|--:|\n";
    for (const m of rows) {
      const txt = String(m.tmpl || "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");
      md += "| " + m.pos + " | " + txt + " | " + m.sends + " | " + m.replies + " | " + m.replyRate + "% | " + m.lts + " | " + m.ltRate + "% | " + m.dnds + " | " + m.dndRate + "% |\n";
    }
    const bR = rows.slice().sort((a: any, b: any) => b.replyRate - a.replyRate)[0];
    const bL = rows.slice().sort((a: any, b: any) => b.ltRate - a.ltRate)[0];
    const bD = rows.slice().sort((a: any, b: any) => b.dndRate - a.dndRate)[0];
    md += "\nbest_response: sms#" + bR.pos + " (" + bR.replyRate + "%)\n";
    md += "best_LT: sms#" + bL.pos + " (" + bL.ltRate + "%)\n";
    md += "highest_optout_avoid: sms#" + bD.pos + " (" + bD.dndRate + "%)\n";
    md += "copy_signal: model new copy on the best-response and best-LT message structures; rewrite/soften the highest-opt-out message.\n\n";
  }
  return md;
}
async function context(win: string): Promise<string> {
  return await withDb(async (c) => {
    const q = await c.queryObject<{ data: any; created_at: string }>(
      "select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1");
    const snap = q.rows[0] ? { ...q.rows[0].data, snapshotAt: q.rows[0].created_at } : null;
    const p = await c.queryObject<{ md: string }>("select md from sms_analytics.context_docs where key='persona'");
    const personaMd = (p.rows[0] && p.rows[0].md) || "(persona doc missing)";
    const head = "# OUTREACH ANALYTICS — AI CONTEXT PACK\n"
      + "_Standardized markdown for a downstream sequence-generation AI._\n"
      + "_Panel 1 = SMS PERFORMANCE (what empirically converts). Panel 2 = BUYER PERSONA (who closes & why)._\n"
      + "_Each item carries `data:` + a `copy_signal:` (actionable direction). Generated live._\n\n---\n\n";
    return head + perfMd(snap, win) + "\n---\n\n" + personaMd + "\n";
  });
}

// ---- COMPLIANCE: reglas SMS hardcodeadas (de investigación A2P/carriers) ------
// Dos capas de defensa: (1) sesgar el vocabulario del modelo desde el prompt, y
// (2) validar + limpiar CADA mensaje generado despues, para que las reglas se
// cumplan en codigo y no sean solo una sugerencia al modelo.
const SMS_MAX_CHARS = 150; // solo el cuerpo; el cliente agrega el opt-out aparte, downstream

// Lista negra dura — nunca permitido, en ninguna forma (case-insensitive, word-boundary).
const BLOCKLIST: string[] = [
  "debt", "debts", "loan", "loans", "lending",
  "consolidate", "consolidation", "debt consolidation",
  "settle", "settlement", "debt settlement",
  "forgiveness", "debt forgiveness", "debt relief", "debt reduction",
  "credit repair", "bad credit", "no credit check",
  "pre-approved", "preapproved", "pre approved",
  "guaranteed", "guarantee", "free", "risk-free", "risk free", "100% free",
  "free money", "extra cash", "cash bonus", "fast cash",
  "eliminate", "wipe out", "get rid of", "erase your debt",
  "irs", "lawsuit", "legal action", "sue", "garnish", "garnishment", "seize", "arrest",
  "act now", "urgent", "final notice", "last chance", "apply now",
];

// Sustituciones seguras para el vertical MCA / restructuring (sesga al modelo).
const SUBSTITUTIONS: [string, string][] = [
  ["debt", "balances / positions"],
  ["loan", "advance / funding"],
  ["consolidate", "restructure your positions"],
  ["settle", "resolve / restructure"],
  ["forgiveness", "lower monthly payments"],
  ["get rid of", "restructure"],
  ["eliminate", "improve cash flow"],
  ["guaranteed", "you may qualify"],
  ["free", "complimentary / no-cost"],
  ["pre-approved", "you may pre-qualify"],
];

const SHORTENERS = ["bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "is.gd", "buff.ly", "rebrand.ly"];
// Caracteres que fuerzan UCS-2 (segmentos de 70) y son señal de spam.
const UCS2_CHARS = /[‐-―‘’“”…•]|[\u{1F000}-\u{1FAFF}]|[☀-➿]|[←-⇿]/u;
const CAPS_OK = ["SMS", "MCA", "LLC", "USA", "SBA", "UCC", "APR", "US"];

const COMPLIANCE_BANNED = BLOCKLIST.join(", ");
const COMPLIANCE_SUBS = SUBSTITUTIONS.map(([a, b]) => a + " -> " + b).join("; ");

function reEscape(s: string): string { return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"); }

// Quita cualquier lenguaje de opt-out / STOP / HELP / rates que el modelo agregue.
function stripOptOut(s: string): string {
  return String(s || "")
    .replace(/\b(reply|text|send)\s+stop\b[^.;!?\n]*/gi, "")
    .replace(/\bstop\s*(2|to)\s+\w+[^.;!?\n]*/gi, "")
    .replace(/\b(opt[\s-]?out|unsubscribe|reply\s+help)\b[^.;!?\n]*/gi, "")
    .replace(/\bmsg\s*&?\s*data\s*rates?(\s*may)?\s*apply\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;!?])/g, "$1")
    .replace(/([.,;!?])[.,;!?]+/g, "$1")
    .trim();
}

// Compuerta de compliance para un SMS. Devuelve texto limpio + violaciones.
function checkCompliance(raw: string): { text: string; ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const text = stripOptOut(raw);
  const lower = text.toLowerCase();

  for (const term of BLOCKLIST) {
    const re = new RegExp("\\b" + reEscape(term).replace(/ +/g, "\\s+") + "\\b", "i");
    if (re.test(lower)) violations.push('banned: "' + term + '"');
  }
  if (text.length > SMS_MAX_CHARS) violations.push("too long: " + text.length + "/" + SMS_MAX_CHARS);
  if (UCS2_CHARS.test(text)) violations.push("non-GSM char (emoji/smart-quote/em-dash) -> UCS-2");
  for (const d of SHORTENERS) if (lower.includes(d)) violations.push("link shortener: " + d);
  const caps = (text.match(/\b[A-Z]{2,}\b/g) || []).filter((w) => !CAPS_OK.includes(w));
  if (caps.length) violations.push("ALL-CAPS: " + caps.join(", "));
  if ((text.match(/[!?]/g) || []).length > 1) violations.push("excessive ! or ?");
  if (/\b(100%|will save|always save)\b/i.test(text)) violations.push("absolute promise");

  return { text, ok: violations.length === 0, violations };
}

// ---- FASE 3: generador de secuencias SMS con IA (rendimiento + persona + voz de marca) ----
async function generate(cfg: Record<string, string>, body: any) {
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Falta 'anthropic_api_key' en la tabla sms_analytics.config. Agregala en el Table Editor de Supabase y reintenta." };
  const model = cfg.gen_model || "claude-sonnet-5";
  const brief = (body && body.brief) || {};
  const win = String(brief.win || "30");
  const nMsgs = Math.min(Math.max(parseInt(brief.messages) || 6, 3), 12);
  const nVars = Math.min(Math.max(parseInt(brief.variants) || 2, 1), 3);
  const goal = String(brief.goal || "cold outreach to stacked owners who are current but drowning").slice(0, 400);
  const audience = String(brief.audience || "use the persona as-is").slice(0, 400);
  const lang = String(brief.lang || "English").slice(0, 40);

  const inputs = await withDb(async (c) => {
    const q = await c.queryObject<{ data: any; created_at: string }>(
      "select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1");
    const snap = q.rows[0] ? { ...q.rows[0].data, snapshotAt: q.rows[0].created_at } : null;
    const p = await c.queryObject<{ md: string }>("select md from sms_analytics.context_docs where key='persona'");
    const b = await c.queryObject<{ md: string }>("select md from sms_analytics.context_docs where key='brandvoice'");
    return { perf: perfMd(snap, win), persona: (p.rows[0] && p.rows[0].md) || "(none)", brand: (b.rows[0] && b.rows[0].md) || "(none)" };
  });

  const sys = [
    "You are an elite outbound SMS copywriter for a U.S. MCA (merchant cash advance) debt-restructuring firm.",
    "Your job: write SMS sequences that make stacked small-business owners REPLY and accept a live transfer to a closer.",
    "You are given three inputs: PERFORMANCE DATA (which message structures empirically convert — reply/live-transfer/opt-out rates per message, plus best-response, best-LT and highest-opt-out signals), BUYER PERSONA (who closes and why, in their own words), and BRAND VOICE (tone, promise, allowed claims, compliance guardrails).",
    "Principles:",
    "- Ground every choice in the DATA + PERSONA. Lead with the winning angle: stacking + one affordable payment (up to 50-70% lower) + legal shield. They WANT to pay — never imply debt erasure or evasion.",
    "- Model structure on the best-response and best-LT messages; avoid the structure of the highest-opt-out message.",
    "- Mirror the persona's exact language and metrics (weekly/daily $, % reduction; name lenders like OnDeck/Forward). Pre-empt the #1 objection (distrust) early: attorney-led, no upfront, we know your lenders.",
    "- HARD LIMIT: every SMS MUST be 150 characters or fewer, counting spaces and merge tokens. Shorter is better. Use the existing merge tokens where natural: {nombre} (first name), {opener} (rep name), {monto} (amount).",
    "- NEVER include opt-out, STOP, HELP, unsubscribe, or 'msg & data rates' language anywhere — not even on the first message. The client appends the legally-required opt-out separately, downstream. Any STOP/opt-out text is stripped automatically and counts as a failure.",
    "- Identify the sender by rep name ({opener}) and stay truthful; always use 'up to' with any percentage. Do NOT add any compliance/opt-out footer.",
    "- BANNED WORDS (hardcoded; auto-flagged in code after you write — never use, in any form or casing): " + COMPLIANCE_BANNED + ".",
    "- Prefer these safer substitutions instead: " + COMPLIANCE_SUBS + ".",
    "- Plain ASCII only: no emojis, no smart quotes or em-dashes, no ALL-CAPS words, at most one '!' or '?' in total, no link shorteners.",
    "- Produce testable VARIANTS with distinct hooks/angles so performance can compare them — not one final copy.",
    "Respond with ONLY valid JSON (no markdown fences, no prose) matching the schema in the user message.",
  ].join("\n");

  const schema = '{"variants":[{"name":"short label","angle":"the core hook in one line","messages":[{"n":1,"day":0,"text":"SMS text with merge tokens","why":"one-line rationale citing a data or persona signal"}]}],"notes":"what to A/B test between the variants"}';

  const user = "PERFORMANCE DATA:\n" + inputs.perf + "\n\n===\n\nBUYER PERSONA:\n" + inputs.persona + "\n\n===\n\nBRAND VOICE:\n" + inputs.brand +
    "\n\n===\n\nBRIEF:\n- Goal: " + goal + "\n- Audience: " + audience + "\n- Messages per sequence: " + nMsgs + "\n- Variants: " + nVars + "\n- Language: " + lang +
    "\n\nReturn ONLY JSON in this exact shape:\n" + schema;

  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000, system: sys, messages: [{ role: "user", content: user }] }),
    });
  } catch (e) { return { error: "fetch a Anthropic falló: " + String(e) }; }
  if (!r.ok) return { error: "Anthropic " + r.status + ": " + (await r.text()).slice(0, 400) };
  const j = await r.json();
  const text = (j.content || []).map((b: any) => b.text || "").join("").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(text.replace(/^```(json)?\s*/i, "").replace(/\s*```$/i, "").trim()); } catch (_) { /* keep raw */ }
  let checked = 0, flagged = 0, repaired = false;
  const rescan = () => {
    checked = 0; flagged = 0;
    if (!parsed || !Array.isArray(parsed.variants)) return;
    for (const v of parsed.variants) for (const m of (v.messages || [])) {
      if (m && typeof m.text === "string") {
        const chk = checkCompliance(m.text);
        m.text = chk.text; m.chars = chk.text.length; m.compliant = chk.ok; m.violations = chk.violations;
        checked++; if (!chk.ok) flagged++;
      }
    }
  };
  rescan();

  // Auto-reparacion: si algo no cumple, pedimos reescribir SOLO esos (1 pasada acotada) y re-validamos.
  if (parsed && flagged > 0) {
    const bad: any[] = [];
    parsed.variants.forEach((v: any, vi: number) => (v.messages || []).forEach((m: any, mi: number) => {
      if (m && m.violations && m.violations.length) bad.push({ vi, mi, text: m.text, fix: m.violations });
    }));
    const rsys = "You rewrite outbound SMS so they pass hardcoded compliance rules. Keep the SAME intent and any {merge_tokens}. Rules: <=150 chars; NO opt-out/STOP/HELP/'msg&data' text; plain ASCII only; no ALL-CAPS words; at most one ! or ? total; and NEVER use these banned words in any form: " +
      COMPLIANCE_BANNED + ". Prefer: " + COMPLIANCE_SUBS + ". Respond with ONLY a JSON array echoing vi/mi: [{\"vi\":0,\"mi\":0,\"text\":\"...\"}].";
    try {
      const rr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 2000, system: rsys, messages: [{ role: "user", content: "Rewrite each to fix its violations:\n" + JSON.stringify(bad) }] }),
      });
      if (rr.ok) {
        const rj = await rr.json();
        const rtext = (rj.content || []).map((b: any) => b.text || "").join("").trim();
        let fixes: any = null;
        try { fixes = JSON.parse(rtext.replace(/^```(json)?\s*/i, "").replace(/\s*```$/i, "").trim()); } catch (_) { /* skip */ }
        if (Array.isArray(fixes)) {
          for (const f of fixes) {
            const m = parsed.variants[f.vi] && parsed.variants[f.vi].messages && parsed.variants[f.vi].messages[f.mi];
            if (m && typeof f.text === "string") {
              const chk = checkCompliance(f.text);
              if (chk.violations.length < (m.violations || []).length) { m.text = f.text; repaired = true; } // solo si mejora
            }
          }
          if (repaired) rescan();
        }
      }
    } catch (_) { /* nos quedamos con la 1a pasada */ }
  }

  return { ok: true, model, elapsedMs: Date.now() - t0,
    brief: { goal, audience, messages: nMsgs, variants: nVars, lang, win },
    compliance: { checked, flagged, repaired, maxChars: SMS_MAX_CHARS,
      note: "Las reglas de palabras/formato se aplican aca, pero el outbound frio de MCA/debt-restructuring es una categoria que T-Mobile/Twilio/TCR prohiben formalmente: la entregabilidad depende de la reputacion del numero, el consentimiento y la rotacion, no solo del copy." },
    usage: j.usage || null, result: parsed, raw: parsed ? undefined : text };
}

// ---- INSIGHTS con IA: lectura masticada de los mejores/peores (on-demand) -----
// Toma los insights deterministas del snapshot y pide a la IA un resumen accionable.
async function insightAi(cfg: Record<string, string>, win: string) {
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Falta 'anthropic_api_key' en sms_analytics.config." };
  const model = cfg.gen_model || "claude-sonnet-5";
  const snap = await withDb(async (c) => {
    const q = await c.queryObject<{ data: any }>("select data from sms_analytics.snapshots_v2 order by id desc limit 1");
    return q.rows[0] ? q.rows[0].data : null;
  });
  const w = snap && snap.windows && snap.windows[win];
  const ins = w && w.insights;
  if (!ins || ((!ins.replicate || !ins.replicate.length) && (!ins.remove || !ins.remove.length)))
    return { error: "No hay insights todavia — corre un build con datos primero." };
  const sys = [
    "You are a sharp growth analyst for outbound SMS in MCA debt-restructuring.",
    "You get the BEST and WORST performing messages (with response, live-transfer and opt-out rates).",
    "Write a SHORT digested read (max 110 words, plain text, no preamble, no markdown headers):",
    "1) The 1-2 structural patterns that make the winners convert — phrased as reusable rules to copy.",
    "2) What to kill and exactly why (name the metric that condemns it).",
    "Be concrete and punchy. Reference the sms# and sequence. Do not just restate the raw numbers.",
  ].join("\n");
  const user = "WINDOW: " + win + "d\n\nREPLICATE (winners):\n" + JSON.stringify(ins.replicate) +
    "\n\nREMOVE (losers):\n" + JSON.stringify(ins.remove);
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 600, system: sys, messages: [{ role: "user", content: user }] }),
    });
  } catch (e) { return { error: "fetch a Anthropic fallo: " + String(e) }; }
  if (!r.ok) return { error: "Anthropic " + r.status + ": " + (await r.text()).slice(0, 300) };
  const j = await r.json();
  const narrative = (j.content || []).map((b: any) => b.text || "").join("").trim();
  return { ok: true, win, model, elapsedMs: Date.now() - t0, narrative,
    counts: { replicate: (ins.replicate || []).length, remove: (ins.remove || []).length } };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const token = url.searchParams.get("token");
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });

  let cfg: Record<string, string>;
  try { cfg = await getConfig(); } catch (e) { return json({ error: "db/config: " + String(e) }, 500); }
  if (token !== cfg.dash_token) return json({ error: "unauthorized" }, 401);

  try {
    if (action === "seed") return json(await seed(cfg));
    if (action === "refresh") return json(await refresh(cfg));
    if (action === "markwon") return json(await markwon(cfg));
    if (action === "context") {
      const md = await context(url.searchParams.get("win") || "30");
      return new Response(md, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
    }
    if (action === "generate") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await generate(cfg, body));
    }
    if (action === "insight_ai") return json(await insightAi(cfg, url.searchParams.get("win") || "30"));
    if (action === "work") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      const r = await work(cfg, budget);
      // Al drenar todo: marca won fresco y recien ahi construye (flujo semanal automatico).
      if (r.remaining === 0) { await markwon(cfg); const b = await build(); return json({ ...r, built: true, generatedAt: b.generatedAt }); }
      return json(r);
    }
    if (action === "build") return json(await build());
    if (action === "status") return json(await status());
    if (action === "data") {
      const r = await withDb(async (c) => {
        const q = await c.queryObject<{ data: any; created_at: string }>(
          `select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1`);
        return q.rows[0] ?? null;
      });
      return json(r ? { ...r.data, snapshotAt: r.created_at } : { empty: true });
    }
    return json({ error: "acciones: seed | refresh | markwon | context | generate | insight_ai | work | build | status | data" }, 400);
  } catch (e) { return json({ error: String(e) }, 500); }
});
