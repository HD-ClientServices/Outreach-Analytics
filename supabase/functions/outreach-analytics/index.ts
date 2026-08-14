import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const BASE = "https://services.leadconnectorhq.com";
const VER = "2021-07-28";
const WINDOW_DAYS = 30;
// LLM HARDCODEADO a Sonnet 5 para TODA generación con IA (secuencias + AI read de insights + futura persona). Sin override por config.
const GEN_MODEL = "claude-sonnet-5";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Las secuencias medidas (dinámicas desde Supabase) ----
// Una fila de sms_analytics.workflows = una secuencia que el dashboard mide.
// `tags` son los tags que el workflow de GHL pone al entrar el contacto: son la
// señal de clasificación, así que dar de alta una secuencia nueva desde la UI
// (?action=workflow_add) alcanza para que empiece a medirse, sin tocar código.
let WF: { key: string; label: string; re: RegExp; keywords: string[]; tags: string[]; ghlId: string | null }[] = [];

// getConfig() y loadWorkflows() abrían UNA CONEXIÓN CADA UNO, en cada request,
// antes de mirar siquiera qué acción se pidió. Contra el host directo cada
// conexión cuesta ~1,9s, así que toda la app arrancaba con ~3,9s de peaje.
// Ahora comparten una sola conexión y el resultado se memoiza mientras viva el
// isolate, así que a partir del segundo request el peaje es 0.
let BOOT: { cfg: Record<string, string>; at: number } | null = null;
const BOOT_TTL_MS = 60000;

async function boot(): Promise<Record<string, string>> {
  if (BOOT && Date.now() - BOOT.at < BOOT_TTL_MS && WF.length) return BOOT.cfg;
  const out = await withDb(async (c) => {
    const cf = await c.queryObject<{ key: string; value: string }>(
      "select key,value from sms_analytics.config");
    const cfg: Record<string, string> = {};
    for (const row of cf.rows) cfg[row.key] = row.value;
    let wfRows: any[] = [];
    try {
      const w = await c.queryObject<any>(
        "select key,label,keywords,tags,ghl_id from sms_analytics.workflows order by sort, key");
      wfRows = w.rows || [];
    } catch (_) {
      // Base sin la migración de tags todavía: se lee lo que sí existe y los tags
      // salen del mapa histórico, así que la clasificación no se cae en el medio.
      try {
        const w = await c.queryObject<any>(
          "select key,label,keywords from sms_analytics.workflows order by key");
        wfRows = w.rows || [];
      } catch (_e) { /* se cae al fallback de abajo */ }
    }
    return { cfg, wfRows };
  });
  applyWorkflows(out.wfRows);
  BOOT = { cfg: out.cfg, at: Date.now() };
  return out.cfg;
}

// El label es el nombre del workflow tal cual está en GHL, así que puede traer
// paréntesis, signos de pregunta y demás: compilarlo crudo tiraba el boot entero.
function labelRe(label: string): RegExp {
  try { return new RegExp(label, "i"); }
  catch (_) { return new RegExp(reEscape(String(label || "")), "i"); }
}

function applyWorkflows(rows: any[]) {
  if (rows && rows.length) {
    WF = rows.map((r: any) => ({
      key: r.key,
      label: r.label,
      re: labelRe(r.label),
      keywords: (r.keywords || "").split(",").filter((k: string) => k.trim()),
      tags: splitTags(r.tags != null ? r.tags : (TAGS_FALLBACK[r.key] || "")),
      ghlId: r.ghl_id || null,
    }));
    return;
  }
  WF = WF_FALLBACK;
}

function splitTags(s: string): string[] {
  return String(s || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// Mapa histórico tag -> secuencia. Solo se usa mientras una fila no tenga su
// columna `tags` cargada; el mapa vivo es el de la tabla.
const TAGS_FALLBACK: Record<string, string> = {
  cold: "secuencia bfcb",
  cc: "debtmd sequence,secuencia partner cc",
  defdec: "sent from partner",
};

const WF_FALLBACK: typeof WF = [
  { key: "cold", label: "V2 · BULK FUP COLD BLAST",
    re: /improve.*payment|mca.*payment|quick call|open to.*call/i,
    keywords: ["improve", "weekly", "payment", "mca", "call"],
    tags: splitTags(TAGS_FALLBACK.cold), ghlId: "b985c65c-a0c3-4cdc-a737-7da93b77e933" },
  { key: "cc", label: "Partner CC · DebtMD v2",
    re: /\bcc\b|credit card|submission.*cc|this is (anna|maria|camila|sara)/i,
    keywords: ["cc", "credit", "submission", "anna", "debtmd"],
    tags: splitTags(TAGS_FALLBACK.cc), ghlId: "e28be9d2-ce89-4b6f-b85a-494d08912e58" },
  { key: "defdec", label: "PARTNER · Defaults & Declined",
    re: /default|declined|qualify.*mca|just got.*file|file received/i,
    keywords: ["default", "declined", "qualify", "file", "defdec"],
    tags: splitTags(TAGS_FALLBACK.defdec), ghlId: "69533301-b2f3-445e-8ebe-3f2227ba8c8e" },
];

// Un contacto puede tener tags de más de una secuencia (re-entradas, handoffs).
// Se resuelve por el orden de WF (columna `sort`), que es el mismo orden en que
// el dashboard las lista: la prioridad es visible, no un detalle escondido acá.
const BRANCH_TAG_RE = /^rama\s*[a-z]$/;

function seqFromTags(tags: string[]): string {
  for (const w of WF) for (const t of w.tags) if (tags.includes(t)) return w.key;
  return "none";
}

async function getSequenceAndBranchFromGHLTags(contactId: string, key: string): Promise<{sequence: string, branch: string}> {
  try {
    const url = BASE + "/contacts/" + contactId;
    const data = await gget(url, key);
    const tags = (data?.contact?.tags || data?.tags || []).map((t: any) => (typeof t === "string" ? t : t.name || "").toLowerCase());

    const sequence = seqFromTags(tags);

    let branch = "-";
    const branchTag = tags.find((t: string) => BRANCH_TAG_RE.test(t));
    if (branchTag) {
      branch = branchTag.split(/\s+/)[1] || "-";
    }

    return { sequence, branch };
  } catch (_) {
    return { sequence: "none", branch: "-" };
  }
}


function whichWorkflow(body?: string): string {
  const b = (body || "").toLowerCase();
  for (const w of WF) if (w.re.test(b)) return w.key;
  for (const w of WF) {
    const found = w.keywords.filter(kw => b.includes(kw)).length;
    if (found >= 2) return w.key;
  }
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
    "Would tomorrow be a good time for a quick call? We can work around your schedule.",
    "Hi {nombre}, just checking in. We saw you have about {monto} in CC. We'd love to see how we can help.",
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
    // Rama A = "Path A" (guión original)
    "Hi {nombre}, we may be able to improve your weekly payments. Open to a quick call about your MCAs? - {opener}",
    "Hi {nombre}, my intention is simply to support you and help you feel less alone with your MCAs. - {opener}",
    "Hi {nombre}, {opener} at Settlegroup, following up. We may be able to ease your payments quickly. Can I call you?",
    "Hi {nombre}, we just helped a client improve terms on their MCAs payments. Can I give you a quick call now? - {opener}",
    "{nombre}, we truly care about the people we work with and take their MCA situation seriously. Can I call you? - {opener}",
    "Hi {nombre}, I've seen how heavy MCA payments can become without guidance. I want to help early. Just reply. - {opener}",
    "{nombre}, I just want to make sure you have someone trustworthy to talk to. Just reply. - {opener}",
    "Final note, {nombre}: if a brief call could help ease your MCA payments, just reply. I'm here to help. - {opener}",
    // Rama B = "ab testing" (guión nuevo, agregado como split dentro del mismo workflow)
    "Hi {nombre}, this is {opener} with Settlegroup. We're aware you're stacked in multiple MCA positions. Can I call you now?",
    "Just trying to help you avoid stress on your positions. Can I call you now? - {opener}",
    "We have a better option than another advance. Can I call you now?",
    "Btw we just got a great result for an owner like you, stacked just like your positions. Quick call to share it?",
    "We help owners simplify what they pay each week, up to 70% lower. Can I call you?",
    "Hi {nombre}, {opener} at Settlegroup. Attorney-led, no upfront charge. Want to get ahead of this? Call me now.",
    "Any thoughts, {nombre}? We know your positions and can restructure into one lower weekly amount.",
    "Final note, {nombre}: if a brief call could ease your weekly amount, just reply. I'm here to help. - {opener}",
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

const OFF_TEXT: Record<string, Record<string, string>> = {};
for (const k of Object.keys(OFFICIAL)) {
  OFF_TEXT[k] = {};
  for (const m of OFFICIAL[k]) {
    const sk = skel(m);
    if (sk.length >= 4) OFF_TEXT[k][sk] = m;
  }
}

// Posición canónica de cada mensaje oficial de Defaults & Declined (numeración
// del workflow 1-15; el #6 "{nombre}?" está filtrado), indexada por su posición
// en OFFICIAL.defdec. Se usa para etiquetar las ramas (1A/1B/…) consistente entre
// ramas — NO el pos de envío crudo, que se desalinea entre Default y Declined.
const DEFDEC_POS_BY_IDX = [1, 1, 2, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const DEFDEC_POS: Record<string, number> = {};
(OFFICIAL.defdec || []).forEach((m, i) => {
  const sk = skel(m);
  if (sk.length >= 4 && DEFDEC_POS_BY_IDX[i] != null) DEFDEC_POS[sk] = DEFDEC_POS_BY_IDX[i];
});

// cc es una cadencia lineal: el paso de diseño ES el índice en OFFICIAL (1-based).
// Igual que defdec, usamos posición CANÓNICA y no el pos de envío crudo — ese pos
// cuenta TODOS los SMS salientes de la conversación, así que cuando un contacto
// acumula muchos (re-entradas, otros toques) los últimos mensajes de cc saltan a
// 28/29 en vez de mostrar su paso real (…13, 14).

// cold tiene un Split dentro del MISMO workflow de GHL: rama A = "Path A" (guión
// original, índices 0-7 de OFFICIAL.cold) y rama B = "ab testing" (guión nuevo,
// índices 8-15). Ambas ramas son 8 pasos en paralelo, así que comparten posición
// canónica 1-8 — la letra de rama (ver cbr en build()) es lo que las distingue.
const COLD_POS_BY_IDX = [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8];
const COLD_POS: Record<string, number> = {};
// Cada mensaje de cold pertenece EXCLUSIVAMENTE a una rama (a diferencia de
// defdec, donde las posiciones tardías son compartidas entre ramas), así que su
// propio texto basta para saber de qué rama es. Esto NO reemplaza al tag "rama X"
// de GHL —que sigue mandando— sino que cubre a los contactos que aún no lo tienen:
// los ~44k históricos quedaron con cohort.branch='-' y sin este respaldo el
// dashboard muestra 1,2,3 en vez de 1A,1B. Ver el cálculo de `br` en build().
const COLD_BRANCH_BY_IDX = ["A", "A", "A", "A", "A", "A", "A", "A", "B", "B", "B", "B", "B", "B", "B", "B"];
(OFFICIAL.cold || []).forEach((m, i) => {
  const sk = skel(m);
  if (sk.length >= 4 && COLD_POS_BY_IDX[i] != null) COLD_POS[sk] = COLD_POS_BY_IDX[i];
});

// Comparar el esqueleto ENTERO era demasiado literal y dejaba fuera al mensaje
// correcto por un carácter. El caso dominante: `tmplOf()` reemplaza el nombre del
// contacto por {nombre}, así que un contacto SIN nombre recibe "Hi , we may be
// able to…" y su esqueleto pierde la 'v' que el copy oficial sí tiene. Eran 684
// contactos de un mismo mensaje. Lo mismo con las iniciales del medio ("Hi Ana E,")
// y con "may" convertido en placeholder cuando el contacto se llama May.
//
// El núcleo empieza pasado el saludo+nombre —donde viven TODAS esas variaciones—
// y toma 40 caracteres, largo de sobra para ser único: verificado que los 16
// copies dan 16 núcleos sin colisión entre ramas, y que ninguna plantilla real de
// la base matchea dos ramas a la vez.
const COLD_CORE_FROM = 10, COLD_CORE_LEN = 40;
const COLD_CORES: { core: string; br: string }[] = [];
(OFFICIAL.cold || []).forEach((m, i) => {
  const sk = skel(m);
  const core = sk.slice(COLD_CORE_FROM, COLD_CORE_FROM + COLD_CORE_LEN);
  if (core.length >= 20 && COLD_BRANCH_BY_IDX[i] != null) COLD_CORES.push({ core, br: COLD_BRANCH_BY_IDX[i] });
});

// Rama de UN mensaje de cold. Cada copy pertenece a una sola rama, así que el
// texto basta. Devuelve "" si no es un mensaje reconocible de cold.
function coldBranchOf(text: string): string {
  const sk = skel(text);
  for (const c of COLD_CORES) if (sk.includes(c.core)) return c.br;
  return "";
}

// CANON_POS unifica las tres secuencias.
const CANON_POS: Record<string, Record<string, number>> = { defdec: DEFDEC_POS, cc: {}, cold: COLD_POS };
for (const wf of ["cc"]) {
  (OFFICIAL[wf] || []).forEach((m, i) => { const sk = skel(m); if (sk.length >= 4) CANON_POS[wf][sk] = i + 1; });
}

function dbClient() { return new Client(Deno.env.get("SUPABASE_DB_URL")!); }
async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = dbClient(); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
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
  // `caught` = se llegó al final de la cola de conversaciones. Distinguirlo de
  // salir por tope es lo que evita saltearse un tramo: ver la marca de abajo.
  let caught = false;
  while (pages < 800 && Date.now() < deadline) {
    const u = BASE + "/conversations/search?locationId=" + loc + "&limit=100&sortBy=last_message_date&sort=asc&startAfterDate=" + cursor;
    const d = await gget(u, key);
    const convs = d?.conversations ?? [];
    if (!convs.length) { caught = true; break; }
    for (const cv of convs) { const cid = cv.contactId; if (cid) contacts.set(cid, cv.contactName || cv.fullName || ""); }
    const lastLmd = convs[convs.length - 1]?.lastMessageDate ?? 0;
    let nc = String(lastLmd); if (nc === cursor) nc = String(lastLmd + 1);
    cursor = nc; pages++;
    if (convs.length < 100) { caught = true; break; }
  }
  // Marcar t0 cuando la enumeración se cortó por tope (800 páginas o 110s) deja
  // el tramo no recorrido SALTEADO PARA SIEMPRE: el próximo refresh arranca de t0
  // y nadie vuelve a mirar el hueco. Si no se llegó al final, se guarda hasta
  // donde de verdad se llegó, así el siguiente refresh retoma ahí.
  const mark = caught ? t0 : Math.max(Number(cursor) || since, since);
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
      `insert into sms_analytics.config(key,value) values ('last_refresh_ms',$1) on conflict (key) do update set value=excluded.value`, [String(mark)]);
    await c.queryObject(`update sms_analytics.run set started_at=now(), finished_at=null, note='refresh-inc' where id=1`);
  });
  return { mode: "incremental", delta: rows.length, pages, caughtUp: caught,
    truncated: !caught, markedAt: mark, elapsedMs: Date.now() - t0 };
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
      const { sequence: wf, branch } = await getSequenceAndBranchFromGHLTags(t.contact_id, key);
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
      return { t, wf, branch, enteredAt, replied: fi >= 0, events,
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
           set wf=$2, branch=$7, entered_at=$3::timestamptz, replied=$4, trigger_key=$5, trigger_pos=$6,
               done=true, fetched_at=now()
           where contact_id=$1`,
          [r.t.contact_id, r.wf, r.enteredAt, r.replied, r.triggerKey, r.triggerPos, r.branch]);
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
    seq: m.seq, pos: m.pos, branch: m.branch, text: insOneLine(m.tmpl), sends: m.sends,
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

  const chosen = new Set(replicate.map((r) => r.seq + "#" + r.pos + (r.branch || "")));
  const remove = cand.slice()
    .sort((a, b) => (b.dndRate - a.dndRate) || (score(a) - score(b)))
    .filter((m) => (m.dndRate >= 5 || (m.ltRate === 0 && m.replyRate < 5)) && !chosen.has(m.seq + "#" + m.pos + (m.branch || "")))
    .slice(0, 3).map((m) => pack(m, removeReason(m)));

  return { replicate, remove, pool: pool.length, minSends };
}

// Rama de cada contacto, compartida por las dos consultas de build() para que el
// desglose por rama y la tabla de mensajes no puedan discrepar. Manda el tag
// "rama a"/"rama b" de GHL (cohort.branch).
//
// Si el contacto no tiene tag, se deduce, y cada secuencia necesita su método:
//   · defdec — del SMS con el que entró. Sus posiciones tardías son mensajes
//     compartidos entre ramas, así que el texto de un mensaje suelto no dice
//     nada; solo los SMS 1 y 2 son exclusivos y por eso firstmsg ancla en ellos.
//     A = Default · B = Declined.
//   · cold — cada uno de sus mensajes pertenece a una sola rama, así que se
//     resuelve con coldBranchOf() sobre el mensaje mismo (tabla de mensajes) y
//     en SQL sobre todos los mensajes del contacto (desglose por secuencia).
//     en la tabla de mensajes). Aquí sale '-' a propósito.
// Usa $1 = ventana en días.
// skel() del esqueleto, en SQL: mismo reemplazo de {..}->'v' y borrado de todo lo
// que no sea alfanumérico que hace la versión de JS.
const SQL_SKEL = `regexp_replace(regexp_replace(lower(%s), '\\{+[^{}]*\\}+', 'v', 'g'), '[^a-z0-9]', '', 'g')`;
const COLD_CORE_VALUES = COLD_CORES.map((c) => `('${c.core}','${c.br}')`).join(",");

const CBR_CTE = `cold_core(core, br) as (values ${COLD_CORE_VALUES}),
         tmpl_br as (
           -- La rama se resuelve por PLANTILLA (55k filas), no por evento (578k):
           -- el LIKE con comodín adelante es caro y así corre una sola vez.
           select t.tmpl_key, min(m.br) as br
           from (select tmpl_key, ${SQL_SKEL.replace("%s", "tmpl")} as sk
                   from sms_analytics.templates) t
           join cold_core m on t.sk like '%' || m.core || '%'
           group by t.tmpl_key
         ),
         coldbr as (
           -- La rama sale del PRIMER mensaje del contacto que sea reconocible, no
           -- del primero a secas: si el opener salió con el nombre vacío o con una
           -- inicial de más, el contacto igual se identifica por lo que siguió.
           select distinct on (e.contact_id) e.contact_id, tb.br
           from sms_analytics.msg_events e
           join tmpl_br tb on tb.tmpl_key = e.tmpl_key
           where e.wf = 'cold'
           order by e.contact_id, e.pos asc, e.sent_at asc
         ),
         firstmsg as (
           select distinct on (e.contact_id) e.contact_id, t.tmpl
           from sms_analytics.msg_events e
           join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
           where e.wf <> 'defdec'
              or t.tmpl ~* 'default situation' or t.tmpl ~* 'qualify for an mca'
              or t.tmpl ~* 'avoid colections' or t.tmpl ~* 'better option than an mca'
           order by e.contact_id, e.pos asc, e.sent_at asc
         ),
         cbr as (
           select c.contact_id, fm.tmpl as first_tmpl,
             case
               when coalesce(c.branch, '-') <> '-' then upper(c.branch)
               when c.wf = 'cold' then coalesce(upper(cb.br), '-')
               when c.wf = 'defdec' then
                 case when fm.tmpl ~* 'default situation' or fm.tmpl ~* 'avoid colections' then 'A'
                      when fm.tmpl ~* 'qualify for an mca' or fm.tmpl ~* 'better option than an mca' then 'B'
                      else '-' end
               else '-'
             end as br
           from sms_analytics.cohort c
           left join firstmsg fm on fm.contact_id = c.contact_id
           left join coldbr cb on cb.contact_id = c.contact_id
           where c.done and c.entered_at >= now() - ($1 || ' days')::interval
         )`;

// Resuelve la rama a partir de lo que devuelve CBR_CTE. `tmpl` es el texto que
// identifica la rama en cold: el mensaje mismo en la tabla de mensajes, o el
// primero del contacto en el desglose por secuencia.
function branchOf(tagBr: string | null, wf: string, tmpl: string | null): string {
  if (tagBr && tagBr !== "-") return tagBr;
  if (wf === "cold" && tmpl) return coldBranchOf(tmpl) || "-";
  return "-";
}

// Piso de envíos para las secuencias sin copies oficiales cargados. NO aplica a
// cc/cold/defdec: esas se filtran contra su copy oficial y no tienen piso, por
// más pocos envíos que tenga un mensaje.
const NEW_SEQ_MIN_SENDS = 5;

async function build(cfg?: Record<string, string>) {
  return await withDb(async (c) => {
    const out: any = { generatedAt: new Date().toISOString(), windows: {} };

    // Frescura REAL de los datos, no del snapshot. Son dos cosas distintas y la
    // diferencia es justo la que se puede volver peligrosa: `build` filtra las
    // ventanas contra now(), así que reconstruir sin re-ingerir corre la ventana
    // sobre días vacíos y desinfla los volúmenes sin que nada lo delate.
    // `dataThrough` es el SMS más nuevo que hay en la base; `lastRefreshAt`,
    // cuándo se fue a buscar a GHL por última vez. El dashboard estampa esto.
    const fresh = await c.queryObject<{ data_through: string | null; last_refresh: string | null }>(
      `select (select max(sent_at) from sms_analytics.msg_events) as data_through,
              (select to_timestamp((value)::bigint/1000)
                 from sms_analytics.config where key='last_refresh_ms') as last_refresh`);
    out.dataThrough = fresh.rows[0]?.data_through ? new Date(fresh.rows[0].data_through).toISOString() : null;
    out.lastRefreshAt = fresh.rows[0]?.last_refresh ? new Date(fresh.rows[0].last_refresh).toISOString() : null;
    // Cobertura del tag de rama en lo que entró ÚLTIMO. Es distinto de la
    // cobertura de la ventana: dice si el workflow está bien configurado HOY,
    // sin que lo tape el histórico anterior a que se agregara el tag. Cuando
    // arranca una secuencia nueva no hay con qué opinar, así que va null.
    const recent = await c.queryObject<{ wf: string; n: bigint; tagged: bigint }>(
      `select wf, count(*)::bigint as n,
              count(*) filter (where coalesce(branch,'-') <> '-')::bigint as tagged
         from sms_analytics.cohort
        where done and wf <> 'none' and entered_at >= now() - interval '7 days'
        group by wf`);
    const byRecent: Record<string, { n: number; tagged: number }> = {};
    for (const r of recent.rows) byRecent[r.wf] = { n: Number(r.n), tagged: Number(r.tagged) };

    for (const win of [7, 14, 30]) {
      const seqs = await c.queryObject<{ wf: string; ing: bigint; lt: bigint; tagged: bigint }>(
        `select wf, count(*)::bigint as ing, count(*) filter (where won)::bigint as lt,
                count(*) filter (where coalesce(branch,'-') <> '-')::bigint as tagged
         from sms_analytics.cohort
         where done and entered_at >= now() - ($1 || ' days')::interval
         group by wf`, [String(win)]);
      const byWf: Record<string, { ing: number; lt: number; tagged: number }> = {};
      for (const r of seqs.rows) byWf[r.wf] = { ing: Number(r.ing), lt: Number(r.lt), tagged: Number(r.tagged) };

      // Mismo universo de contactos que `seqs` (done + ventana), partido por rama,
      // para que las ramas sumen el total de su secuencia.
      const seqBr = await c.queryObject<{ wf: string; br: string; first_tmpl: string | null; ing: bigint; lt: bigint }>(
        `with ${CBR_CTE}
         select c.wf, cbr.br, cbr.first_tmpl,
                count(*)::bigint as ing,
                count(*) filter (where c.won)::bigint as lt
         from sms_analytics.cohort c
         join cbr on cbr.contact_id = c.contact_id
         where c.done and c.entered_at >= now() - ($1 || ' days')::interval
         group by c.wf, cbr.br, cbr.first_tmpl`, [String(win)]);
      const byWfBr: Record<string, Record<string, { ing: number; lt: number }>> = {};
      for (const r of seqBr.rows) {
        const br = branchOf(r.br, r.wf, r.first_tmpl);
        if (br === "-") continue;
        const m = byWfBr[r.wf] || (byWfBr[r.wf] = {});
        const e = m[br] || (m[br] = { ing: 0, lt: 0 });
        e.ing += Number(r.ing); e.lt += Number(r.lt);
      }

      const msgs = await c.queryObject<{ wf: string; br: string; tmpl: string; pos: number; sends: bigint; replies: bigint; lts: bigint; dnds: bigint }>(
        `with ${CBR_CTE}
         select e.wf, cbr.br, t.tmpl, min(e.pos)::int as pos,
                count(*)::bigint as sends,
                count(*) filter (where e.got_reply)::bigint as replies,
                count(*) filter (where e.led_to_lt and c.won)::bigint as lts,
                count(*) filter (where e.led_to_dnd)::bigint as dnds
         from sms_analytics.msg_events e
         join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
         join sms_analytics.cohort c on c.contact_id = e.contact_id
         join cbr on cbr.contact_id = e.contact_id
         where c.entered_at >= now() - ($1 || ' days')::interval
         group by e.wf, cbr.br, t.tmpl`, [String(win)]);

      const agg: Record<string, Record<string, any>> = {};
      for (const r of msgs.rows) {
        const sk = skel(r.tmpl);
        // Las 3 secuencias viejas se filtran contra sus copies oficiales (OFFICIAL),
        // que es lo que saca el ruido de otros workflows. Una secuencia dada de alta
        // desde la UI no tiene copies cargados: ahí el tag ES el filtro —lo que se
        // mandó bajo ese tag es la secuencia— así que se usa el texto tal cual y el
        // ruido se corta abajo por volumen (NEW_SEQ_MIN_SENDS).
        const text = OFF_TEXT[r.wf] ? OFF_TEXT[r.wf][sk] : r.tmpl;
        if (!text) continue;
        const br = branchOf(r.br, r.wf, r.tmpl);
        const cmap = CANON_POS[r.wf]; const canonPos = cmap ? cmap[sk] : undefined;
        const g = (agg[r.wf] || (agg[r.wf] = {}));
        const gk = sk + "¦" + br;
        const e = g[gk] || (g[gk] = { tmpl: text, pos: (canonPos != null ? canonPos : r.pos), branch: br, canon: canonPos != null, sends: 0, replies: 0, lts: 0, dnds: 0 });
        e.sends += Number(r.sends); e.replies += Number(r.replies); e.lts += Number(r.lts); e.dnds += Number(r.dnds);
        if (!e.canon && r.pos < e.pos) e.pos = r.pos;
      }
      const msgsByWf: Record<string, any[]> = {};
      for (const wf of Object.keys(agg)) {
        // Con posición canónica (cc/cold/defdec) el 28/29 queda resuelto de raíz,
        // así que ya NO usamos un tope por secuencia (escondía mensajes reales y
        // era una trampa si la cadencia crecía). Solo descartamos entradas SIN
        // posición canónica cuyo pos crudo sea absurdo (>50), como guard defensivo.
        // En las secuencias sin copies oficiales se suma el piso de envíos: sin él,
        // cada variante suelta de un mensaje sería su propia fila.
        const official = !!OFF_TEXT[wf];
        msgsByWf[wf] = Object.values(agg[wf]).filter((e: any) =>
          (e.canon || e.pos <= 50) && (official || e.sends >= NEW_SEQ_MIN_SENDS)).map((e: any) => ({
          tmpl: e.tmpl, pos: e.pos, branch: e.branch, sends: e.sends, replies: e.replies, lts: e.lts, dnds: e.dnds,
          replyRate: e.sends ? Math.round(1000 * e.replies / e.sends) / 10 : 0,
          ltRate: e.sends ? Math.round(10000 * e.lts / e.sends) / 100 : 0,
          dndRate: e.sends ? Math.round(1000 * e.dnds / e.sends) / 10 : 0,
        })).sort((a: any, b: any) => b.sends - a.sends);
      }
      out.windows[win] = {
        sequences: WF.map((w) => {
          const s = byWf[w.key] || { ing: 0, lt: 0, tagged: 0 };
          const bm = byWfBr[w.key] || {};
          const branches = Object.keys(bm).sort().map((br) => ({
            branch: br, ing: bm[br].ing, lt: bm[br].lt,
            cr: bm[br].ing ? Math.round(10000 * bm[br].lt / bm[br].ing) / 100 : null,
          }));
          // De dónde salen estas ramas. El tag es la señal buena; el texto del
          // primer mensaje es un respaldo frágil (se rompe con que el contacto
          // no tenga nombre) que quedó cubriendo el histórico previo al tag.
          // Sin esto, una secuencia sin tag muestra ramas que parecen medidas y
          // en realidad son adivinadas — que es justo lo que hay que poder ver.
          const rc = byRecent[w.key];
          const tagPct = s.ing ? Math.round(1000 * s.tagged / s.ing) / 10 : null;
          const tagPctRecent = rc && rc.n >= 20 ? Math.round(1000 * rc.tagged / rc.n) / 10 : null;
          const branchSource = !branches.length ? "none"
            : (tagPct != null && tagPct >= 90 ? "tag" : "text");
          return { key: w.key, label: w.label, ing: s.ing, lt: s.lt,
            cr: s.ing ? Math.round(10000 * s.lt / s.ing) / 100 : null,
            branches, tagPct, tagPctRecent, recentN: rc ? rc.n : 0, branchSource };
        }),
        unidentified: byWf["none"] || { ing: 0, lt: 0 },
        msgs: msgsByWf,
      };
      out.windows[win].insights = computeInsights(out.windows[win]);
    }
    // Capa IA horneada en el snapshot: por cada ventana con mejores/peores, la IA escribe su
    // análisis y queda en insights.ai → el dashboard lo sirve ABIERTO (sin pedir clave a cada
    // visitante). Best-effort: sin key o si Anthropic falla/tarda, el snapshot se guarda igual.
    const akey = (cfg?.anthropic_api_key || "").trim();
    if (akey) {
      for (const win of [7, 14, 30]) {
        const ins = out.windows[win] && out.windows[win].insights;
        if (!ins || ((!ins.replicate || !ins.replicate.length) && (!ins.remove || !ins.remove.length))) continue;
        try {
          const a = await aiFindings(akey, String(win), ins.replicate || [], ins.remove || []);
          if (a && ((a.findings && a.findings.length) || a.narrative))
            ins.ai = { findings: a.findings || null, narrative: a.narrative || null, model: GEN_MODEL, at: new Date().toISOString() };
        } catch (_e) { /* best-effort: la IA no bloquea el build */ }
      }
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
  let md = "# SMS PERFORMANCE — " + ((w.sequences || []).length) + " sequences (window: " + win + "d)\n";
  md += "meta:\n  source: GoHighLevel SMS analytics (read-only)\n";
  md += "  snapshot_at: " + (snap.snapshotAt || snap.generatedAt || "") + "\n";
  md += "  window_days: " + win + "\n";
  md += "  metric_defs: { conversion_to_LT: live_transfers/contacts_entered (2 decimals), resp_rate: responses/sent, lt_rate: msg_led_to_LT/sent, optout_rate: opt_outs/sent (opt-out = lead requested STOP, GHL auto-DND) }\n\n";
  md += "## perf.sequences [item: sequence-summary]\n";
  md += "| key | sequence | contacts_entered | live_transfers | conversion_to_LT |\n|---|---|--:|--:|--:|\n";
  const seqs = (w.sequences || []).slice().sort((a: any, b: any) => (b.cr == null ? -1 : b.cr) - (a.cr == null ? -1 : a.cr));
  for (const s of seqs) md += "| " + s.key + " | " + s.label + " | " + (s.ing == null ? "-" : s.ing) + " | " + (s.lt == null ? "-" : s.lt) + " | " + (s.cr == null ? "-" : s.cr + "%") + " |\n";
  const u = w.unidentified || { ing: 0, lt: 0 };
  md += "\nnote: outside these sequences = " + u.ing + " contacts / " + u.lt + " LT (other workflows or manual sends).\n\n";
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
// Busca el doc de una persona con fallback al 'persona' escrito a mano: mientras
// una vertical no haya corrido su primera generación, los consumidores siguen
// recibiendo el doc viejo en vez de romperse.
async function personaDocMd(c: Client, personaKey: string): Promise<string> {
  const p = await c.queryObject<{ md: string }>(
    "select md from sms_analytics.context_docs where key = any($1::text[]) order by array_position($1::text[], key) limit 1",
    [["persona_" + personaKey, "persona"]]);
  return (p.rows[0] && p.rows[0].md) || "(persona doc missing)";
}

async function context(win: string, personaKey = "mca"): Promise<string> {
  return await withDb(async (c) => {
    const q = await c.queryObject<{ data: any; created_at: string }>(
      "select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1");
    const snap = q.rows[0] ? { ...q.rows[0].data, snapshotAt: q.rows[0].created_at } : null;
    const personaMd = await personaDocMd(c, personaKey);
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
// Investigación de compliance (frameworks aplicables al outbound SMS de MCA/debt en EE.UU.):
//   · CTIA Messaging Principles & Best Practices  · TCR (The Campaign Registry) prohibited content
//   · T-Mobile Code of Conduct / A2P 10DLC  · Twilio Messaging Policy (SHAFT + high-risk finance)
//   · FTC Telemarketing Sales Rule / debt-relief & credit-repair rules  · CFPB UDAAP.
// Debt-relief / lending es una categoría EXPLÍCITAMENTE restringida por los carriers: términos como
// "lender/loan/debt/consolidation/settlement/guaranteed" disparan filtrado. Word-boundary => "settle"
// NO matchea "Settlegroup", y no baneamos vocabulario válido (advance, funding, restructure, relief,
// cash flow, default, pre-qualify, lower, options). Cada término se valida en código (no es opcional).
const BLOCKLIST: string[] = [
  // -- Lending / loan (el bug reportado: "lender") --
  "lender", "lenders", "lend", "lends", "lending", "lended", "loaner",
  "loan", "loans", "loaned", "loaning",
  "borrow", "borrows", "borrowed", "borrowing", "borrower", "borrowers",
  "creditor", "creditors", "payday", "payday loan", "payday advance",
  "refinance", "refinancing", "refinanced", "refi",
  // -- Deuda --
  "debt", "debts", "debtor", "debtors", "indebted", "indebtedness",
  // -- Financiero (payment/cost disparan filtros en MCA) --
  "payment", "payments", "cost", "costs", "monthly payment", "weekly payment",
  // -- Relief / settlement / consolidation / forgiveness --
  "consolidate", "consolidates", "consolidated", "consolidating", "consolidation", "debt consolidation",
  "settle", "settles", "settled", "settling", "settlement", "settlements", "debt settlement",
  "forgive", "forgives", "forgiven", "forgiveness", "debt forgiveness",
  "debt relief", "debt reduction", "debt elimination", "debt free", "debt-free",
  "eliminate", "eliminates", "eliminated", "eliminating",
  "wipe out", "erase your debt", "erase debt", "get out of debt", "get rid of",
  "write off", "write-off", "charge off", "charge-off",
  // -- Credit repair / credit score --
  "credit repair", "repair your credit", "fix your credit", "fix my credit",
  "bad credit", "poor credit", "low credit", "no credit", "no credit check", "without a credit check",
  "credit score", "credit scores", "boost your credit", "raise your credit", "credit report",
  // -- Garantías / promesas absolutas --
  "guarantee", "guarantees", "guaranteed", "guaranteeing",
  "pre-approved", "preapproved", "pre approved", "guaranteed approval", "instant approval", "approval guaranteed",
  "risk-free", "risk free", "no risk", "no-risk", "no obligation", "no strings", "no catch",
  "promise", "promised",
  // -- Money-bait / free / cash bait --
  "free", "100% free", "free money", "free cash", "free consultation", "free quote", "free trial",
  "fast cash", "quick cash", "easy cash", "extra cash", "cash bonus", "cash now", "instant cash", "get cash",
  "cash back", "cashback",
  "bonus", "bonuses", "prize", "prizes", "winner", "you won", "you've won", "congratulations", "congrats",
  "reward", "rewards", "gift card", "gift cards", "voucher",
  "discount", "discounts", "special offer", "exclusive offer", "limited offer", "limited-time offer", "best offer",
  "special deal", "best deal", "unbeatable", "lowest rate", "best rate", "lowest price", "best price",
  "save big", "save thousands", "save up to", "double your money", "get rich", "wire transfer", "western union",
  // -- Urgencia / presión --
  "act now", "act fast", "apply now", "buy now", "order now", "sign up now", "enroll now", "call immediately",
  "urgent", "urgently", "hurry", "don't wait", "dont wait", "don't miss", "last chance",
  "final notice", "final warning", "expires", "expiring", "limited time", "limited-time",
  "time sensitive", "time-sensitive", "while supplies last", "today only", "now or never",
  "immediate action", "action required",
  // -- Cobranza / amenaza legal (nunca amenazar en SMS frío) --
  "lawsuit", "lawsuits", "sue", "sued", "suing", "litigation", "litigate",
  "legal action", "take legal action", "legal notice", "legal proceedings",
  "garnish", "garnishment", "garnished", "garnishing", "wage garnishment",
  "levy", "levied", "bank levy", "seize", "seizure", "seized", "asset seizure",
  "repossess", "repossession", "repossessed", "foreclose", "foreclosure",
  "warrant", "subpoena", "summons", "court order", "judgment", "judgement",
  "arrest", "jail", "prosecute", "prosecution",
  "collection agency", "collections agency", "debt collector", "debt collectors",
  "irs", "tax lien", "back taxes",
  // -- Phishing / clickbait --
  "click here", "click below", "click the link", "click this link", "tap here",
  "verify your account", "confirm your identity", "you have been selected", "you've been selected",
  "dear customer", "dear sir",
  // -- A2P prohibido universal (SHAFT + verticales restringidos): cinturón y tiradores --
  "cannabis", "marijuana", "weed", "cbd", "thc", "kratom", "vape", "vaping", "e-cigarette",
  "tobacco", "cigarette", "cigarettes", "nicotine",
  "alcohol", "liquor", "vodka", "whiskey", "beer", "wine",
  "casino", "gambling", "betting", "sportsbook", "lottery", "sweepstakes", "poker", "slots",
  "firearm", "firearms", "ammo", "ammunition", "handgun", "rifle", "gun",
  "sex", "sexy", "porn", "escort", "adult content", "xxx", "hookup",
];

// Sustituciones seguras para el vertical MCA / restructuring (sesga al modelo).
const SUBSTITUTIONS: [string, string][] = [
  ["lender / lenders", "your positions / your current accounts"],
  ["debt", "balances / positions"],
  ["loan", "advance / funding"],
  ["payment / payments", "weekly amount / what you owe each week"],
  ["cost / costs", "weekly strain / amount"],
  ["consolidate", "restructure your positions"],
  ["settle / settlement", "resolve / restructure"],
  ["forgiveness", "lower your weekly amount"],
  ["get rid of", "restructure"],
  ["eliminate", "improve cash flow"],
  ["guaranteed / pre-approved", "you may qualify / pre-qualify"],
  ["free", "complimentary / no-cost"],
  ["lawsuit / legal action", "attorney-led protection"],
];

const SHORTENERS = ["bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "is.gd", "buff.ly", "rebrand.ly"];
// Caracteres que fuerzan UCS-2 (segmentos de 70) y son señal de spam.
const UCS2_CHARS = /[‐-―‘’“”…•]|[\u{1F000}-\u{1FAFF}]|[☀-➿]|[←-⇿]/u;
const CAPS_OK = ["SMS", "MCA", "LLC", "USA", "SBA", "UCC", "APR", "US"];

// ---- Variables permitidas (merge tokens de GHL) -----------------------------
// Por ahora SOLO se permiten estas dos. Cualquier otra variable ({monto}, city,
// company, etc.) se marca como violación. Los tokens del análisis interno
// ({nombre}/{opener}/…) se NORMALIZAN a estos antes de validar/mostrar.
const ALLOWED_TOKENS = ["{{contact.first_name}}", "{{user.name}}"];
// Largo NOMINAL con el que cuenta cada token al medir el largo "as-delivered"
// (el token se expande al valor real; contarlo literal sobreestima el segmento).
const TOKEN_RENDER_LEN: Record<string, number> = { "{{contact.first_name}}": 7, "{{user.name}}": 8 };
// Alias que el modelo podría emitir -> se reescriben al token correcto de GHL.
// (el orden importa; "user.name" no se corrompe porque 'name' va precedido de '.').
const TOKEN_ALIASES: [RegExp, string][] = [
  [/\{\{?\s*(?:contact\.)?first[_\s]?name\s*\}?\}/gi, "{{contact.first_name}}"],
  [/\{\{?\s*nombre\s*\}?\}/gi, "{{contact.first_name}}"],
  [/\{\{?\s*name\s*\}?\}/gi, "{{contact.first_name}}"],
  [/\{\{?\s*fname\s*\}?\}/gi, "{{contact.first_name}}"],
  [/\{\{?\s*(?:user\.name|opener|rep|rep\s*name|agent|agent\s*name|sender)\s*\}?\}/gi, "{{user.name}}"],
];

const COMPLIANCE_BANNED = BLOCKLIST.join(", ");
const COMPLIANCE_SUBS = SUBSTITUTIONS.map(([a, b]) => a + " -> " + b).join("; ");
const ALLOWED_VARS_STR = ALLOWED_TOKENS.join(" y ");

function reEscape(s: string): string { return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"); }

// Normaliza los tokens que el modelo escriba a los 2 merge fields de GHL permitidos.
function normalizeTokens(s: string): string {
  let t = String(s || "");
  for (const [re, canon] of TOKEN_ALIASES) t = t.replace(re, canon);
  return t;
}
// Largo "as-delivered": cada token cuenta como el valor que rellena, no su literal.
function renderLen(s: string): number {
  let t = String(s || "");
  for (const tok of Object.keys(TOKEN_RENDER_LEN)) t = t.split(tok).join("x".repeat(TOKEN_RENDER_LEN[tok]));
  return t.length;
}

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

// Compuerta de compliance para un SMS. Devuelve texto limpio (tokens normalizados),
// el largo "as-delivered" y las violaciones.
function checkCompliance(raw: string): { text: string; len: number; ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const text = normalizeTokens(stripOptOut(raw));
  const lower = text.toLowerCase();

  for (const term of BLOCKLIST) {
    const re = new RegExp("\\b" + reEscape(term).replace(/ +/g, "\\s+") + "\\b", "i");
    if (re.test(lower)) violations.push('banned: "' + term + '"');
  }
  // Variables: SOLO se permiten las dos de GHL; cualquier otro {token} es violación.
  const badTokens = (text.match(/\{{1,2}[^{}]*\}{1,2}/g) || []).filter((tk) => !ALLOWED_TOKENS.includes(tk));
  for (const tk of [...new Set(badTokens)]) violations.push("invalid variable " + tk + " (only " + ALLOWED_VARS_STR + " allowed)");
  const len = renderLen(text);
  if (len > SMS_MAX_CHARS) violations.push("too long: " + len + "/" + SMS_MAX_CHARS + " (as delivered)");
  if (UCS2_CHARS.test(text)) violations.push("non-GSM char (emoji/smart-quote/em-dash) -> UCS-2");
  for (const d of SHORTENERS) if (lower.includes(d)) violations.push("link shortener: " + d);
  const caps = (text.match(/\b[A-Z]{2,}\b/g) || []).filter((w) => !CAPS_OK.includes(w));
  if (caps.length) violations.push("ALL-CAPS: " + caps.join(", "));
  if ((text.match(/[!?]/g) || []).length > 1) violations.push("excessive ! or ?");
  if (/100\s?%|\bwill save\b|\balways save\b|\bno risk\b/i.test(text)) violations.push("absolute promise");

  return { text, len, ok: violations.length === 0, violations };
}

// ---- FASE 3: generador de secuencias SMS con IA (rendimiento + persona + voz de marca) ----
async function generate(cfg: Record<string, string>, body: any) {
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Missing 'anthropic_api_key' in the sms_analytics.config table. Add it in the Supabase Table Editor and retry." };
  const model = GEN_MODEL;
  const brief = (body && body.brief) || {};
  const win = String(brief.win || "30");
  const nMsgs = Math.min(Math.max(parseInt(brief.messages) || 6, 3), 12);
  const nVars = Math.min(Math.max(parseInt(brief.variants) || 2, 1), 3);
  const goal = String(brief.goal || "cold outreach to stacked owners who are current but drowning").slice(0, 400);
  const audience = String(brief.audience || "use the persona as-is").slice(0, 400);
  const lang = String(brief.lang || "English").slice(0, 40);
  const personaKey = keyOk(String(brief.persona || "")) ? String(brief.persona) : "mca";

  const inputs = await withDb(async (c) => {
    const q = await c.queryObject<{ data: any; created_at: string }>(
      "select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1");
    const snap = q.rows[0] ? { ...q.rows[0].data, snapshotAt: q.rows[0].created_at } : null;
    const b = await c.queryObject<{ md: string }>("select md from sms_analytics.context_docs where key='brandvoice'");
    return { perf: perfMd(snap, win), persona: await personaDocMd(c, personaKey), brand: (b.rows[0] && b.rows[0].md) || "(none)" };
  });

  const sys = [
    "You are an elite outbound SMS copywriter for a U.S. MCA (merchant cash advance) debt-restructuring firm.",
    "Your job: write SMS sequences that make stacked small-business owners REPLY and accept a live transfer to a closer.",
    "You are given three inputs: PERFORMANCE DATA (which message structures empirically convert — reply/live-transfer/opt-out rates per message, plus best-response, best-LT and highest-opt-out signals), BUYER PERSONA (who closes and why, in their own words), and BRAND VOICE (tone, promise, allowed claims, compliance guardrails).",
    "Principles:",
    "- Ground every choice in the DATA + PERSONA. Lead with the winning angle: stacking + one affordable payment (up to 50-70% lower) + legal shield. They WANT to pay — never imply debt erasure or evasion.",
    "- Model structure on the best-response and best-LT messages; avoid the structure of the highest-opt-out message.",
    "- Mirror the persona's language and metrics (weekly/daily payments, % reduction). Pre-empt the #1 objection (distrust) early: attorney-led, no upfront, we understand your exact situation. Do NOT name or reference their 'lender(s)' — that word is banned; say 'your positions' or 'your current accounts' instead.",
    "- HARD LIMIT: every SMS MUST be 150 characters or fewer AS DELIVERED (a merge token counts as the short value it fills in — a first name / a rep name — not its literal length). Shorter is better.",
    "- VARIABLES: the ONLY two allowed are {{contact.first_name}} (lead first name) and {{user.name}} (sender/rep name) — write them verbatim, with double curly braces. Do NOT use ANY other variable or merge field: no amount, dollar, company, city, day or time token. If you'd cite a dollar amount, phrase it generically ('your weekly payments', 'your positions') with NO number token. Any other {token} is auto-flagged as a failure.",
    "- The PERFORMANCE examples below use internal placeholders like {nombre}, {opener}, {monto}. In YOUR output translate {nombre} -> {{contact.first_name}}, {opener} -> {{user.name}}, and DROP {monto} entirely (rewrite the line without any amount).",
    "- NEVER include opt-out, STOP, HELP, unsubscribe, or 'msg & data rates' language anywhere — not even on the first message. The client appends the legally-required opt-out separately, downstream. Any STOP/opt-out text is stripped automatically and counts as a failure.",
    "- Identify the sender by rep name ({{user.name}}) and stay truthful; always use 'up to' with any percentage. Do NOT add any compliance/opt-out footer.",
    "- BANNED WORDS (hardcoded; auto-flagged in code after you write — never use, in any form or casing): " + COMPLIANCE_BANNED + ".",
    "- Prefer these safer substitutions instead: " + COMPLIANCE_SUBS + ".",
    "- The PERSONA/BRAND context may itself contain banned words (it describes their 'lenders', 'debt', 'settlement'). NEVER copy those words into an SMS — always translate to the allowed vocabulary above.",
    "- Plain ASCII only: no emojis, no smart quotes or em-dashes, no ALL-CAPS words, at most one '!' or '?' in total, no link shorteners.",
    "- Produce testable VARIANTS with distinct hooks/angles so performance can compare them — not one final copy.",
    "Respond with ONLY valid JSON (no markdown fences, no prose) matching the schema in the user message.",
  ].join("\n");

  const schema = '{"variants":[{"name":"short label","angle":"the core hook in one line","messages":[{"n":1,"day":0,"text":"SMS copy using ONLY {{contact.first_name}} and {{user.name}} as variables","why":"one-line rationale citing a data or persona signal"}]}],"notes":"what to A/B test between the variants"}';

  const user = "PERFORMANCE DATA:\n" + inputs.perf + "\n\n===\n\nBUYER PERSONA:\n" + inputs.persona + "\n\n===\n\nBRAND VOICE:\n" + inputs.brand +
    "\n\n===\n\nBRIEF:\n- Goal: " + goal + "\n- Audience: " + audience + "\n- Messages per sequence: " + nMsgs + "\n- Variants: " + nVars + "\n- Language: " + lang +
    "\n\nReturn ONLY JSON in this exact shape:\n" + schema;

  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // OJO: en la API de Anthropic max_tokens ACOTA razonamiento + salida juntos.
      // GEN_MODEL (sonnet-5) usa "adaptive thinking" por defecto; con 8000 el thinking
      // se comía el presupuesto y el JSON salía vacío ("empty"). 16000 deja aire de sobra.
      body: JSON.stringify({ model, max_tokens: 16000, system: sys, messages: [{ role: "user", content: user }] }),
    });
  } catch (e) { return { error: "Anthropic fetch failed: " + String(e) }; }
  if (!r.ok) return { error: "Anthropic " + r.status + ": " + (await r.text()).slice(0, 400) };
  const j = await r.json();
  const stopReason = String(j.stop_reason || "");
  const thinkTok = (j.usage && j.usage.output_tokens_details && j.usage.output_tokens_details.thinking_tokens) || 0;
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
        m.text = chk.text; m.chars = chk.len; m.compliant = chk.ok; m.violations = chk.violations;
        checked++; if (!chk.ok) flagged++;
      }
    }
  };
  rescan();

  // Auto-reparacion ITERATIVA: reescribimos SOLO los flaggeados, hasta MAX_REPAIR_PASSES
  // pasadas o hasta que no quede ninguno. Cada pasada re-valida en codigo; si una pasada
  // no mejora NADA, cortamos (no tiene sentido seguir gastando API).
  const MAX_REPAIR_PASSES = 3;
  const rsys = "You rewrite outbound SMS so they pass hardcoded compliance rules. Keep the SAME intent. The ONLY variables allowed are {{contact.first_name}} and {{user.name}} — convert or remove any other token (e.g. an amount/{monto} token) and never invent new ones. Rules: <=150 chars as delivered; NO opt-out/STOP/HELP/'msg&data' text; plain ASCII only; no ALL-CAPS words; at most one ! or ? total; and NEVER use these banned words in any form: " +
    COMPLIANCE_BANNED + ". Prefer: " + COMPLIANCE_SUBS + ". Respond with ONLY a JSON array echoing vi/mi: [{\"vi\":0,\"mi\":0,\"text\":\"...\"}].";
  let repairPasses = 0;
  while (parsed && flagged > 0 && repairPasses < MAX_REPAIR_PASSES) {
    repairPasses++;
    const bad: any[] = [];
    parsed.variants.forEach((v: any, vi: number) => (v.messages || []).forEach((m: any, mi: number) => {
      if (m && m.violations && m.violations.length) bad.push({ vi, mi, text: m.text, fix: m.violations });
    }));
    if (!bad.length) break;
    let progressed = false;
    try {
      const rr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        // max_tokens acota thinking + salida; 2000 se quedaba corto y la reparación salía vacía.
        body: JSON.stringify({ model, max_tokens: 8000, system: rsys, messages: [{ role: "user", content: "Rewrite each to fix its violations:\n" + JSON.stringify(bad) }] }),
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
              if (chk.violations.length < (m.violations || []).length) { m.text = f.text; repaired = true; progressed = true; } // solo si mejora
            }
          }
          rescan();
        }
      }
    } catch (_) { /* seguimos con lo que haya */ }
    if (!progressed) break; // una pasada sin mejoras => no insistas
  }

  // GATE FINAL: cualquier mensaje que TODAVIA no cumpla se ELIMINA — nunca se ofrece uno riesgoso.
  // Renumeramos los que quedan (n secuencial) y descartamos variantes que quedaron vacias.
  let removed = 0;
  if (parsed && Array.isArray(parsed.variants)) {
    for (const v of parsed.variants) {
      const msgs = (v.messages || []);
      const kept = msgs.filter((m: any) => m && m.compliant !== false);
      removed += msgs.length - kept.length;
      kept.forEach((m: any, i: number) => { m.n = i + 1; });
      v.messages = kept;
    }
    parsed.variants = parsed.variants.filter((v: any) => (v.messages || []).length > 0);
    if (removed) rescan(); // recomputa checked/flagged solo sobre lo que SI se ofrece (flagged -> 0)
  }

  // Diagnóstico legible cuando NO hubo JSON válido: decimos EXACTAMENTE qué falló.
  const diag = parsed ? undefined :
    (stopReason === "max_tokens"
      ? "El modelo cortó por límite de tokens (stop_reason=max_tokens): usó " + thinkTok + " tokens de razonamiento y no le quedó presupuesto para el JSON. Ya se subió max_tokens; si vuelve a pasar, subilo más o bajá variantes/mensajes."
      : (!text
          ? "El modelo no devolvió texto (stop_reason=" + (stopReason || "?") + ", " + thinkTok + " tokens de razonamiento). Probable corte por thinking/max_tokens."
          : "El modelo devolvió texto que no es JSON válido (stop_reason=" + (stopReason || "?") + "). Ver el texto crudo abajo."));
  return { ok: true, model, elapsedMs: Date.now() - t0, stop_reason: stopReason,
    brief: { goal, audience, messages: nMsgs, variants: nVars, lang, win, persona: personaKey },
    compliance: { checked, flagged, removed, repaired, repairPasses, maxChars: SMS_MAX_CHARS,
      note: "Only messages that pass every hardcoded rule are offered — any that couldn't be repaired in " + MAX_REPAIR_PASSES + " passes are dropped, not shown. Even so, cold MCA/debt-restructuring outbound is a category formally prohibited by T-Mobile/Twilio/TCR: deliverability depends on number reputation, consent and rotation, not just the copy." },
    usage: j.usage || null, result: parsed, raw: parsed ? undefined : text, diag: diag };
}

// ---- INSIGHTS con IA: ANÁLISIS GLOBAL en prosa (un solo texto, NO lista mensaje-por-mensaje) --
// Recibe los insights deterministas (replicate/remove) y pide a la IA UN análisis global (110-170
// palabras) que lee el panorama entero: patrón que separa lo que convierte, palanca principal,
// riesgo mayor y una recomendación. Devuelve {narrative}. Lo usan (a) build(), que lo HORNEA en el
// snapshot para servirlo ABIERTO sin clave, y (b) la acción on-demand insight_ai. Best-effort +
// timeout duro: si Anthropic falla/tarda devuelve {error} y el llamador sigue sin romperse.
// (parseFindings quedó como legacy — ya no se usa; el output es prosa directa.)
function parseFindings(text: string): any[] | null {
  let s = (text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s);
    const arr = Array.isArray(o) ? o : (o.findings || o.hallazgos || null);
    if (!Array.isArray(arr)) return null;
    return arr.map((f: any) => ({
      lens: String(f.lens || f.expert || f.discipline || "").slice(0, 40),
      verdict: (["win", "kill", "watch"].includes(String(f.verdict)) ? f.verdict : "watch"),
      title: String(f.title || f.finding || f.headline || "").slice(0, 160),
      detail: String(f.detail || f.why || f.reason || f.evidence || "").slice(0, 400),
    })).filter((f: any) => f.title);
  } catch (_e) { return null; }
}
async function aiFindings(
  akey: string, win: string, replicate: any[], remove: any[],
): Promise<{ findings?: any[]; narrative?: string; error?: string; elapsedMs?: number }> {
  const sys = [
    "You are a senior outbound-SMS strategist auditing an MCA debt-restructuring campaign.",
    "You receive the BEST and WORST performing messages of the sequences, each with its",
    "response, live-transfer and opt-out rates.",
    "Write ONE sharp, intelligent GLOBAL read in plain prose — NOT a per-message list, NOT bullets.",
    "Cover two things clearly: (1) the STRENGTHS — what's working and WHY it converts; (2) the",
    "WEAKNESSES — what's dragging results and WHY. Step back to the overall pattern; you may cite a",
    "sequence or sms# as evidence, but never do a message-by-message breakdown.",
    "Then end with ONE short recommendation: a single sentence, max 18 words, concrete and actionable.",
    "Be insightful and non-obvious — draw the reusable rule, don't just restate numbers.",
    "Rules: 80-120 words total, no headers, no markdown, no JSON. Return ONLY the prose text, no preamble.",
  ].join("\n");
  const user = "WINDOW: " + win + "d\n\nBEST (replicate):\n" + JSON.stringify(replicate) +
    "\n\nWORST (remove):\n" + JSON.stringify(remove);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // max_tokens acota thinking + salida; 700 se lo comía el thinking y volvía narrativa vacía.
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 4000, system: sys, messages: [{ role: "user", content: user }] }),
      signal: ctrl.signal,
    });
  } catch (e) { clearTimeout(timer); return { error: "fetch a Anthropic fallo: " + String(e) }; }
  clearTimeout(timer);
  if (!r.ok) return { error: "Anthropic " + r.status + ": " + (await r.text()).slice(0, 300) };
  const j = await r.json();
  const text = (j.content || []).map((b: any) => b.text || "").join("").trim();
  return { narrative: text, elapsedMs: Date.now() - t0 }; // análisis global en prosa (un solo texto)
}

// Acción on-demand: lee los insights del último snapshot y devuelve el análisis IA en vivo.
async function insightAi(cfg: Record<string, string>, win: string) {
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Missing 'anthropic_api_key' in sms_analytics.config." };
  const snap = await withDb(async (c) => {
    const q = await c.queryObject<{ data: any }>("select data from sms_analytics.snapshots_v2 order by id desc limit 1");
    return q.rows[0] ? q.rows[0].data : null;
  });
  const w = snap && snap.windows && snap.windows[win];
  const ins = w && w.insights;
  if (!ins || ((!ins.replicate || !ins.replicate.length) && (!ins.remove || !ins.remove.length)))
    return { error: "No insights yet — run a build with data first." };
  const a = await aiFindings(akey, win, ins.replicate || [], ins.remove || []);
  if (a.error) return { error: a.error };
  return { ok: true, win, model: GEN_MODEL, elapsedMs: a.elapsedMs, findings: a.findings || null, narrative: a.narrative || null,
    counts: { replicate: (ins.replicate || []).length, remove: (ins.remove || []).length } };
}

// ============================================================================
// BUYER PERSONA — una persona por vertical (MCA / Credit Card), generada desde
// las transcripciones de las llamadas que terminaron en WON.
//
// Cadena completa:  persona_scan -> persona_transcribe -> persona_extract -> persona_build
//
// Igual que el backfill de SMS, la transcripción no entra en los 150s de una
// edge function, así que `call_transcript` es a la vez cola y almacén y se drena
// por tandas acotadas por tiempo. La diferencia con `work()` es que ACÁ SE GASTA
// PLATA, y por eso el unique(message_id, rec_index) de la tabla no es cosmético:
// una llamada ya transcripta nunca se re-manda a Deepgram, así que re-scanear o
// loopear el endpoint abierto cuesta 0.
// ============================================================================

// Las 5 secciones son FIJAS y su numeración/título/ayuda son copy del código, no
// salida del modelo. Eso es lo que garantiza que el diseño de las tarjetas del
// dashboard no dependa de lo que se le ocurra escribir a la IA.
const PERSONA_SECTIONS: { id: string; no: string; title: string; help: string }[] = [
  { id: "firmographics", no: "01", title: "Firmographics",
    help: "Industry, geography and track record of the businesses that close" },
  { id: "pain_context", no: "02", title: "Pain points &amp; context",
    help: "What hurts them and why they answer the call" },
  { id: "buying_drivers", no: "03", title: "Buying drivers",
    help: "What motivates them to close" },
  { id: "objections", no: "04", title: "Typical objections &amp; how to handle them",
    help: "The typical objection and the line that disarms it (gold for the SMS copy)" },
  { id: "voice", no: "05", title: "Communication style",
    help: "Their words and the metrics they watch — to mirror in the SMS copy" },
];
const PERSONA_SECTION_IDS = PERSONA_SECTIONS.map((s) => s.id);

const DG_URL = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=multi";
// Deepgram acepta hasta ~2 GB; el límite real acá es la memoria de la edge
// function (~256 MB). Las llamadas de cierre de MCA promedian 30 min (~28 MB) y
// llegan a 69 (~63 MB), así que 60 MB descartaba justo las más sustanciosas.
const MAX_AUDIO_BYTES = 220 * 1024 * 1024;
const BYTES_PER_SEC = 16000;   // PCM 8 kHz, 16 bit, mono
const DUR_UNKNOWN_S = 4200;    // sin duración se asume el peor caso conocido
const MIN_TRANSCRIPT_WORDS = 50;          // menos que esto = silencio / música de espera
const DEFAULT_DAILY_MINUTES_CAP = 600;
// Una fila reclamada que quedó en 'running' porque la edge function murió a los
// 150s vuelve a estar disponible pasado este rato.
const CLAIM_STALE_MIN = 10;
const CLAIMABLE = `(t.status = 'queued' or (t.status = 'running' and t.claimed_at < now() - interval '${CLAIM_STALE_MIN} minutes'))`;
// Margen para que una tanda entre entera en el presupuesto en vez de arrancar
// a último momento, pagar Deepgram y morir antes de guardar la transcripción.
// Con audios de 30-69 min una tanda tarda ~90s, así que la reserva es grande:
// en la práctica corre UNA tanda por invocación, que es lo predecible.
const BATCH_RESERVE_MS = 75000;
const HTTP_TIMEOUT_MS = 90000;

function nInt(v: any): number { return Number(v || 0); }
function keyOk(k: string): boolean { return /^[a-z0-9_-]{2,24}$/.test(k); }

// Hermano binario de gget(): mismo backoff, pero devuelve bytes en vez de JSON.
// GHL responde 403 bajo ráfaga (verificado), así que entra en la lista de reintentos.
async function gbin(url: string, key: string, tries = 4): Promise<{ ok: boolean; status: number; bytes: ArrayBuffer | null }> {
  let status = 0;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + key, Version: VER }, signal: ctrl.signal });
      status = r.status;
      if (r.status === 200) { const b = await r.arrayBuffer(); clearTimeout(timer); return { ok: true, status, bytes: b }; }
      clearTimeout(timer);
      if ([429, 403, 502, 503].includes(r.status)) { await sleep(1500 + i * 1500); continue; }
      return { ok: false, status, bytes: null };
    } catch (_) { clearTimeout(timer); await sleep(1000 + i * 1000); }
  }
  return { ok: false, status, bytes: null };
}

// fetch con timeout duro. Sin esto, una descarga o un POST colgado se come el
// presupuesto entero de la invocación (aiFindings ya usaba este patrón).
async function fetchT(url: string, init: RequestInit, ms = HTTP_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// ---- Lectura: configs + pipelines + estado de la cola -----------------------
async function personas() {
  return await withDb(async (c) => {
    const cfgs = await c.queryObject<any>(
      `select key, label, headline, sort, active, min_sample, since_days
         from sms_analytics.persona_config order by sort, key`);
    const pipes = await c.queryObject<any>(
      `select persona_key, pipeline_id, pipeline_name from sms_analytics.persona_pipeline
        order by persona_key, pipeline_name`);
    const counts = await c.queryObject<any>(
      `select p.persona_key,
              count(*) filter (where t.status = 'queued')::bigint   as queued,
              count(*) filter (where t.status = 'done')::bigint     as done,
              count(*) filter (where t.status = 'no_audio')::bigint as no_audio,
              count(*) filter (where t.status = 'failed')::bigint   as failed,
              count(*) filter (where t.status = 'short')::bigint    as short
         from sms_analytics.persona_pipeline p
         join sms_analytics.call_transcript t on t.pipeline_id = p.pipeline_id
        group by p.persona_key`);
    const docs = await c.queryObject<any>(
      `select persona_key, n_calls, created_at from sms_analytics.persona_doc where is_current`);

    const byKey = (rows: any[], k: string) => rows.filter((r) => r.persona_key === k);
    return (cfgs.rows || []).map((cf: any) => {
      const q = byKey(counts.rows || [], cf.key)[0] || {};
      const d = byKey(docs.rows || [], cf.key)[0] || null;
      return {
        key: cf.key, label: cf.label, headline: cf.headline, sort: cf.sort,
        active: cf.active, minSample: cf.min_sample, sinceDays: cf.since_days,
        pipelines: byKey(pipes.rows || [], cf.key).map((p: any) => ({ id: p.pipeline_id, name: p.pipeline_name })),
        queue: { queued: nInt(q.queued), done: nInt(q.done), noAudio: nInt(q.no_audio),
                 failed: nInt(q.failed), short: nInt(q.short) },
        current: d ? { nCalls: d.n_calls, at: d.created_at } : null,
      };
    });
  });
}

// Los pipelines de GHL, para la UI de selección. Sumar un buyer nuevo (o
// "United Settlement Closing" cuando exista) es tildarlo acá, no tocar código.
async function ghlPipelines(cfg: Record<string, string>) {
  const d = await gget(BASE + "/opportunities/pipelines?locationId=" + cfg.ghl_location, cfg.ghl_api_key);
  const pls = d?.pipelines ?? [];
  if (!pls.length) return { error: "GHL no devolvió pipelines (¿token o location?)" };
  return {
    pipelines: pls.map((p: any) => ({
      id: p.id, name: p.name,
      closing: /closing|wins?\b/i.test(p.name || ""),
      wonStageId: (p.stages || []).find((s: any) => /^won$|ganad/i.test((s.name || "").trim()))?.id || null,
      stages: (p.stages || []).map((s: any) => ({ id: s.id, name: s.name })),
    })).sort((a: any, b: any) => (b.closing ? 1 : 0) - (a.closing ? 1 : 0) || a.name.localeCompare(b.name)),
  };
}

// ---- Alta de secuencias desde la UI ----------------------------------------
// El dashboard mide una secuencia cuando (1) existe su fila en `workflows` y (2)
// el workflow de GHL le pone su tag al contacto al entrar. El tag lo elige el
// sistema, no el usuario: la instrucción que se muestra en pantalla tiene que ser
// literalmente el string que después busca el clasificador.

const TAG_PREFIX = "secuencia ";
// El slug se corta en palabras enteras: un tag a medio nombre ("secuencia partner
// sequence mca") no se reconoce de un vistazo entre los cientos que hay en GHL.
const TAG_SLUG_MAX = 40;
const TAG_MAX = TAG_PREFIX.length + TAG_SLUG_MAX + 6;   // + margen del sufijo anti-colisión
const BRANCH_TAGS = ["rama a", "rama b"];

function deaccent(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Los emojis de los nombres de workflow se van con el filtro a-z0-9; si no queda
// nada utilizable, el nombre no sirve de slug y el llamador decide qué hacer.
function tagFromName(name: string): string {
  const words = deaccent(name).replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? out + " " + w : w;
    if (next.length > TAG_SLUG_MAX) break;
    out = next;
  }
  return out;
}

function keyFromName(name: string): string {
  const k = deaccent(name).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "");
  return k.length >= 2 ? k : "";
}

function uniqueOf(base: string, taken: Set<string>, sep: string, max: number): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 99; n++) {
    const suf = sep + n;
    const c = (base.length + suf.length > max ? base.slice(0, max - suf.length) : base) + suf;
    if (!taken.has(c)) return c;
  }
  return base + sep + "x";
}

async function readWorkflowRows() {
  return await withDb(async (c) => {
    const r = await c.queryObject<any>(
      "select key,label,tags,ghl_id,sort from sms_analytics.workflows order by sort, key");
    return r.rows || [];
  });
}

// Lista los workflows de GHL marcando cuáles ya se están midiendo, y para los que
// no, el tag exacto que habría que ponerles. El match es por id; el nombre solo se
// usa para las 3 secuencias viejas, que se dieron de alta antes de guardar el id.
async function ghlWorkflows(cfg: Record<string, string>) {
  const d = await gget(BASE + "/workflows/?locationId=" + cfg.ghl_location, cfg.ghl_api_key);
  const list = d?.workflows ?? [];
  if (!list.length) return { error: "GHL no devolvió workflows (¿token o location?)" };

  const rows = await readWorkflowRows();
  const byId: Record<string, any> = {};
  const byLabel: Record<string, any> = {};
  const takenTags = new Set<string>();
  for (const r of rows) {
    if (r.ghl_id) byId[r.ghl_id] = r;
    byLabel[deaccent(r.label).replace(/[^a-z0-9]+/g, "")] = r;
    for (const t of splitTags(r.tags)) takenTags.add(t);
  }

  const out = list.map((w: any) => {
    const hit = byId[w.id] || byLabel[deaccent(w.name).replace(/[^a-z0-9]+/g, "")] || null;
    const slug = tagFromName(w.name);
    return {
      id: w.id,
      name: w.name,
      status: w.status || "",
      updatedAt: w.updatedAt || w.createdAt || null,
      tracked: !!hit,
      key: hit ? hit.key : null,
      tag: hit ? (splitTags(hit.tags)[0] || null)
               : (slug ? uniqueOf(TAG_PREFIX + slug, takenTags, " ", TAG_MAX) : null),
      branchTags: BRANCH_TAGS,
    };
  }).sort((a: any, b: any) =>
    (b.tracked ? 1 : 0) - (a.tracked ? 1 : 0) ||
    (a.status === "published" ? 0 : 1) - (b.status === "published" ? 0 : 1) ||
    String(a.name).localeCompare(String(b.name)));

  return { workflows: out, branchTags: BRANCH_TAGS };
}

// Da de alta la secuencia. Devuelve SIEMPRE el tag que quedó guardado (no el
// sugerido): si otro alta se metió en el medio, la instrucción que ve el usuario
// es la que de verdad va a clasificar.
async function workflowAdd(cfg: Record<string, string>, body: any) {
  const id = String(body?.id || "").trim();
  const name = String(body?.name || "").trim();
  if (!id || !name) return { error: "falta el workflow (id y name)" };

  const rows = await readWorkflowRows();
  const existing = rows.find((r: any) => r.ghl_id === id);
  if (existing) {
    return { already: true, key: existing.key, label: existing.label,
      tag: splitTags(existing.tags)[0] || "", branchTags: BRANCH_TAGS };
  }

  const takenKeys = new Set<string>(rows.map((r: any) => r.key));
  const takenTags = new Set<string>();
  for (const r of rows) for (const t of splitTags(r.tags)) takenTags.add(t);

  const baseKey = keyFromName(name);
  const baseTag = tagFromName(name);
  if (!baseKey || !baseTag) return { error: "el nombre del workflow no deja armar un identificador — renombralo en GHL" };
  const key = uniqueOf(baseKey, takenKeys, "_", 24);
  const tag = uniqueOf(TAG_PREFIX + baseTag, takenTags, " ", TAG_MAX);
  if (!keyOk(key)) return { error: "no se pudo derivar una key válida de \"" + name + "\"" };

  await withDb(async (c) => {
    await c.queryArray(
      `insert into sms_analytics.workflows(key,label,keywords,tags,ghl_id,sort)
       values ($1,$2,'',$3,$4,(select coalesce(max(sort),100)+10 from sms_analytics.workflows))`,
      [key, name, tag, id]);
  });
  BOOT = null; // que el próximo request relea WF con la secuencia nueva adentro
  return { key, label: name, tag, branchTags: BRANCH_TAGS };
}

// Deja de medirla. No borra nada de cohort/msg_events: si se vuelve a dar de alta
// el mismo workflow, el histórico ya medido reaparece tal cual.
async function workflowRemove(body: any) {
  const key = String(body?.key || "").trim();
  if (!key) return { error: "falta la key" };
  const n = await withDb(async (c) => {
    const r = await c.queryObject<any>(
      "delete from sms_analytics.workflows where key=$1 returning key", [key]);
    return (r.rows || []).length;
  });
  BOOT = null;
  return n ? { ok: true, key } : { error: "no existe la secuencia " + key };
}

async function personaSave(body: any) {
  const key = String(body?.key || "").trim().toLowerCase();
  const label = String(body?.label || "").trim();
  if (!keyOk(key)) return { error: "key inválida (a-z, 0-9, _ y -, 2-24 caracteres)" };
  if (!label) return { error: "falta el label" };
  const pipes: any[] = Array.isArray(body?.pipelines) ? body.pipelines.slice(0, 40) : [];
  const headline = body?.headline ? String(body.headline).slice(0, 120) : null;
  const minSample = Math.min(Math.max(parseInt(body?.minSample) || 15, 1), 500);
  const sort = Math.min(Math.max(parseInt(body?.sort) || 100, 0), 9999);

  return await withDb(async (c) => {
    await c.queryArray(
      `insert into sms_analytics.persona_config(key,label,headline,sort,min_sample)
       values ($1,$2,$3,$4,$5)
       on conflict (key) do update set label=excluded.label, headline=excluded.headline,
         sort=excluded.sort, min_sample=excluded.min_sample, updated_at=now()`,
      [key, label, headline, sort, minSample]);
    await c.queryArray(`insert into sms_analytics.persona_run(persona_key,phase) values ($1,'idle')
                        on conflict (persona_key) do nothing`, [key]);
    // Reemplazo completo: la UI manda la lista entera, no un delta.
    await c.queryArray(`delete from sms_analytics.persona_pipeline where persona_key=$1`, [key]);
    for (const p of pipes) {
      const pid = String(p?.id || "").trim();
      if (!pid) continue;
      await c.queryArray(
        `insert into sms_analytics.persona_pipeline(persona_key,pipeline_id,pipeline_name)
         values ($1,$2,$3) on conflict do nothing`,
        [key, pid, p?.name ? String(p.name).slice(0, 120) : null]);
    }
    return { ok: true, key, label, pipelines: pipes.length };
  });
}

async function personaStatus(key: string) {
  return await withDb(async (c) => {
    const r = await c.queryObject<any>(
      `select
         (select phase from sms_analytics.persona_run where persona_key=$1) as phase,
         (select note  from sms_analytics.persona_run where persona_key=$1) as note,
         (select count(*)::bigint from sms_analytics.persona_won_opp o
            join sms_analytics.persona_pipeline p on p.pipeline_id=o.pipeline_id and p.persona_key=$1) as opps,
         (select count(*)::bigint from sms_analytics.persona_won_opp o
            join sms_analytics.persona_pipeline p on p.pipeline_id=o.pipeline_id and p.persona_key=$1
            where o.expanded) as expanded,
         (select count(*)::bigint from sms_analytics.persona_won_opp o
            join sms_analytics.persona_pipeline p on p.pipeline_id=o.pipeline_id and p.persona_key=$1
            where o.expanded and o.n_calls = 0) as no_calls`, [key]);
    const t = await c.queryObject<any>(
      `select
         count(*) filter (where t.status='queued')::bigint   as queued,
         count(*) filter (where t.status='done')::bigint     as done,
         count(*) filter (where t.status='no_audio')::bigint as no_audio,
         count(*) filter (where t.status='failed')::bigint   as failed,
         count(*) filter (where t.status='short')::bigint    as short,
         count(*) filter (where t.status='running')::bigint  as running,
         count(*) filter (where t.lang like 'es%')::bigint   as es
       from sms_analytics.call_transcript t
       join sms_analytics.persona_pipeline p on p.pipeline_id = t.pipeline_id
      where p.persona_key = $1`, [key]);
    // El extract vive en la oportunidad desde que la unidad pasó a ser el
    // comprador; contarlo sobre call_transcript daba 0 siempre.
    const ex = await c.queryObject<any>(
      `select count(*) filter (where o.extract is not null)::bigint as extracted
         from sms_analytics.persona_won_opp o
         join sms_analytics.persona_pipeline p on p.pipeline_id = o.pipeline_id
        where p.persona_key = $1`, [key]);
    const d = await c.queryObject<any>(
      `select n_calls, created_at from sms_analytics.persona_doc where persona_key=$1 and is_current`, [key]);
    const a = r.rows[0] || {}; const b = t.rows[0] || {};
    return {
      key, phase: a.phase || "idle", note: a.note || null,
      opps: nInt(a.opps), expanded: nInt(a.expanded), noCalls: nInt(a.no_calls),
      queued: nInt(b.queued), running: nInt(b.running), done: nInt(b.done), noAudio: nInt(b.no_audio),
      failed: nInt(b.failed), short: nInt(b.short), extracted: nInt(ex.rows[0]?.extracted), spanish: nInt(b.es),
      doc: d.rows[0] ? { nCalls: d.rows[0].n_calls, at: d.rows[0].created_at } : null,
    };
  });
}

async function personaData(key: string) {
  return await withDb(async (c) => {
    const cf = await c.queryObject<any>(
      `select key,label,headline,min_sample from sms_analytics.persona_config where key=$1`, [key]);
    if (!cf.rows[0]) return { error: "persona '" + key + "' no existe" };
    const d = await c.queryObject<any>(
      `select doc, n_calls, n_opps, pipelines, model, created_at
         from sms_analytics.persona_doc where persona_key=$1 and is_current`, [key]);
    const cfg = cf.rows[0];
    if (!d.rows[0]) return { key, label: cfg.label, minSample: cfg.min_sample, doc: null, pending: true };
    const r = d.rows[0];
    return { key, label: cfg.label, minSample: cfg.min_sample, doc: r.doc,
      nCalls: r.n_calls, nOpps: r.n_opps, pipelines: r.pipelines, model: r.model, at: r.created_at };
  });
}

// ---- TRANSCRIBE: audio de GHL -> Deepgram -> texto ---------------------------
// Acotado por tiempo y drenable en tandas, como work(). Dos diferencias que
// importan: la concurrencia es 3 (no 14) porque acá el cuello es la MEMORIA —una
// llamada de 20 min son ~19 MB en RAM— y no el rate limit; y cada fila que sale
// de 'queued' ya no vuelve nunca, que es lo que hace que esto no se pueda usar
// para quemar la cuota de Deepgram.
type TrOut = { status: string; err?: string; words?: number; lang?: string | null; bytes?: number; text?: string; durationS?: number };

// Las llamadas de los AI setters ya vienen transcriptas de Retell: gratis,
// instantáneo y más fiel que re-transcribir el audio. No pasan por Deepgram.
async function transcribeRetell(cfg: Record<string, string>, row: any): Promise<TrOut> {
  const rkey = (cfg.retell_api_key || "").trim();
  if (!rkey) return { status: "failed", err: "falta retell_api_key en sms_analytics.config" };
  let r: Response;
  try {
    r = await fetchT("https://api.retellai.com/v2/get-call/" + row.ext_id, {
      headers: { Authorization: "Bearer " + rkey },
    }, 30000);
  } catch (e) { return { status: "retry", err: "retell fetch: " + String(e) }; }
  if (r.status === 404) return { status: "no_audio", err: "retell 404 (llamada fuera de retención)" };
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    return { status: r.status >= 400 && r.status < 500 ? "failed" : "retry", err: "retell " + r.status + ": " + body };
  }
  const j = await r.json();
  const text = String(j?.transcript || "").trim();
  const durationS = Math.round((Number(j?.duration_ms) || 0) / 1000) || undefined;
  const words = text ? text.split(/\s+/).length : 0;
  if (words < MIN_TRANSCRIPT_WORDS)
    return { status: "short", err: words + " palabras", words, text, durationS };
  return { status: "done", words, lang: j?.call_analysis?.detected_language || null, text, durationS };
}

async function transcribeOne(cfg: Record<string, string>, row: any): Promise<TrOut> {
  if (row.source === "retell") return await transcribeRetell(cfg, row);
  const loc = cfg.ghl_location, gkey = cfg.ghl_api_key;
  const base = BASE + "/conversations/messages/" + row.message_id + "/locations/" + loc + "/recording";

  // index=1 es la pata del closer en un live transfer. Si no existe (422), la
  // llamada simplemente no fue transferida: se cae al recording por defecto.
  let audio = await gbin(base + "?index=" + row.rec_index, gkey, 3);
  if (!audio.ok) audio = await gbin(base, gkey, 3);
  if (!audio.ok || !audio.bytes || !audio.bytes.byteLength)
    return { status: "no_audio", err: "GHL recording " + audio.status };
  if (audio.bytes.byteLength > MAX_AUDIO_BYTES)
    return { status: "failed", err: "oversize " + audio.bytes.byteLength + "B" };

  const dkey = (cfg.deepgram_api_key || "").trim();
  if (!dkey) return { status: "failed", err: "falta deepgram_api_key en sms_analytics.config" };

  let r: Response;
  try {
    r = await fetchT(DG_URL, {
      method: "POST",
      headers: { Authorization: "Token " + dkey, "Content-Type": "audio/wav" },
      body: audio.bytes,
    });
  } catch (e) { return { status: "retry", err: "deepgram fetch: " + String(e) }; }

  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    // 4xx no se reintenta: loopear un 401 solo quema el presupuesto de tiempo.
    return { status: r.status >= 400 && r.status < 500 ? "failed" : "retry",
             err: "deepgram " + r.status + ": " + body };
  }
  const j = await r.json();
  const ch = j?.results?.channels?.[0];
  const alt = ch?.alternatives?.[0];
  const text = String(alt?.transcript || "").trim();
  // Con language=multi el idioma NO viene en channel.detected_language (queda
  // siempre null): Deepgram lo pone en alternatives[0].languages y, palabra por
  // palabra, en words[].language. Se toma el dominante por cantidad de palabras,
  // que es lo que importa cuando una llamada mezcla inglés y español.
  let lang: string | null = ch?.detected_language || null;
  if (!lang) {
    const tally: Record<string, number> = {};
    for (const w of (alt?.words || [])) {
      const L = String(w?.language || "").slice(0, 5);
      if (L) tally[L] = (tally[L] || 0) + 1;
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    lang = top ? top[0] : (Array.isArray(alt?.languages) ? alt.languages[0] || null : null);
  }
  const words = text ? text.split(/\s+/).length : 0;
  if (words < MIN_TRANSCRIPT_WORDS)
    return { status: "short", err: words + " palabras", words, lang, bytes: audio.bytes.byteLength, text };
  return { status: "done", words, lang, bytes: audio.bytes.byteLength, text };
}

async function personaTranscribe(cfg: Record<string, string>, key: string | null, budgetMs: number, limit: number) {
  const t0 = Date.now();
  const hasDg = !!(cfg.deepgram_api_key || "").trim();

  // Techo diario de minutos: incluso si el scan se abusara, el gasto queda acotado.
  // Solo cuenta lo que pasa por Deepgram — Retell es gratis y no consume cuota.
  const cap = parseInt(cfg.persona_daily_minutes_cap || "") || DEFAULT_DAILY_MINUTES_CAP;
  const usedMin = await withDb(async (c) => {
    const r = await c.queryObject<{ s: number }>(
      `select coalesce(sum(coalesce(duration_s, 600)), 0)::float / 60 as s
         from sms_analytics.call_transcript
        where source = 'ghl' and status in ('done','short') and done_at > now() - interval '24 hours'`);
    return Number(r.rows[0]?.s || 0);
  });
  const dgOpen = hasDg && usedMin < cap;

  let done = 0, failed = 0, noAudio = 0, short = 0, minutes = 0;
  const claimed = new Set<string>();

  // Reserva: una tanda arranca solo si le queda tiempo para TERMINAR. Sin esto
  // podía empezar a 1ms del límite, pagar Deepgram y morir antes de guardar la
  // transcripción — plata gastada y nada que mostrar.
  while (Date.now() - t0 < budgetMs - BATCH_RESERVE_MS) {
    if (limit > 0 && claimed.size >= limit) break;
    const take = limit > 0 ? Math.min(3, limit - claimed.size) : 3;
    const batch = await withDb(async (c) => {
      // El claim SACA la fila de la cola (status='running'). Antes solo subía
      // `attempts` y la dejaba en 'queued' durante la descarga + Deepgram;
      // como withDb no abre transacción, el `for update skip locked` se suelta
      // enseguida y otra invocación reclamaba la MISMA fila y la volvía a pagar.
      // `claimed_at` deja recuperar las que quedaron a medias cuando la función
      // se muere a los 150s.
      const r = await c.queryObject<any>(
        `update sms_analytics.call_transcript
            set attempts = attempts + 1, status = 'running', claimed_at = now()
          where id in (
            select t.id from sms_analytics.call_transcript t
            ${key ? "join sms_analytics.persona_pipeline p on p.pipeline_id = t.pipeline_id and p.persona_key = $2" : ""}
            where ${CLAIMABLE} and t.attempts < 3
              ${dgOpen ? "" : "and t.source <> 'ghl'"}
            order by t.attempts, t.id limit $1 for update skip locked)
          returning id, message_id, rec_index, duration_s, attempts, source, ext_id`,
        key ? [take, key] : [take]);
      return r.rows;
    });
    if (!batch.length) break;
    for (const b of batch) claimed.add(String(b.id));

    // La concurrencia sale del peso del lote: cada audio se sostiene entero en
    // memoria mientras se manda a Deepgram, así que tres de 63 MB a la vez
    // tumbarían la invocación. Los de Retell no pesan nada (son JSON).
    const maxBytes = Math.max(...batch.map((r: any) =>
      r.source === "retell" ? 0 : (r.duration_s ?? DUR_UNKNOWN_S) * BYTES_PER_SEC));
    const conc = maxBytes > 40e6 ? 1 : maxBytes > 20e6 ? 2 : 3;
    const out = await pool(batch, conc, async (row: any) => ({ row, res: await transcribeOne(cfg, row) }));

    await withDb(async (c) => {
      for (const o of out) {
        if (!o) continue;
        const { row, res } = o;
        if (res.status === "retry") {
          // Se queda en 'queued'; el attempts++ ya se aplicó al reclamarla.
          const dead = (row.attempts || 0) >= 3;
          await c.queryArray(
            `update sms_analytics.call_transcript set status=$2, err=$3 where id=$1`,
            [row.id, dead ? "failed" : "queued", res.err || null]);
          if (dead) failed++;
          continue;
        }
        await c.queryArray(
          `update sms_analytics.call_transcript
              set status=$2, err=$3, words=$4, lang=$5, bytes=$6, transcript=$7,
                  duration_s=coalesce($8, duration_s), done_at=now()
            where id=$1`,
          [row.id, res.status, res.err || null, res.words ?? null, res.lang ?? null,
           res.bytes ?? null, res.text ?? null, res.durationS ?? null]);
        if (res.status === "done") { done++; if (row.source === "ghl") minutes += (row.duration_s || 0) / 60; }
        else if (res.status === "short") short++;
        else if (res.status === "no_audio") noAudio++;
        else failed++;
      }
    });
  }

  // `remaining` tiene que contar EXACTAMENTE lo que el claim puede reclamar. Si
  // no, el drenado del dashboard no termina nunca: sin deepgram_api_key el claim
  // excluye las filas 'ghl' pero el conteo las seguía sumando, así que devolvía
  // el mismo número para siempre y la UI reintentaba cada 600ms sin avanzar.
  // Lo que queda fuera se informa aparte, en `blocked`, para poder decirlo.
  const counts = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint; b: bigint }>(
      `select
         count(*) filter (where ${CLAIMABLE} and t.attempts < 3 ${dgOpen ? "" : "and t.source <> 'ghl'"})::bigint as n,
         count(*) filter (where ${CLAIMABLE} and t.attempts < 3 ${dgOpen ? "and false" : "and t.source = 'ghl'"})::bigint as b
       from sms_analytics.call_transcript t
       ${key ? "join sms_analytics.persona_pipeline p on p.pipeline_id = t.pipeline_id and p.persona_key = $1" : ""}`,
      key ? [key] : []);
    return { remaining: Number(r.rows[0].n), blocked: Number(r.rows[0].b) };
  });
  const remaining = counts.remaining;
  const why = dgOpen ? null
    : (hasDg ? "tope diario alcanzado (" + Math.round(usedMin) + "/" + cap + " min)"
             : "falta deepgram_api_key en sms_analytics.config");
  if (key) await setPhase(key, remaining ? "transcribing" : "extracting",
    remaining ? remaining + " llamadas en cola" : (counts.blocked ? counts.blocked + " llamadas sin transcribir: " + why : null));

  return { key, done, failed, noAudio, short, remaining,
    blocked: counts.blocked, blockedWhy: counts.blocked ? why : null,
    minutes: Math.round(minutes * 10) / 10, dailyMinutesUsed: Math.round(usedMin),
    deepgram: dgOpen ? "on" : why,
    elapsedMs: Date.now() - t0 };
}

// ---- SCAN: WONs de los pipelines configurados -> una llamada encolada c/u ----
//
// Fase 1: un barrido `status=all` por pipeline (mismo patrón que markwon()) y se
// clasifica EN CÓDIGO. La señal primaria de "ganado" es `status === 'won'`: es el
// hecho de negocio, no la posición de una tarjeta — un won parado en "Contract
// Sent" sigue siendo un comprador y su llamada sigue siendo evidencia (eso explica
// el 70 vs 61 de RISE). Además no exige que exista un stage llamado "Won", así que
// un buyer futuro cuyo stage se llame "Funded" entra sin tocar código. Igual se
// guarda `won_src` con las dos señales, para poder ampliar después sin re-scanear.
//
// Fase 2: expandir contacto -> conversaciones -> mensajes. Son 2-4 requests a GHL
// por deal, así que es la parte que se pasa de los 150s: se drena bajo deadline y
// se retoma en la corrida siguiente (`expanded`, igual que `cohort.done`).
async function personaScan(cfg: Record<string, string>, key: string, budgetMs: number, dry: boolean) {
  const t0 = Date.now();
  const deadline = t0 + Math.min(budgetMs, 115000);
  const gkey = cfg.ghl_api_key, loc = cfg.ghl_location;

  const pipes = await withDb(async (c) => {
    const r = await c.queryObject<{ pipeline_id: string; pipeline_name: string | null }>(
      `select pipeline_id, pipeline_name from sms_analytics.persona_pipeline where persona_key=$1`, [key]);
    return r.rows;
  });
  if (!pipes.length) return { error: "la persona '" + key + "' no tiene pipelines configurados" };

  if (!dry) await setPhase(key, "scanning");

  // Stage "Won" real de cada pipeline, para poder reportar la segunda señal.
  const pdata = await gget(BASE + "/opportunities/pipelines?locationId=" + loc, gkey);
  const wonStage: Record<string, string | null> = {};
  const pname: Record<string, string> = {};
  for (const p of (pdata?.pipelines ?? [])) {
    wonStage[p.id] = (p.stages || []).find((s: any) => /^won$|ganad/i.test((s.name || "").trim()))?.id || null;
    pname[p.id] = p.name || "";
  }

  // ---- fase 1 ----
  type Row = { opportunity_id: string; pipeline_id: string; contact_id: string | null;
               won_src: string; stage_id: string | null; won_at: string | null };
  const found: Row[] = [];
  const perPipe: Record<string, { name: string; total: number; byStatus: number; byStage: number }> = {};

  await pool(pipes, 6, async (p) => {
    const pid = p.pipeline_id;
    perPipe[pid] = { name: pname[pid] || p.pipeline_name || pid, total: 0, byStatus: 0, byStage: 0 };
    let url: string | undefined = BASE + "/opportunities/search?location_id=" + loc + "&pipeline_id=" + pid +
      "&status=all&limit=100&order=added_desc";
    let pg = 0;
    while (url && pg < 200 && Date.now() < deadline) {
      const d = await gget(url, gkey); if (!d) break;
      const ops = d.opportunities ?? []; if (!ops.length) break;
      perPipe[pid].total += ops.length;
      for (const o of ops) {
        const byStatus = o.status === "won";
        const byStage = !!wonStage[pid] && o.pipelineStageId === wonStage[pid];
        if (byStatus) perPipe[pid].byStatus++;
        if (byStage) perPipe[pid].byStage++;
        if (!byStatus && !byStage) continue;
        found.push({
          opportunity_id: o.id, pipeline_id: pid, contact_id: o.contactId || null,
          won_src: byStatus && byStage ? "both" : byStatus ? "status" : "stage",
          stage_id: o.pipelineStageId || null,
          won_at: o.lastStatusChangeAt || o.updatedAt || o.createdAt || null,
        });
      }
      url = d.meta?.nextPageUrl; pg++;
    }
  });

  if (dry) {
    return { dry: true, key, pipelines: perPipe,
      won: found.length,
      wonByStatus: found.filter((f) => f.won_src !== "stage").length,
      wonByStage: found.filter((f) => f.won_src !== "status").length,
      withContact: found.filter((f) => f.contact_id).length,
      elapsedMs: Date.now() - t0 };
  }

  await withDb(async (c) => {
    for (let i = 0; i < found.length; i += 200) {
      const chunk = found.slice(i, i + 200);
      const vals = chunk.map((_, j) => {
        const b = j * 6;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::timestamptz)`;
      }).join(",");
      const args = chunk.flatMap((f) => [f.opportunity_id, f.pipeline_id, f.contact_id, f.won_src, f.stage_id, f.won_at]);
      await c.queryArray(
        `insert into sms_analytics.persona_won_opp(opportunity_id,pipeline_id,contact_id,won_src,stage_id,won_at)
         values ${vals}
         on conflict (opportunity_id) do update set won_src=excluded.won_src, stage_id=excluded.stage_id,
           contact_id=coalesce(excluded.contact_id, sms_analytics.persona_won_opp.contact_id), seen_at=now()`, args);
    }
    for (const pid of Object.keys(wonStage)) {
      if (wonStage[pid]) await c.queryArray(
        `update sms_analytics.persona_pipeline set won_stage_id=$2, pipeline_name=coalesce($3, pipeline_name)
          where pipeline_id=$1`, [pid, wonStage[pid], pname[pid] || null]);
    }
  });

  // ---- fase 2: expandir a llamadas ----
  let expanded = 0, withCalls = 0, noCalls = 0, queued = 0, alreadyQueued = 0;
  while (Date.now() < deadline) {
    const batch = await withDb(async (c) => {
      const r = await c.queryObject<any>(
        `update sms_analytics.persona_won_opp set attempts = attempts + 1
          where opportunity_id in (
            select o.opportunity_id from sms_analytics.persona_won_opp o
            join sms_analytics.persona_pipeline p on p.pipeline_id = o.pipeline_id and p.persona_key = $1
            where not o.expanded and o.attempts < 3 and o.contact_id is not null
            order by o.attempts, o.opportunity_id limit 20 for update skip locked)
          returning opportunity_id, pipeline_id, contact_id`, [key]);
      return r.rows;
    });
    if (!batch.length) break;

    const results = await pool(batch, 6, async (o: any) => {
      const cd = await gget(BASE + "/conversations/search?locationId=" + loc + "&contactId=" + o.contact_id, gkey);
      const convs = cd?.conversations ?? [];
      const ghlCalls: any[] = [];    // TYPE_CALL: grabación en GHL -> Deepgram (cuesta)
      const retellCalls: any[] = []; // TYPE_CUSTOM_CALL de Retell: transcripción nativa (gratis)
      for (const cv of convs.slice(0, 3)) {
        const md = await gget(BASE + "/conversations/" + cv.id + "/messages?limit=100", gkey);
        for (const m of (md?.messages?.messages ?? [])) {
          if (m.status !== "completed") continue; // deja fuera los voicemails del setter
          if (m.messageType === "TYPE_CALL")
            ghlCalls.push({ id: m.id, conv: cv.id, dur: m.meta?.call?.duration ?? null,
                            at: m.dateAdded || null, source: "ghl", ext: null });
          else if (m.messageType === "TYPE_CUSTOM_CALL" && /^call_/.test(String(m.altId || "")))
            retellCalls.push({ id: m.id, conv: cv.id, dur: null,
                               at: m.dateAdded || null, source: "retell", ext: m.altId });
        }
      }
      // De las de GHL se encola SOLO la más larga, porque cada una cuesta un
      // Deepgram. `duration` null NO es 0: GHL lo deja vacío justamente en las
      // llamadas largas y transferidas, que son las que más nos interesan.
      ghlCalls.sort((a, b) => {
        const da = a.dur == null ? Number.POSITIVE_INFINITY : a.dur;
        const db = b.dur == null ? Number.POSITIVE_INFINITY : b.dur;
        if (db !== da) return db - da;
        return String(b.at || "").localeCompare(String(a.at || ""));
      });
      // Las de Retell son gratis, así que van todas: no hay que adivinar cuál es
      // la buena y juntas describen mejor a la misma persona.
      const picks = [...(ghlCalls[0] ? [ghlCalls[0]] : []), ...retellCalls.slice(0, 25)];
      return { o, picks };
    });

    await withDb(async (c) => {
      for (const r of results) {
        if (!r) continue;
        for (const p of r.picks) {
          const ins = await c.queryObject<{ id: bigint }>(
            `insert into sms_analytics.call_transcript
               (pipeline_id,opportunity_id,contact_id,conversation_id,message_id,rec_index,call_at,duration_s,source,ext_id)
             values ($1,$2,$3,$4,$5,1,$6::timestamptz,$7,$8,$9)
             on conflict (message_id, rec_index) do nothing
             returning id`,
            [r.o.pipeline_id, r.o.opportunity_id, r.o.contact_id, p.conv, p.id, p.at, p.dur, p.source, p.ext]);
          if (ins.rows.length) queued++; else alreadyQueued++;
        }
        if (r.picks.length) withCalls++; else noCalls++;
        await c.queryArray(
          `update sms_analytics.persona_won_opp set expanded=true, n_calls=$2 where opportunity_id=$1`,
          [r.o.opportunity_id, r.picks.length]);
        expanded++;
      }
    });
  }

  const remaining = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint }>(
      `select count(*)::bigint as n from sms_analytics.persona_won_opp o
         join sms_analytics.persona_pipeline p on p.pipeline_id=o.pipeline_id and p.persona_key=$1
        where not o.expanded and o.attempts < 3`, [key]);
    return Number(r.rows[0].n);
  });
  await setPhase(key, remaining ? "scanning" : "transcribing",
    remaining ? "quedan " + remaining + " oportunidades por expandir" : null);

  return { key, pipelines: perPipe, won: found.length,
    wonByStatus: found.filter((f) => f.won_src !== "stage").length,
    wonByStage: found.filter((f) => f.won_src !== "status").length,
    expanded, withCalls, noCalls, queued, alreadyQueued, remaining, elapsedMs: Date.now() - t0 };
}

// ---- EXTRACT (etapa A): una ficha por COMPRADOR, no por audio ----------------
// La unidad de una buyer persona es la persona, no la llamada: un contacto puede
// tener varias llamadas y todas juntas describen a uno solo. Por eso el extract
// vive en `persona_won_opp` y se arma concatenando TODAS las transcripciones de
// ese contacto. Queda cacheado, así que un rebuild posterior no vuelve a pagarlo.
//
// La regla dura del prompt es `null` cuando el dato no se dijo: un campo vacío es
// señal, uno inventado envenena la persona entera. Y el esquema no tiene campo
// para nombre de persona ni de empresa — el anonimato es estructural, no un pedido.
// Vocabularios FIJOS. Sin esto el modelo devuelve texto libre y el conteo se
// pulveriza: "construction", "general contracting" y "commercial site work/
// construction" cuentan como tres industrias distintas, y la persona concluye
// "ninguna industria domina" — que es un artefacto, no un hallazgo. Lo mismo
// pasaba con drivers ("reduce weekly payment burden" vs "lower weekly payment"
// vs "reduce weekly payments" = tres cosas). Las categorías salen del documento
// que un humano escribió sobre esta misma población, así que están validadas.
const EX_INDUSTRY = ["trades_contractors", "transport_auto", "food_retail", "health_services", "other"];
const EX_DRIVERS = ["relief_now", "legal_protection", "get_unstuck_credit", "fairness", "avoid_bankruptcy", "keep_business_alive", "other"];
const EX_OBJECTIONS = ["prior_broker_burn", "harassment_or_lawsuits", "upfront_fee", "credit_impact", "needs_to_think_or_consult", "lender_relationship", "needs_future_capital", "other"];
const EX_TRIGGERS = ["unpayable_debit", "ucc_lien", "lawsuit", "prior_broker_burn", "cash_flow_crisis", "revenue_loss", "stacking_spiral", "other"];

const EXTRACT_SCHEMA = '{"industry":"free-text label or null","industry_group":"one of ' + EX_INDUSTRY.join("|") + '",'
  + '"years_in_business":null,"debt_total_usd":null,"n_positions":null,"payment_amount_usd":null,'
  + '"payment_cadence":"weekly|daily|monthly|null","lenders":[],"language":"en|es|null",'
  + '"geo_state":"2-letter US state or null","origin":"defensive|growth|null",'
  + '"trigger":"one of ' + EX_TRIGGERS.join("|") + ' or null",'
  + '"objections":["from: ' + EX_OBJECTIONS.join("|") + '"],'
  + '"drivers":["from: ' + EX_DRIVERS.join("|") + '"],'
  + '"wants_to_pay":"true|false|null","verbatims":[],"confidence":0.0}';

async function extractOne(akey: string, text: string): Promise<any | null> {
  const sys = [
    "You read ONE prospect's sales call transcript(s) and return a single structured JSON card about the BUSINESS OWNER (the 'User' side), for aggregation into an anonymous buyer persona.",
    "HARD RULES:",
    "- Use null (or an empty array) whenever the transcript does not state something. NEVER infer, guess, or fill from general knowledge. A missing field is useful signal; a fabricated one is poison.",
    "- NEVER output a person's name, business name, phone number, email or street address. There is no field for them. `lenders` holds only lender/creditor BRAND names (OnDeck, Rapid, Forward, a bank or card issuer) — never the merchant's own name.",
    "- `verbatims`: at most 5, at most 12 words each, quoted from the OWNER only, and only if they contain nothing identifying.",
    "- CONTROLLED VOCABULARIES — these fields accept ONLY the listed values, verbatim. Never invent a new label, never rephrase one. If nothing fits, use 'other' (or omit, for the list fields).",
    "  · industry_group: " + EX_INDUSTRY.join(" | ") + ". Map the business to its family: construction, electrical, plumbing, HVAC, flooring, painting, landscaping, cleaning, roofing and any contracting trade -> trades_contractors. Trucking, logistics, auto repair, auto parts -> transport_auto. Restaurants, bars, cafes, retail stores, dry cleaners, salons -> food_retail. Clinics, chiropractic, behavioral health, childcare, education, funeral homes, professional services -> health_services.",
    "  · drivers (max 3, most important first): " + EX_DRIVERS.join(" | ") + ".",
    "  · objections (max 3): " + EX_OBJECTIONS.join(" | ") + ".",
    "  · trigger (exactly one, or null): " + EX_TRIGGERS.join(" | ") + ".",
    "- Keep `industry` as the free-text description too (e.g. 'commercial flooring installation'), but `industry_group` MUST be one of the five values.",
    "- `wants_to_pay` is a BOOLEAN and nothing else. true ONLY if the owner explicitly says they intend to honour the debt ('I'm not running from it', 'I want to pay what I owe'). false if they say they want out, to walk away, or to stop paying. null if they never address it — which is the COMMON case. Do not infer willingness from mere cooperation on the call.",
    "- Respect every field's type. A dollar amount NEVER goes in wants_to_pay; a number never goes in a text field. If you are unsure of the type, use null.",
    "- Amounts in plain USD numbers, no symbols or text ('$4.2k/week' -> payment_amount_usd 4200, payment_cadence 'weekly').",
    "- `confidence` 0-1: how legible and substantive the transcript is. A mostly-empty or garbled call gets a low value.",
    "Respond with ONLY valid JSON matching the schema. No markdown fences, no prose.",
  ].join("\n");
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // max_tokens acota thinking + salida juntos; la ficha son ~300 tokens, 4000 deja aire.
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 4000, system: sys,
        messages: [{ role: "user", content: "TRANSCRIPT(S):\n" + text.slice(0, 220000) + "\n\nReturn ONLY JSON in this shape:\n" + EXTRACT_SCHEMA }] }),
    });
  } catch (_) { return null; }
  if (!r.ok) return null;
  const j = await r.json();
  const out = (j.content || []).map((b: any) => b.text || "").join("").trim();
  try { return JSON.parse(out.replace(/^```(json)?\s*/i, "").replace(/\s*```$/i, "").trim()); } catch (_) { return null; }
}

async function personaExtract(cfg: Record<string, string>, key: string, budgetMs: number, limit: number) {
  const t0 = Date.now();
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Falta 'anthropic_api_key' en sms_analytics.config." };
  let done = 0, empty = 0, failed = 0;

  while (Date.now() - t0 < budgetMs) {
    if (limit > 0 && done + empty + failed >= limit) break;
    // El intento se cobra AL RECLAMAR, no al terminar. Antes, si extractOne
    // devolvía null no se persistía nada: la misma fila volvía a salir en el
    // `limit 4` siguiente y el drenado del dashboard la reintentaba cada 600ms,
    // pagando Anthropic cada vez, sin fin.
    const batch = await withDb(async (c) => {
      const r = await c.queryObject<any>(
        `with claimed as (
           update sms_analytics.persona_won_opp o
              set extract_attempts = o.extract_attempts + 1
            where o.opportunity_id in (
              select o2.opportunity_id
                from sms_analytics.persona_won_opp o2
                join sms_analytics.persona_pipeline p on p.pipeline_id = o2.pipeline_id and p.persona_key = $1
                join sms_analytics.call_transcript t on t.opportunity_id = o2.opportunity_id
               where o2.extract is null and o2.extract_attempts < 3
                 and t.status = 'done' and t.transcript is not null
               group by o2.opportunity_id
               limit 4)
            returning o.opportunity_id)
         select c.opportunity_id,
                string_agg(t.transcript, E'\n\n---\n\n' order by t.call_at) as text
           from claimed c
           join sms_analytics.call_transcript t on t.opportunity_id = c.opportunity_id
          where t.status = 'done' and t.transcript is not null
          group by c.opportunity_id`, [key]);
      return r.rows;
    });
    if (!batch.length) break;

    const out = await pool(batch, 4, async (b: any) => ({ b, ex: await extractOne(akey, b.text) }));
    await withDb(async (c) => {
      for (const o of out) {
        if (!o || !o.ex) { failed++; continue; }
        await c.queryArray(
          `update sms_analytics.persona_won_opp set extract=$2::jsonb, extract_at=now() where opportunity_id=$1`,
          [o.b.opportunity_id, JSON.stringify(o.ex)]);
        done++;
      }
    });
    if (failed >= 8) break; // algo está roto de verdad; no seguir quemando API
  }

  // Mismo criterio que el claim, con el tope de intentos incluido: si no, los
  // que fallan siempre dejarían `remaining` clavado y el drenado no terminaría.
  const remaining = await withDb(async (c) => {
    const r = await c.queryObject<{ n: bigint }>(
      `select count(distinct o.opportunity_id)::bigint as n
         from sms_analytics.persona_won_opp o
         join sms_analytics.persona_pipeline p on p.pipeline_id = o.pipeline_id and p.persona_key = $1
         join sms_analytics.call_transcript t on t.opportunity_id = o.opportunity_id
        where o.extract is null and o.extract_attempts < 3 and t.status = 'done'`, [key]);
    return Number(r.rows[0].n);
  });
  await setPhase(key, remaining ? "extracting" : "generating",
    remaining ? remaining + " compradores por leer" : null);
  void empty;
  return { key, done, failed, remaining, elapsedMs: Date.now() - t0 };
}

// ---- AGREGACIÓN: los números los calcula el código, nunca el modelo -----------
// Esta es la línea que separa "una persona con datos" de "una IA que suena
// convincente". El modelo recibe la tabla ya calculada y solo escribe la prosa.
function med(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function pct(n: number, d: number): number { return d ? Math.round(1000 * n / d) / 10 : 0; }
function tally(rows: any[], field: string, max = 8): { k: string; n: number }[] {
  const m: Record<string, number> = {};
  for (const r of rows) for (const v of (Array.isArray(r?.[field]) ? r[field] : [])) {
    const k = String(v || "").trim().toLowerCase(); if (k) m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, max);
}

function personaAggregate(extracts: any[]) {
  const N = extracts.length;
  const num = (f: string) => extracts.map((e) => Number(e?.[f])).filter((v) => Number.isFinite(v) && v > 0);
  const debts = num("debt_total_usd"), pays = num("payment_amount_usd"), pos = num("n_positions"), yrs = num("years_in_business");
  const es = extracts.filter((e) => String(e?.language || "").toLowerCase().startsWith("es")).length;
  const wantsPay = extracts.filter((e) => e?.wants_to_pay === true).length;
  const wantsPayStated = extracts.filter((e) => e?.wants_to_pay === true || e?.wants_to_pay === false).length;
  const states = tally(extracts.map((e) => ({ s: e?.geo_state ? [e.geo_state] : [] })), "s", 8);
  return {
    n: N,
    industries: tally(extracts.map((e) => ({ i: e?.industry_group ? [e.industry_group] : [] })), "i"),
    states,
    debt: { median: med(debts), min: debts.length ? Math.min(...debts) : null,
            max: debts.length ? Math.max(...debts) : null, stated: debts.length },
    payment: { median: med(pays), stated: pays.length,
               cadence: tally(extracts.map((e) => ({ c: e?.payment_cadence ? [e.payment_cadence] : [] })), "c", 4) },
    positions: { median: med(pos), stated: pos.length,
                 twoPlus: pos.filter((v) => v >= 2).length },
    years: { median: med(yrs), stated: yrs.length },
    language: { spanish: es, share: pct(es, N) },
    wantsToPay: { yes: wantsPay, stated: wantsPayStated },
    objections: tally(extracts, "objections"),
    drivers: tally(extracts, "drivers"),
    triggers: tally(extracts.map((e) => ({ t: e?.trigger ? [e.trigger] : [] })), "t"),
    lenders: tally(extracts, "lenders", 10),
    verbatims: [...new Set(extracts.flatMap((e) => Array.isArray(e?.verbatims) ? e.verbatims : [])
      .map((v: any) => String(v || "").trim()).filter((v: string) => v.length > 3 && v.length < 90))].slice(0, 40),
  };
}

// El modelo está atado a copiar los números TAL CUAL aparecen acá, así que se
// formatean con separador de miles antes: si no, escribe "$12500".
function usd(v: number | null): string { return v == null ? "-" : "$" + v.toLocaleString("en-US"); }

// Los vocabularios cerrados son claves de máquina; el modelo copia lo que ve, así
// que si le llega `trades_contractors` lo escribe tal cual y la persona termina
// pareciendo un volcado de base. Se humanizan ANTES de que las vea.
const HUMAN: Record<string, string> = {
  trades_contractors: "trades & contractors", transport_auto: "transport & auto",
  food_retail: "food & retail", health_services: "health & services",
  relief_now: "relief now", keep_business_alive: "keeping the business alive",
  legal_protection: "legal protection", get_unstuck_credit: "unblocking real credit",
  fairness: "fairness", avoid_bankruptcy: "avoiding bankruptcy",
  prior_broker_burn: "burned by a prior broker", harassment_or_lawsuits: "harassment or lawsuits",
  upfront_fee: "paying anything upfront", credit_impact: "impact on their credit",
  needs_to_think_or_consult: "needs to think or consult a partner",
  lender_relationship: "their relationship with the current lender",
  needs_future_capital: "needing capital again later",
  unpayable_debit: "an unpayable debit", ucc_lien: "a UCC lien", lawsuit: "a lawsuit",
  cash_flow_crisis: "a cash-flow crisis", revenue_loss: "lost revenue",
  stacking_spiral: "the stacking spiral", other: "other",
};
function hum(k: string): string { return HUMAN[k] || String(k || "").replace(/_/g, " "); }

function aggMd(a: any): string {
  const L: string[] = [];
  const line = (k: string, v: string) => L.push(k + ": " + v);
  line("N", a.n + " won deals (each = one distinct buyer)");
  if (a.industries.length) line("industry", a.industries.map((x: any) => hum(x.k) + " " + x.n + "/" + a.n + " (" + pct(x.n, a.n) + "%)").join(" · "));
  if (a.states.length) line("states", a.states.map((x: any) => x.k.toUpperCase() + " " + x.n).join(" · "));
  if (a.debt.stated) line("debt_total_usd", "median " + usd(a.debt.median) + ", range " + usd(a.debt.min) + "-" + usd(a.debt.max) + ", stated by " + a.debt.stated + "/" + a.n);
  if (a.payment.stated) line("payment", "median " + usd(a.payment.median) + ", stated by " + a.payment.stated + "/" + a.n
    + (a.payment.cadence.length ? " · cadence " + a.payment.cadence.map((x: any) => x.k + " " + x.n).join("/") : ""));
  if (a.positions.stated) line("positions", "median " + a.positions.median + ", 2+ in " + a.positions.twoPlus + "/" + a.positions.stated + " stated");
  if (a.years.stated) line("years_in_business", "median " + a.years.median + ", stated by " + a.years.stated + "/" + a.n);
  line("language", "spanish " + a.language.spanish + "/" + a.n + " (" + a.language.share + "%)");
  if (a.wantsToPay.stated) line("wants_to_pay", a.wantsToPay.yes + "/" + a.wantsToPay.stated + " stated");
  if (a.triggers.length) line("triggers", a.triggers.map((x: any) => hum(x.k) + " " + x.n + "/" + a.n).join(" · "));
  if (a.objections.length) line("objections", a.objections.map((x: any) => hum(x.k) + " " + x.n + "/" + a.n + " (" + pct(x.n, a.n) + "%)").join(" · "));
  if (a.drivers.length) line("drivers", a.drivers.map((x: any) => hum(x.k) + " " + x.n + "/" + a.n + " (" + pct(x.n, a.n) + "%)").join(" · "));
  if (a.lenders.length) line("lenders_named", a.lenders.map((x: any) => x.k + " " + x.n).join(" · "));
  L.push("verbatims (owner's own words, pooled):");
  for (const v of a.verbatims) L.push('  - "' + v + '"');
  return L.join("\n");
}

// ---- BUILD (etapa B): una sola llamada al modelo, que solo escribe prosa ------
async function personaWrite(akey: string, cfgRow: any, agg: any, srcLabel: string, thin: boolean) {
  const secs = PERSONA_SECTIONS.map((s) => s.id).join(", ");
  const sys = [
    "You write the BUYER PERSONA panel of a sales-intelligence dashboard for a U.S. debt-restructuring firm.",
    "Your input is an AGGREGATE table computed in code from " + agg.n + " closed-won deals, plus the buyers' own pooled verbatims. You did NOT see the raw calls.",
    "BINDING RULE ON NUMBERS: every number you write must appear verbatim in the AGGREGATE block, together with its denominator. If a claim has no number in the block, state it qualitatively with NO number at all. Inventing, rounding or extrapolating a statistic is a failure.",
    "Write for a human reader: never output a snake_case token or a raw field name (industry_group, wants_to_pay, cash_flow_crisis). Use the plain-English wording exactly as it appears in the AGGREGATE block. US state codes go in capitals.",
    "AGGREGATE AND ANONYMOUS: describe the population, never an individual. Never write a person's or business's name. 'One owner in Dallas told us…' is banned; 'most owners describe…' is right.",
    "Mirror the pooled verbatims exactly when you quote them — do not paraphrase or clean them up.",
    thin
      ? "SMALL SAMPLE — this persona rests on only " + agg.n + " deal(s). Do NOT write any percentage, ratio or 'X in Y' phrasing: with this N a percentage is a lie dressed as data. Write 'both deals', 'one of the two', 'the single call that mentioned it'. Prefer 3-5 short concrete lines over padded sections, and leave a section's `lines` EMPTY rather than inventing content. Set confidence to 'low' and use `caveats` to say plainly what cannot yet be known."
      : "Write 3-5 lines per section. Each line opens with a short bold-able label followed by the claim. Use **double asterisks** for emphasis on the key figure or idea, and \"double quotes\" around the buyers' own words.",
    "Sections are FIXED: " + secs + ". Fill exactly these, in this order, no others.",
    "Each section also gets a `copy_signal`: one imperative sentence telling an SMS copywriter what to do with this section. Concrete, not generic.",
    "Respond with ONLY valid JSON. No markdown fences, no prose outside the JSON.",
  ].join("\n");

  const schema = '{"headline":"3-6 word archetype label","confidence":"high|medium|low",'
    + '"caveats":["what this sample cannot tell you yet"],'
    + '"sections":[{"id":"' + PERSONA_SECTION_IDS[0] + '","lines":[{"label":"Short label","text":"The claim, plain text with **emphasis** and \\"quotes\\" allowed."}],"copy_signal":"one imperative sentence"}]}';

  const user = "VERTICAL: " + cfgRow.label + "\nEVIDENCE SOURCE: " + srcLabel
    + "\n\nAGGREGATE (the only numbers you may use):\n" + aggMd(agg)
    + "\n\nReturn ONLY JSON in this exact shape (all " + PERSONA_SECTION_IDS.length + " sections):\n" + schema;

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // max_tokens acota thinking + salida juntos (misma lección que generate()).
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 24000, system: sys, messages: [{ role: "user", content: user }] }),
    });
  } catch (e) { return { error: "Anthropic fetch: " + String(e) }; }
  if (!r.ok) return { error: "Anthropic " + r.status + ": " + (await r.text()).slice(0, 300) };
  const j = await r.json();
  const text = (j.content || []).map((b: any) => b.text || "").join("").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(text.replace(/^```(json)?\s*/i, "").replace(/\s*```$/i, "").trim()); } catch (_) { /* abajo */ }
  if (!parsed) return { error: "el modelo no devolvió JSON válido (stop_reason=" + (j.stop_reason || "?") + ")", raw: text.slice(0, 600) };
  return { parsed, usage: j.usage || null };
}

// Normaliza lo que devolvió el modelo a la forma que renderiza el dashboard.
// Las secciones son fijas: si el modelo inventa una, se descarta; si omite otra,
// aparece vacía. Así el layout nunca depende de lo que se le ocurra escribir.
function normalizePersonaDoc(raw: any, cfgRow: any, agg: any, srcKey: string, srcLabel: string, pipelines: any[], thin: boolean) {
  const byId: Record<string, any> = {};
  for (const s of (Array.isArray(raw?.sections) ? raw.sections : [])) if (s && s.id) byId[String(s.id)] = s;
  const sections = PERSONA_SECTIONS.map((meta) => {
    const s = byId[meta.id] || {};
    const lines = (Array.isArray(s.lines) ? s.lines : []).slice(0, 8).map((l: any) => ({
      label: String(l?.label || "").slice(0, 60),
      text: String(l?.text || "").slice(0, 900),
    })).filter((l: any) => l.text);
    return { id: meta.id, lines, copySignal: String(s.copy_signal || "").slice(0, 300) };
  });
  return {
    version: 1,
    personaKey: cfgRow.key,
    label: cfgRow.label,
    headline: String(raw?.headline || cfgRow.headline || "").slice(0, 80) || null,
    confidence: ["high", "medium", "low"].includes(String(raw?.confidence)) ? raw.confidence : (thin ? "low" : "medium"),
    caveats: (Array.isArray(raw?.caveats) ? raw.caveats : []).slice(0, 5).map((c: any) => String(c).slice(0, 240)),
    thin,
    source: { key: srcKey, label: srcLabel },
    sample: {
      deals: agg.n,
      pipelines: pipelines.map((p) => p.name || p.id),
      spanishShare: agg.language.share,
      debtMedian: agg.debt.median,
      paymentMedian: agg.payment.median,
    },
    sections,
  };
}

// Markdown determinista, con la MISMA forma que el doc escrito a mano, porque
// context() y generate() lo pegan crudo en prompts de Claude y ese formato es
// estructural. Se genera en código: el modelo produce un solo artefacto y no
// puede desincronizar la versión que ve el dashboard de la que ve la IA.
function personaMd(doc: any, at: string): string {
  let md = "# BUYER PERSONA — " + doc.label + (doc.headline ? ' · "' + doc.headline + '"' : "")
    + " (from " + doc.sample.deals + " won deals)\n";
  md += "meta:\n";
  md += "  source: " + doc.sample.deals + " closed-won deals in " + (doc.sample.pipelines || []).join(" + ")
    + " (" + doc.source.label + ")\n";
  md += "  aggregate: true (anonymous, no client names)\n";
  md += "  sample_size: " + doc.sample.deals + " deals\n";
  md += "  confidence: " + doc.confidence + "\n";
  md += "  generated: " + String(at).slice(0, 10) + "\n";
  if (doc.caveats && doc.caveats.length) md += "  caveats: " + doc.caveats.join(" | ") + "\n";
  md += "\n";
  for (const meta of PERSONA_SECTIONS) {
    const s = doc.sections.find((x: any) => x.id === meta.id);
    if (!s || !s.lines.length) continue;
    md += "## persona." + meta.id + " [item: " + meta.title.replace(/&amp;/g, "&").toLowerCase() + "]\ndata:\n";
    for (const l of s.lines) md += "  - " + (l.label ? l.label + ": " : "") + l.text.replace(/\*\*/g, "") + "\n";
    if (s.copySignal) md += "copy_signal: " + s.copySignal + "\n";
    md += "\n";
  }
  return md;
}

async function personaBuild(cfg: Record<string, string>, key: string, force = false) {
  const t0 = Date.now();
  const akey = (cfg.anthropic_api_key || "").trim();
  if (!akey) return { error: "Falta 'anthropic_api_key' en sms_analytics.config." };

  const input = await withDb(async (c) => {
    const cf = await c.queryObject<any>(
      `select key,label,headline,min_sample from sms_analytics.persona_config where key=$1`, [key]);
    const pp = await c.queryObject<any>(
      `select pipeline_id as id, pipeline_name as name from sms_analytics.persona_pipeline where persona_key=$1`, [key]);
    const ex = await c.queryObject<any>(
      `select o.extract from sms_analytics.persona_won_opp o
         join sms_analytics.persona_pipeline p on p.pipeline_id=o.pipeline_id and p.persona_key=$1
        where o.extract is not null`, [key]);
    const src = await c.queryObject<any>(
      `select t.source, count(*)::bigint as n from sms_analytics.call_transcript t
         join sms_analytics.persona_pipeline p on p.pipeline_id=t.pipeline_id and p.persona_key=$1
        where t.status='done' group by t.source order by 2 desc`, [key]);
    const w = await c.queryObject<any>(
      `select coalesce(sum(t.words),0)::bigint as w from sms_analytics.call_transcript t
         join sms_analytics.persona_pipeline p on p.pipeline_id=t.pipeline_id and p.persona_key=$1
        where t.status='done'`, [key]);
    const cur = await c.queryObject<any>(
      `select n_calls from sms_analytics.persona_doc where persona_key=$1 and is_current`, [key]);
    // Cuántas llamadas quedan sin transcribir y por qué, para poder explicarlo.
    const pend = await c.queryObject<any>(
      `select count(*)::bigint as n from sms_analytics.call_transcript t
         join sms_analytics.persona_pipeline p on p.pipeline_id=t.pipeline_id and p.persona_key=$1
        where t.status in ('queued','running')`, [key]);
    const nPend = Number(pend.rows[0]?.n || 0);
    return { cfgRow: cf.rows[0], pipelines: pp.rows, extracts: ex.rows.map((r: any) => r.extract),
             sources: src.rows, words: Number(w.rows[0]?.w || 0),
             current: cur.rows[0] ? { n: Number(cur.rows[0].n_calls) } : null,
             pendingWhy: nPend ? nPend + " llamadas sin transcribir" : null };
  });
  if (!input.cfgRow) return { error: "persona '" + key + "' no existe" };

  // Nunca se escribe un doc vacío: una regeneración fallida no puede borrar una
  // persona que ya funcionaba.
  if (!input.extracts.length) {
    await setPhase(key, "error", "sin compradores leídos todavía");
    return { error: "todavía no hay ningún comprador leído para '" + key + "' — corré scan, transcribe y extract primero" };
  }
  // Y tampoco se pisa un documento bueno con uno hecho sobre muchísima menos
  // evidencia. Pasa de verdad: sin deepgram_api_key, MCA tiene 1 sola llamada
  // leída (la de Retell) contra las 67 del documento vigente — regenerar sin
  // este freno cambiaría una persona de 67 compradores por una de 1.
  if (input.current && input.current.n > 2 && input.extracts.length < input.current.n / 2 && !force) {
    await setPhase(key, "error", "muestra insuficiente frente al doc vigente");
    return { error: "El documento actual de '" + key + "' se apoya en " + input.current.n
      + " compradores y ahora solo hay " + input.extracts.length
      + " leídos, así que no se reemplaza. Falta transcribir el resto"
      + (input.pendingWhy ? " (" + input.pendingWhy + ")" : "")
      + ". Si igual querés generarlo con esta muestra, repetí con &force=1.",
      have: input.extracts.length, current: input.current.n };
  }

  await setPhase(key, "generating");
  const agg = personaAggregate(input.extracts);
  const thin = agg.n < (input.cfgRow.min_sample || 15);
  const topSrc = (input.sources[0]?.source) || "ghl";
  const srcLabel = topSrc === "retell" ? "AI setter calls (Retell)" : "closer calls (GHL dialer)";

  const w = await personaWrite(akey, input.cfgRow, agg, srcLabel, thin);
  if ((w as any).error) { await setPhase(key, "error", (w as any).error); return w; }

  const doc = normalizePersonaDoc((w as any).parsed, input.cfgRow, agg, topSrc, srcLabel, input.pipelines, thin);
  // Con muestra chica un porcentaje es una mentira disfrazada de dato: se valida
  // en código, no se confía en que el prompt haya alcanzado.
  if (thin) {
    // Sacar el porcentaje NO alcanza: "2 in 3 owners" es exactamente el fraseo
    // que el prompt prohíbe con muestra chica, y sobrevivía intacto porque las
    // sustituciones solo atacaban el símbolo %. Si después de limpiar la línea
    // todavía afirma una proporción, se descarta entera — mejor una sección más
    // corta que una estadística inventada sobre 2 casos.
    for (const s of doc.sections) {
      s.lines = s.lines.map((l: any) => {
        if (!/%|\b\d+\s+in\s+\d+\b/i.test(l.text)) return l;
        const t = l.text
          .replace(/\s*\([^)]*%[^)]*\)/g, "")
          .replace(/\b\d+(\.\d+)?\s*%/g, "")
          .replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
        return /%|\b\d+\s+in\s+\d+\b/i.test(t) ? null : { ...l, text: t };
      }).filter(Boolean);
    }
  }

  const at = new Date().toISOString();
  const md = personaMd(doc, at);
  await withDb(async (c) => {
    await c.queryArray(`update sms_analytics.persona_doc set is_current=false where persona_key=$1 and is_current`, [key]);
    await c.queryArray(
      `insert into sms_analytics.persona_doc(persona_key,n_calls,n_opps,n_words,pipelines,doc,md,model,is_current)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,true)`,
      [key, agg.n, agg.n, input.words, JSON.stringify(input.pipelines), JSON.stringify(doc), md, GEN_MODEL]);
    // Se espeja a context_docs para los consumidores de markdown. Para 'mca' se
    // pisa también la clave vieja 'persona', que es la que leía todo hasta ahora.
    await c.queryArray(
      `insert into sms_analytics.context_docs(key,md,updated_at) values ($1,$2,now())
       on conflict (key) do update set md=excluded.md, updated_at=now()`, ["persona_" + key, md]);
    if (key === "mca") await c.queryArray(
      `insert into sms_analytics.context_docs(key,md,updated_at) values ('persona',$1,now())
       on conflict (key) do update set md=excluded.md, updated_at=now()`, [md]);
  });
  await setPhase(key, "done", agg.n + " compradores");
  return { ok: true, key, deals: agg.n, thin, confidence: doc.confidence, source: srcLabel,
    model: GEN_MODEL, usage: (w as any).usage, elapsedMs: Date.now() - t0, doc };
}

async function setPhase(key: string, phase: string, note?: string | null) {
  await withDb(async (c) => {
    await c.queryArray(
      `update sms_analytics.persona_run
          set phase=$2, note=$3, updated_at=now(),
              started_at = case when $2 in ('scanning') then now() else started_at end,
              finished_at = case when $2 in ('done','error') then now() else null end
        where persona_key=$1`, [key, phase, note ?? null]);
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const token = url.searchParams.get("token");
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });

  // Config + workflows en UNA sola conexión, memoizados mientras viva el isolate.
  let cfg: Record<string, string>;
  try { cfg = await boot(); } catch (e) { return json({ error: "db/config: " + String(e) }, 500); }
  if (!WF.length) WF = WF_FALLBACK;

  // App ABIERTA: no hay clave de operador. Cualquiera con el link puede ejecutar TODAS las
  // acciones (incluidas las que mutan la base o gastan API de GHL/Anthropic). El link es la
  // unica barrera. Los crons siguen mandando ?token= pero ya no se valida; andan igual.
  void token;

  try {
    if (action === "seed") return json(await seed(cfg));
    if (action === "refresh") return json(await refresh(cfg));
    if (action === "markwon") return json(await markwon(cfg));
    if (action === "context") {
      const md = await context(url.searchParams.get("win") || "30", url.searchParams.get("persona") || "mca");
      return new Response(md, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
    }
    if (action === "generate") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await generate(cfg, body));
    }
    if (action === "insight_ai") return json(await insightAi(cfg, url.searchParams.get("win") || "30"));
    if (action === "personas") return json(await personas());
    if (action === "ghl_pipelines") return json(await ghlPipelines(cfg));
    if (action === "ghl_workflows") return json(await ghlWorkflows(cfg));
    if (action === "workflow_add") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      return json(await workflowAdd(cfg, body));
    }
    if (action === "workflow_remove") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      return json(await workflowRemove(body));
    }
    if (action === "persona_data") return json(await personaData(url.searchParams.get("key") || "mca"));
    if (action === "persona_status") return json(await personaStatus(url.searchParams.get("key") || "mca"));
    if (action === "persona_save") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return json(await personaSave(body));
    }
    if (action === "persona_scan") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      return json(await personaScan(cfg, url.searchParams.get("key") || "mca", budget,
        url.searchParams.get("dry") === "1"));
    }
    if (action === "persona_transcribe") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      return json(await personaTranscribe(cfg, url.searchParams.get("key"), budget,
        Math.max(Number(url.searchParams.get("limit") || 0), 0)));
    }
    if (action === "persona_extract") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      return json(await personaExtract(cfg, url.searchParams.get("key") || "mca", budget,
        Math.max(Number(url.searchParams.get("limit") || 0), 0)));
    }
    if (action === "persona_build") return json(await personaBuild(cfg, url.searchParams.get("key") || "mca", url.searchParams.get("force") === "1"));
    if (action === "work") {
      const budget = Math.min(Number(url.searchParams.get("ms") || 100000), 130000);
      const r = await work(cfg, budget);
      // Al drenar todo: marca won fresco y recien ahi construye (flujo semanal automatico).
      if (r.remaining === 0) { await markwon(cfg); const b = await build(cfg); return json({ ...r, built: true, generatedAt: b.generatedAt }); }
      return json(r);
    }
    if (action === "build") return json(await build(cfg));
    if (action === "status") return json(await status());
    if (action === "data") {
      const r = await withDb(async (c) => {
        const q = await c.queryObject<{ data: any; created_at: string }>(
          `select data, created_at from sms_analytics.snapshots_v2 order by id desc limit 1`);
        return q.rows[0] ?? null;
      });
      return json(r ? { ...r.data, snapshotAt: r.created_at } : { empty: true });
    }
    return json({ error: "acciones: seed | refresh | markwon | context | generate | insight_ai | work | build | status | data | ghl_workflows | workflow_add | workflow_remove" }, 400);
  } catch (e) { return json({ error: String(e) }, 500); }
});
