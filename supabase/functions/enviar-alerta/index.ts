// Supabase Edge Function "enviar-alerta": a signed-in team member sends a push to every subscribed phone.
// Called from the dashboard ("📣 Enviar alerta") and from the event form ("Enviar alerta" on an Evento).
// Secrets (Edge Functions > Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Setup steps: supabase/LEEME.md.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const SITE = "https://jack49morgan.github.io/cruzrojatolima/";
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {status, headers: {...CORS, "Content-Type": "application/json"}});
const env = (k: string) => Deno.env.get(k) ?? "";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: CORS});
  if (req.method !== "POST") return json({error: "Use POST"}, 405);

  // only team members signed in to the dashboard may send
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const who = jwt ? (await admin.auth.getUser(jwt)).data.user : null;
  if (!who) return json({error: "Inicie sesión para enviar alertas"}, 401);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty body */ }
  const title = String(b.title ?? "").trim().slice(0, 120);
  const body = String(b.body ?? "").trim().slice(0, 400);
  if (!title) return json({error: "Falta el título de la alerta"}, 400);
  // links stay inside the dashboard (relative, e.g. "incidente.html?id=…"); sw.js resolves them
  const url = /^(\.\/|incidente\.html|\?)[^\s]*$/.test(String(b.url ?? "")) ? String(b.url) : "./";
  const tag = String(b.tag || "manual-" + Date.now()).replace(/[^\w-]/g, "").slice(0, 32) || "manual";
  if (!env("VAPID_PUBLIC_KEY") || !env("VAPID_PRIVATE_KEY")) return json({error: "Faltan las llaves VAPID en los secretos de la función"}, 500);

  const author = (who.user_metadata?.handle as string) || who.email || "";
  const {data: subs, error} = await admin.from("push_suscripciones").select("endpoint,p256dh,auth");
  if (error) return json({error: error.message}, 500);

  webpush.setVapidDetails(SITE, env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
  const payload = JSON.stringify({title, body, url, tag});
  let enviadas = 0, vencidas = 0, errores = 0;
  await Promise.all((subs ?? []).map(async s => {
    try {
      await webpush.sendNotification({endpoint: s.endpoint, keys: {p256dh: s.p256dh, auth: s.auth}}, payload,
        {TTL: 12 * 3600, urgency: "high", topic: tag});
      enviadas++;
    } catch (e) {
      const code = (e as {statusCode?: number}).statusCode;
      if (code === 404 || code === 410) { vencidas++; await admin.from("push_suscripciones").delete().eq("endpoint", s.endpoint); }
      else { errores++; console.log("push error", code, (e as {body?: string}).body ?? String(e)); }
    }
  }));
  await admin.from("alertas_enviadas").insert({titulo: title, texto: body, enlace: url, autor: author,
    tipo: "manual", enviadas, errores});
  return json({enviadas, vencidas, errores, suscritos: subs?.length ?? 0});
});
