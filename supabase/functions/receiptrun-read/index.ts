// Receipt Run — receipt reader.
//
// The app sends a receipt photo (or the ids of photos it already stored) with
// its reading instructions; this function asks Claude to read it and hands
// back the JSON the app expects. The Anthropic key lives only here, as the
// ANTHROPIC_API_KEY secret — it never reaches the phone or GitHub.
//
// Only signed-in people on a team may use it, so a stranger who makes an
// account can't spend the credit. A team with a monthly cap (teams.
// scan_cap_month; friends' teams start at 50, Stephen's has none) is told so
// once it reaches it. Every read is logged in scan_log for the count.
//
// Body:
//   { ping: true }                                  -> { ok, ready }
//   { prompt, images: [base64 jpeg, ...] }          -> { ok, result }
//   { prompt, assetIds: [id, ...], model? }         -> { ok, result }  (reads the
//        caller's own stored photos; used for side-by-side testing)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const DEFAULT_MODEL = Deno.env.get("RECEIPTRUN_MODEL") || "claude-sonnet-5-5";
const ALLOWED_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const MAX_IMAGES = 6;
const BUCKET = "receiptrun";
const ORIGINS = ["https://buildwrite-projects.github.io"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}
function fail(req: Request, code: string, message: string) {
  return reply(req, { ok: false, code, message });
}

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function pickJson(text: string): unknown {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in reply");
  return JSON.parse(text.slice(a, b + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return fail(req, "invalid_argument", "POST only");

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";

  // --- who is asking ---
  const auth = req.headers.get("Authorization") || "";
  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: who, error: whoErr } = await asUser.auth.getUser();
  if (whoErr || !who?.user) return fail(req, "not_granted", "Sign in first");
  const admin = createClient(url, service);
  const { data: membership } = await admin.from("team_members").select("team_id, teams(scan_cap_month)")
    .eq("user_id", who.user.id).order("added_at").limit(1).maybeSingle();
  if (!membership) return fail(req, "not_granted", "This account isn't on a team yet. Set one up in Job Book first.");
  const teamId = (membership as any).team_id as string;
  const cap = (membership as any).teams?.scan_cap_month as number | null;

  let body: any;
  try { body = await req.json(); } catch { return fail(req, "invalid_argument", "Bad request body"); }

  if (body?.ping) return reply(req, { ok: true, ready: apiKey.length > 0 });
  if (!apiKey) return fail(req, "not_granted", "Receipt reading has no API key yet");

  // --- the monthly cap ---
  if (cap != null) {
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("scan_log").select("id", { count: "exact", head: true })
      .eq("team_id", teamId).gte("at", monthStart.toISOString());
    if ((count ?? 0) >= cap) {
      return fail(req, "monthly_cap", `This team has used its ${cap} receipt reads for the month. You can still add receipts and type the details in.`);
    }
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!prompt) return fail(req, "invalid_argument", "No instructions sent");

  // --- the images ---
  let images: string[] = [];
  if (Array.isArray(body.images)) {
    images = body.images.filter((x: unknown) => typeof x === "string").slice(0, MAX_IMAGES);
  } else if (Array.isArray(body.assetIds)) {
    for (const id of body.assetIds.slice(0, MAX_IMAGES)) {
      if (!/^[0-9a-f]{32}$/.test(String(id))) return fail(req, "invalid_argument", "Bad photo id");
      const { data, error } = await admin.storage.from(BUCKET).download(`${who.user.id}/${id}`);
      if (error || !data) return fail(req, "not_found", "Photo not found: " + id);
      images.push(toB64(await data.arrayBuffer()));
    }
  }
  if (!images.length) return fail(req, "invalid_argument", "No photo sent");

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;

  // --- ask Claude ---
  const content: unknown[] = images.map((data) => ({
    type: "image", source: { type: "base64", media_type: "image/jpeg", data },
  }));
  content.push({ type: "text", text: prompt });

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content }] }),
    });
  } catch (e) {
    return fail(req, "network", "Could not reach the reader");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(out?.error?.message || res.statusText);
    console.log("read failed", res.status, msg);
    if (res.status === 429 || res.status === 529) return fail(req, "rate_limited", msg);
    if (/credit balance/i.test(msg)) return fail(req, "no_credit", msg);
    if (res.status === 401 || res.status === 403) return fail(req, "not_granted", msg);
    return fail(req, "read_failed", msg);
  }
  const text = (out.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  let result: any;
  try { result = pickJson(text); } catch { return fail(req, "read_failed", "Reply was not readable"); }

  await admin.from("scan_log").insert({ team_id: teamId, user_id: who.user.id, pages: images.length });

  // A short line for checking quality and cost later — no line-item contents.
  console.log(JSON.stringify({
    model, ms: Date.now() - t0, pages: images.length,
    in: out.usage?.input_tokens, out: out.usage?.output_tokens,
    vendor: result?.vendor ?? null, date: result?.date ?? null, total: result?.total ?? null,
    items: Array.isArray(result?.items) ? result.items.length : null, confidence: result?.confidence ?? null,
  }));
  return reply(req, { ok: true, model, result, usage: out.usage || null });
});
