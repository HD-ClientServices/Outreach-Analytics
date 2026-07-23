import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const LOCATION_ID = "NXZFG9aQz6r1UXzZoedy";

// Workflow IDs
const WORKFLOWS: Record<string, { id: string; key: string; label: string }> = {
  "cc": {
    id: "e28be9d2-ce89-4b6f-b85a-494d08912e58",
    key: "cc",
    label: "Partner CC · DebtMD v2"
  },
  "cold": {
    id: "b985c65c-a0c3-4cdc-a737-7da93b77e933",
    key: "cold",
    label: "V2 · BULK FUP COLD BLAST"
  },
  "defdec": {
    id: "69533301-b2f3-445e-8ebe-3f2227ba8c8e",
    key: "defdec",
    label: "PARTNER · Defaults & Declined"
  }
};

async function ghlFetch(path: string, method = "GET", body?: any) {
  const ghlKey = Deno.env.get("GHL_API_KEY");
  if (!ghlKey) throw new Error("GHL_API_KEY not configured");

  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${ghlKey}`,
      "Version": GHL_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${GHL_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL API error: ${res.status} ${err}`);
  }
  return res.json();
}

async function syncWorkflow(client: any, wf: typeof WORKFLOWS.cc) {
  console.log(`Syncing workflow: ${wf.label}`);

  // Get contacts enrolled in this workflow
  const contactsRes = await ghlFetch(
    `/workflows/${wf.id}/contacts?locationId=${LOCATION_ID}&limit=500`
  );
  const contacts = contactsRes.contacts || [];
  console.log(`  Found ${contacts.length} contacts`);

  // Insert/update contacts into cohort table
  for (const contact of contacts) {
    await client.queryObject(
      `insert into sms_analytics.cohort (contact_id, wf, entered_at, done, won)
       values ($1, $2, $3, true, false)
       on conflict (contact_id, wf) do update set entered_at = $3`,
      [contact.id, wf.key, contact.dateAdded || new Date().toISOString()]
    );
  }

  // Get conversation/message history for these contacts
  // Note: This pulls ALL messages for ALL contacts in the location
  // We'll filter by workflow via the cohort table
  const conversationsRes = await ghlFetch(
    `/conversations?locationId=${LOCATION_ID}&limit=500`
  );
  const conversations = conversationsRes.conversations || [];
  console.log(`  Found ${conversations.length} conversations`);

  // Process messages
  for (const convo of conversations) {
    if (!convo.messages) continue;
    for (const msg of convo.messages) {
      if (msg.type !== "SMS" || msg.direction !== "outbound") continue;

      // Get template text
      const templateText = msg.body || msg.messageTemplate?.body || "";
      const templateKey = `tmpl_${Buffer.from(templateText).toString("base64").slice(0, 20)}`;

      // Upsert template
      await client.queryObject(
        `insert into sms_analytics.templates (tmpl_key, tmpl)
         values ($1, $2)
         on conflict (tmpl_key) do nothing`,
        [templateKey, templateText]
      );

      // Upsert message event
      // Note: GHL doesn't directly expose reply/LT data in messages
      // This requires webhook integration or periodic status checks
      await client.queryObject(
        `insert into sms_analytics.msg_events
         (contact_id, wf, tmpl_key, pos, sent_at, got_reply, led_to_lt, led_to_dnd)
         values ($1, $2, $3, 0, $4, false, false, false)
         on conflict (contact_id, tmpl_key, sent_at) do nothing`,
        [convo.contactId, wf.key, templateKey, msg.sentAt || new Date().toISOString()]
      );
    }
  }
}

async function withDb(fn: (c: any) => Promise<any>) {
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (!dbUrl) throw new Error("DATABASE_URL not configured");

  const client = new Client(dbUrl);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

Deno.serve(async (req) => {
  try {
    // Only allow POST requests
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
    }

    await withDb(async (client) => {
      // Sync each workflow
      for (const wf of Object.values(WORKFLOWS)) {
        await syncWorkflow(client, wf);
      }
    });

    return new Response(JSON.stringify({
      status: "success",
      message: "Sync completed",
      syncedAt: new Date().toISOString()
    }), { status: 200 });

  } catch (error) {
    console.error("Sync error:", error);
    return new Response(JSON.stringify({
      status: "error",
      message: error.message
    }), { status: 500 });
  }
});
