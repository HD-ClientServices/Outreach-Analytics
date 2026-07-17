import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const BASE = "https://services.leadconnectorhq.com";
const VER = "2021-07-28";
const WINDOW_DAYS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Las 3 secuencias -------------------------------------------------------
// GHL no manda workflowId en los mensajes. Se atribuye el CONTACTO por su
// PRIMER SMS outbound comparado contra el SMS 1 de cada workflow.
// Patrones calibrados 17/07/2026 contra los copies OFICIALES de GHL.
const WF: { key: string; label: string; re: RegExp }[] = [
  { key: "cc", label: "Partner CC · DebtMD v2",
    re: /\bin cc\b|this is anna/i },
  { key: "cold", label: "V2 · BULK FUP COLD BLAST",
    re: /improve your weekly payments|open to a quick call about your mca/i },
  { key: "defdec", label: "PARTNER · Defaults & Declined",
    re: /default situation|qualify for an mca|just got your (mca )?file/i },
];
function whichWorkflow(body?: string): string {
  const b = body || "";
  for (const w of WF) if (w.re.test(b)) return w.key;
  return "none";
}

// Firmantes/openers conocidos. Se normalizan a {opener} para agrupar el MISMO
// mensaje con distinta firma (Maria/Camila/Sara/… = un solo mensaje).
const OPENERS = /\b(maria|camila|sara|santiago|james|anna|smith|lewis|miller|martinez)\b/ig;

// Copies OFICIALES de cada secuencia (los que Vicente cargó de GHL). Solo se
// miden mensajes que pertenecen a la secuencia del contacto — el resto (p.ej.
// "{nombre}?" de otra secuencia "name?") NO se cuenta.
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
// Clave por "esqueleto": toda variable ({nombre},{monto},{opener},{{...}}) -> 'v',
// se tira el resto de puntuacion. Tolerante a firmas y a la glitch de {{día}}.
function skel(t: string): string {
  return (t || "").toLowerCase().replace(/\{+[^{}]*\}+/g, "v").replace(/[^a-z0-9]/g, "");
}
const OFFICIAL_KEYS: Record<string, Set<string>> = {};
// skel -> texto oficial canonico (para agrupar todas las variantes en 1 fila y
// mostrar el copy oficial limpio, sin firmas ni glitches de normalizacion).
const OFF_TEXT: Record<string, Record<string, string>> = {};
for (const k of Object.keys(OFFICIAL)) {
  OFFICIAL_KEYS[k] = new Set();
  OFF_TEXT[k] = {};
  for (const m of OFFICIAL[k]) {
    const sk = skel(m);
    // Un esqueleto de <4 chars = mensaje de un solo placeholder ({nombre}?): es
    // un cajon de sastre que absorbe cualquier mensaje de una palabra. Se ignora.
    if (sk.length < 4) continue;
    OFFICIAL_KEYS[k].add(sk);
    OFF_TEXT[k][sk] = m;
  }
}
function isOfficial(wf: string, tmpl: string): boolean {
  const set = OFFICIAL_KEYS[wf]; return !!set && set.has(skel(tmpl));
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
async function gpost(url: string, key: string, body: any, tries = 5): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, Version: VER, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 200 || r.status === 201) return await r.json();
      if ([429, 403, 502, 503].includes(r.status)) { await sleep(1200 + i * 1200); continue; }
      return { _status: r.status, _body: (await r.text()).slice(0, 500) };
    } catch (e) { await sleep(800 + i * 800); if (i === tries - 1) return { _error: String(e) }; }
  }
  return null;
}
// Tags que GHL aplica al inicio de cada workflow (minusculas, como los guarda GHL).
const SEQ_TAGS: { key: string; label: string; tag: string }[] = [
  { key: "cc", label: "Partner CC · DebtMD v2", tag: "secuencia partner cc" },
  { key: "cold", label: "V2 · BULK FUP COLD BLAST", tag: "secuencia bfcb" },
  { key: "defdec", label: "PARTNER · Defaults & Declined", tag: "secuencia partner mca" },
];
// Diagnostico: cuantos contactos tiene HOY cada tag de secuencia (denominador real).
async function tagcount(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const out: any[] = [];
  for (const s of SEQ_TAGS) {
    const d = await gpost(BASE + "/contacts/search", key, {
      locationId: loc, page: 1, pageLimit: 1,
      filters: [{ field: "tags", operator: "contains", value: s.tag }],
    });
    out.push({ key: s.key, label: s.label, tag: s.tag,
      total: (typeof d?.total === "number") ? d.total : null,
      err: d?._status ? { status: d._status, body: d._body } : (d?._error || undefined) });
  }
  // Lista todas las tags de la location, filtrada a las que suenan a secuencia,
  // para descubrir el nombre real de la de Defaults & Declined.
  const tl = await gget(BASE + "/locations/" + loc + "/tags", key);
  const all = (tl?.tags ?? []).map((t: any) => t?.name).filter(Boolean);
  const relevant = all.filter((n: string) =>
    /secuencia|bfcb|cold|default|declin|mca|partner|debtmd|\bcc\b/i.test(n));
  return { generatedAt: new Date().toISOString(), tags: out,
    tagListCount: all.length, relevantTags: relevant };
}
// Diagnostico: para cada secuencia toma una muestra de contactos ya atribuidos
// y lee sus tags REALES de GHL -> revela que tag usa cada workflow (incl. defdec).
async function sampletags(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key;
  const rows = await withDb(async (c) => {
    const r = await c.queryObject<{ wf: string; contact_id: string }>(
      `select wf, contact_id from (
         select wf, contact_id,
                row_number() over (partition by wf order by entered_at desc) as rn
         from sms_analytics.cohort where done and wf in ('cc','cold','defdec')
       ) s where rn <= 20`);
    return r.rows;
  });
  const byWf: Record<string, string[]> = {};
  for (const r of rows) (byWf[r.wf] || (byWf[r.wf] = [])).push(r.contact_id);
  const perWf: Record<string, any> = {};
  for (const wf of Object.keys(byWf)) {
    const freq: Record<string, number> = {};
    for (const cid of byWf[wf]) {
      const d = await gget(BASE + "/contacts/" + cid, key);
      const tags = d?.contact?.tags ?? d?.tags ?? [];
      for (const t of tags) freq[t] = (freq[t] || 0) + 1;
    }
    perWf[wf] = { sampled: byWf[wf].length,
      tags: Object.entries(freq).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 25) };
  }
  return { generatedAt: new Date().toISOString(), perWf };
}
// Diagnostico: dimensiona la extraccion por conversaciones (total + shape + paginacion).
async function convprobe(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const base = BASE + "/conversations/search?locationId=" + loc + "&limit=1";
  const c30 = Date.now() - 30 * 86400000;
  const c32 = Date.now() - 32 * 86400000;
  const dAll = await gget(base, key);
  const w30 = await gget(base + "&startDate=" + c30, key);
  const w32 = await gget(base + "&startDate=" + c32, key);
  // Verifica que startDate filtra por dateAdded (todas las de la muestra creadas tras el corte).
  const s = await gget(BASE + "/conversations/search?locationId=" + loc + "&limit=5&startDate=" + c30 + "&sortBy=last_message_date&sort=asc", key);
  const sample = (s?.conversations ?? []).slice(0, 5).map((c: any) => ({
    dateAdded: c?.dateAdded, lastMessageDate: c?.lastMessageDate, addedInWindow: (c?.dateAdded ?? 0) >= c30 }));
  return {
    generatedAt: new Date().toISOString(),
    totalAll: dAll?.total ?? null,
    total30dByStartDate: w30?.total ?? null,
    total32dByStartDate: w32?.total ?? null,
    sample,
  };
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
  // Firma del opener -> {opener} (agrupa mismo mensaje con distinto remitente).
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

// ---- SEED: arma la cohorte desde oportunidades ------------------------------
async function seed(cfg: Record<string, string>) {
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  const pdata = await gget(BASE + "/opportunities/pipelines?locationId=" + loc, key);
  const pls = pdata?.pipelines ?? []; if (!pls.length) throw new Error("pipelines unavailable (rate limit?)");
  const opening = new Set<string>(), ganado = new Set<string>(); let partners = "";
  for (const p of pls) {
    if ((p.name || "").toUpperCase().includes("OPENING")) {
      opening.add(p.id);
      for (const s of (p.stages || [])) if ((s.name || "").includes("Ganado")) ganado.add(s.id);
    }
    if ((p.name || "").toUpperCase().includes("PARTNER") && (p.name || "").toUpperCase().includes("WIN")) partners = p.id;
  }
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  let url: string | undefined = BASE + "/opportunities/search?location_id=" + loc + "&status=all&limit=100&order=added_desc";
  const rows: any[] = []; const seen = new Set<string>(); let pg = 0;
  while (url && pg < 300) {
    const d = await gget(url, key); if (!d) break;
    const ops = d.opportunities ?? []; if (!ops.length) break;
    for (const o of ops) {
      if (!(opening.has(o.pipelineId) || (partners && o.pipelineId === partners))) continue;
      const created = Date.parse(o.createdAt || ""); if (!(created >= cutoff)) continue;
      const cid = o.contactId; if (!cid || seen.has(cid)) continue; seen.add(cid);
      const won = ganado.has(o.pipelineStageId) || o.status === "won";
      rows.push({ cid, name: o.contact?.name || "", created: o.createdAt,
        won, wonAt: won ? (o.lastStatusChangeAt || o.updatedAt || null) : null });
    }
    url = d.meta?.nextPageUrl; pg++;
    if (ops.length && ops.every((o: any) => (Date.parse(o.createdAt || "") || Date.now()) < cutoff)) break;
  }
  await withDb(async (c) => {
    await c.queryObject("truncate sms_analytics.cohort, sms_analytics.msg_events");
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = chunk.map((_, j) => {
        const b = j * 5;
        return `($${b + 1},$${b + 2},$${b + 3}::timestamptz,$${b + 4},$${b + 5}::timestamptz)`;
      }).join(",");
      const args = chunk.flatMap((r) => [r.cid, r.name, r.created, r.won, r.wonAt]);
      await c.queryArray(
        `insert into sms_analytics.cohort(contact_id,name,opp_created_at,won,won_at) values ${vals}
         on conflict (contact_id) do nothing`, args);
    }
    await c.queryObject(
      `update sms_analytics.run set started_at=now(), seeded=$1, finished_at=null, note='seeded' where id=1`,
      [rows.length]);
  });
  return { seeded: rows.length, pages: pg };
}

// ---- WORK: procesa una tanda, acotado por TIEMPO ----------------------------
async function work(cfg: Record<string, string>, budgetMs: number) {
  const t0 = Date.now();
  const key = cfg.ghl_api_key, loc = cfg.ghl_location;
  let processed = 0;

  while (Date.now() - t0 < budgetMs) {
    // Reclamo atomico: sin FOR UPDATE SKIP LOCKED dos crons solapados agarran
    // los mismos contactos y duplican los msg_events.
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
      // Varios hilos por contacto: hay que juntarlos u ordenarlos mal.
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
        // El mensaje siguiente: si es inbound STOP -> DND; si inbound normal -> reply.
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
        // Reprocesar un contacto no debe duplicar sus eventos.
        await c.queryArray(`delete from sms_analytics.msg_events where contact_id=$1`, [r.t.contact_id]);
        if (r.events.length) {
          for (let i = 0; i < r.events.length; i += 200) {
            const chunk = r.events.slice(i, i + 200);
            const vals = chunk.map((_, j) => {
              const b = j * 8;
              return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::timestamptz,$${b + 6},$${b + 7},$${b + 8})`;
            }).join(",");
            const args = chunk.flatMap((e: any) => [r.t.contact_id, r.wf, e.key, e.pos, e.sent, e.reply,
              !!(e.isTrigger && r.t.won), e.dnd]);
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
                count(*) filter (where e.led_to_lt)::bigint as lts,
                count(*) filter (where e.led_to_dnd)::bigint as dnds
         from sms_analytics.msg_events e
         join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
         join sms_analytics.cohort c on c.contact_id = e.contact_id
         where c.entered_at >= now() - ($1 || ' days')::interval
         group by e.wf, t.tmpl`, [String(win)]);

      // Agrupo por mensaje OFICIAL (skel): todas las variantes (firmas, glitches
      // de normalizacion) suman en una sola fila, mostrando el copy oficial limpio.
      const agg: Record<string, Record<string, any>> = {};
      for (const r of msgs.rows) {
        const sk = skel(r.tmpl);
        const text = OFF_TEXT[r.wf] && OFF_TEXT[r.wf][sk];
        if (!text) continue; // no pertenece a la secuencia -> se descarta (change #1)
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
            cr: s.ing ? Math.round(1000 * s.lt / s.ing) / 10 : null };
        }),
        unidentified: byWf["none"] || { ing: 0, lt: 0 },
        msgs: msgsByWf,
      };
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
              (select seeded from sms_analytics.run where id=1) as seeded,
              (select started_at from sms_analytics.run where id=1) as started_at,
              (select finished_at from sms_analytics.run where id=1) as finished_at`);
    return r.rows[0];
  });
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
    if (action === "tagcount") return json(await tagcount(cfg));
    if (action === "sampletags") return json(await sampletags(cfg));
    if (action === "convprobe") return json(await convprobe(cfg));
    if (action === "work") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      const r = await work(cfg, budget);
      if (r.remaining === 0) { const b = await build(); return json({ ...r, built: true, generatedAt: b.generatedAt }); }
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
    return json({ error: "acciones: seed | work | build | status | data" }, 400);
  } catch (e) { return json({ error: String(e) }, 500); }
});
