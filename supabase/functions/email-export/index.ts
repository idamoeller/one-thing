// email-export: emails a user a CSV + JSON export of all their tasks and settings.
//
// Two ways in:
//   - On demand from the app: sb.functions.invoke("email-export") with the signed-in session.
//     The export goes to that user's own sign-in email.
//   - Daily from pg_cron: header `x-cron-secret: <CRON_SECRET>` and body {"email": "..."}.
//
// Secrets (Dashboard → Edge Functions → Secrets): RESEND_API_KEY, CRON_SECRET.
// Optional: EXPORT_FROM (defaults to Resend's shared test sender, which only delivers
// to the Resend account owner's address). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// provided automatically.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Columns first in this order; anything else the table grows later is appended.
const PREFERRED = [
  "id", "text", "done", "done_at", "created_at", "inbox", "must", "horizon",
  "priority", "urgency", "energy", "time", "context", "tags",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCSV(rows: Record<string, unknown>[]): string {
  const seen = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => seen.add(k)));
  seen.delete("user_id");
  const cols = PREFERRED.filter((c) => seen.has(c)).concat([...seen].filter((c) => !PREFERRED.includes(c)));
  const lines = [cols.join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")));
  // BOM so Excel reads emoji / accents as UTF-8.
  return "﻿" + lines.join("\r\n");
}

// Supabase query errors are plain objects ({message, code, details}), not Error instances.
function errText(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.code && `code ${o.code}`, o.details, o.hint].filter(Boolean);
    if (parts.length) return parts.join(" — ");
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

// deno-lint-ignore no-explicit-any
async function findUserByEmail(admin: any, email: string) {
  const want = String(email || "").trim().toLowerCase();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    const hit = data.users.find((u: any) => (u.email || "").toLowerCase() === want);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const cronSecret = Deno.env.get("CRON_SECRET");

    let user;
    let db = admin;
    if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
      const body = await req.json().catch(() => ({}));
      user = await findUserByEmail(admin, body.email);
      if (!user) return reply(404, { error: "No user with that email" });
    } else {
      const auth = req.headers.get("Authorization") || "";
      const { data, error } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
      if (error || !data.user) return reply(401, { error: "Not signed in" });
      user = data.user;
      // On demand, read as the signed-in user so the app's normal RLS rules apply.
      db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: auth } },
      });
    }
    if (!user.email) return reply(400, { error: "User has no email address" });

    // The cron path uses the service-role client, which bypasses RLS, so every query filters on user_id.
    const [tq, sq] = await Promise.all([
      db.from("tasks").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
      db.from("settings").select("*").eq("user_id", user.id).maybeSingle(),
    ]);
    if (tq.error) throw tq.error;
    if (sq.error) throw sq.error;
    const tasks = tq.data || [];
    const settings = sq.data ? sq.data.defaults : null;

    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const json = JSON.stringify({
      exported_at: now.toISOString(),
      account: user.email,
      task_count: tasks.length,
      tasks,
      settings,
    }, null, 2);

    const open = tasks.filter((t) => !t.done);
    const counts = {
      pile: open.filter((t) => !t.inbox && t.horizon !== "future").length,
      inbox: open.filter((t) => t.inbox).length,
      future: open.filter((t) => !t.inbox && t.horizon === "future").length,
      done: tasks.length - open.length,
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: Deno.env.get("EXPORT_FROM") || "One Thing <onboarding@resend.dev>",
        to: [user.email],
        subject: `One Thing export — ${stamp}`,
        html:
          `<p>Your One Thing export from ${now.toUTCString()}.</p>` +
          `<p>${tasks.length} tasks: ${counts.pile} in the pile, ${counts.inbox} in the inbox, ` +
          `${counts.future} future, ${counts.done} done.</p>` +
          `<p>The CSV opens in Excel or Google Sheets. The JSON is a full backup, including settings and plans.</p>`,
        attachments: [
          { filename: `one-thing-tasks-${stamp}.csv`, content: encodeBase64(new TextEncoder().encode(toCSV(tasks))) },
          { filename: `one-thing-export-${stamp}.json`, content: encodeBase64(new TextEncoder().encode(json)) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

    return reply(200, { ok: true, sent_to: user.email, tasks: tasks.length });
  } catch (e) {
    console.error(e);
    return reply(500, { error: errText(e) });
  }
});
