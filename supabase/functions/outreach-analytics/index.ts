import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const BASE = "https://services.leadconnectorhq.com";
const VER = "2021-07-28";
const WINDOW_DAYS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Las 3 secuencias -------------------------------------------------------
// GHL no manda workflowId en los mensajes. Se atribuye el CONTACTO por su
// PRIMER SMS outbound comparado contra el SMS 1 de cada workflow.
// Patrones calibrados 17/07/2026 contra los copies OFICIALES de GHL (SMS 1 de
// cada secuencia). Frases distintivas, sin variables ({{...}}), asi el match es
// igual sobre el body crudo o sobre el template normalizado.
//   cc     -> "...regarding your {monto} in CC" / "this is Anna"       (siempre menciona "in CC")
//   cold   -> "improve your weekly payments" / "Open to a quick call about your MCAs"
//   defdec -> "just got your (MCA) file" + "default situation" | "qualify for an MCA"
// NO son de estas 3 (workflows aparte, quedan 'none'): "from my personal number",
// "About improving those CC terms", "we do MCA relief", "MCA pays itself first weekly", etc.
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

      // Primera respuesta real (no STOP)
      let fi = -1;
      for (let i = 0; i < sms.length; i++) if (sms[i].direction === "inbound" && !isStop(sms[i].body)) { fi = i; break; }

      // Eventos: un registro por SMS outbound
      const events: any[] = [];
      let pos = 0;
      for (let i = 0; i < sms.length; i++) {
        const m = sms[i]; if (m.direction !== "outbound") continue;
        pos++;
        // "consiguio respuesta" = el siguiente mensaje del hilo es inbound real
        let reply = false;
        for (let j = i + 1; j < sms.length; j++) {
          if (sms[j].direction === "outbound") break;
          if (!isStop(sms[j].body)) { reply = true; }
          break;
        }
        const tm = tmplOf(m.body, t.name);
        events.push({ tmpl: tm, key: hashKey(tm), pos, sent: m.dateAdded || null, reply, isTrigger: fi > 0 && i === (() => {
          for (let j = fi - 1; j >= 0; j--) if (sms[j].direction === "outbound") return j; return -1;
        })() });
      }
      const trg = events.find((e) => e.isTrigger);
      return { t, wf, enteredAt, replied: fi >= 0, events,
        triggerKey: trg?.key ?? null, triggerPos: trg?.pos ?? null };
    });

    await withDb(async (c) => {
      for (const r of results) {
        if (!r) continue;
        // templates
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
              const b = j * 7;
              return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::timestamptz,$${b + 6},$${b + 7})`;
            }).join(",");
            const args = chunk.flatMap((e: any) => [r.t.contact_id, r.wf, e.key, e.pos, e.sent, e.reply,
              !!(e.isTrigger && r.t.won)]);
            await c.queryArray(
              `insert into sms_analytics.msg_events(contact_id,wf,tmpl_key,pos,sent_at,got_reply,led_to_lt)
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

      const msgs = await c.queryObject<{ wf: string; tmpl: string; pos: number; sends: bigint; replies: bigint; lts: bigint }>(
        `select e.wf, t.tmpl, min(e.pos)::int as pos,
                count(*)::bigint as sends,
                count(*) filter (where e.got_reply)::bigint as replies,
                count(*) filter (where e.led_to_lt)::bigint as lts
         from sms_analytics.msg_events e
         join sms_analytics.templates t on t.tmpl_key = e.tmpl_key
         where e.sent_at >= now() - ($1 || ' days')::interval
         group by e.wf, t.tmpl
         having count(*) >= 5
         order by count(*) desc`, [String(win)]);

      const msgsByWf: Record<string, any[]> = {};
      for (const r of msgs.rows) {
        const sends = Number(r.sends), replies = Number(r.replies), lts = Number(r.lts);
        (msgsByWf[r.wf] || (msgsByWf[r.wf] = [])).push({
          tmpl: r.tmpl, pos: r.pos, sends, replies, lts,
          replyRate: sends ? Math.round(1000 * replies / sends) / 10 : 0,
          ltRate: sends ? Math.round(10000 * lts / sends) / 100 : 0,
        });
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
