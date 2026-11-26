// Supabase Edge Function "enviar-sms": a signed-in team member sends an SMS alert through Inalambria Express
// to everyone signed up on sms.html (or a test to one number). Called from the "📣 Enviar alerta" window.
// Secret (Edge Functions > Secrets): INALAMBRIA_API_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come with Supabase.
// Body: {accion:"info"} -> {inscritos, saldo}; {accion:"enviar", texto, prueba?:"+573…"} -> {destinatarios, trabajos};
//       {accion:"estado", jobId} -> Inalambria's job status. Setup steps: supabase/LEEME.md.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const API = "https://api.inalambria.express/v1";
const PREFIX = "Cruz Roja Tolima: ";
const MAX = 306;          // hard stop (two SMS); the window warns from 160
const LOTE = 500;         // recipients per request
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {status, headers: {...CORS, "Content-Type": "application/json"}});
const env = (k: string) => Deno.env.get(k) ?? "";
const tel = (s: unknown) => { const d = String(s ?? "").replace(/\D/g, "").replace(/^57(?=3\d{9}$)/, ""); return /^3\d{9}$/.test(d) ? "+57" + d : null; };

async function ina(path: string, init: RequestInit = {}) {
  const key = env("INALAMBRIA_API_KEY");
  if (!key) throw new Error("Falta el secreto INALAMBRIA_API_KEY en Supabase (Edge Functions > Secrets)");
  const r = await fetch(API + path, {...init, headers: {Authorization: "Bearer " + key, "Content-Type": "application/json"}});
  const t = await r.text(); let b: unknown = t; try { b = JSON.parse(t); } catch { /* text */ }
  if (!r.ok) {
    const m = (b as {error?: unknown})?.error;
    throw new Error(`Inalambria respondió ${r.status}` + (r.status === 401 || r.status === 403
      ? " (la llave no es válida o la API aún no está habilitada: se activa después de la primera recarga)" : "")
      + (m ? `: ${typeof m === "string" ? m : JSON.stringify(m)}` : typeof b === "string" && b ? `: ${b.slice(0, 200)}` : ""));
  }
  return b as Record<string, unknown>;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers: CORS});
  if (req.method !== "POST") return json({error: "Use POST"}, 405);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const who = jwt ? (await admin.auth.getUser(jwt)).data.user : null;
  if (!who) return json({error: "Inicie sesión para enviar SMS"}, 401);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }

  try {
    if (b.accion === "info") {
      const {count, error} = await admin.from("sms_inscritos").select("telefono", {count: "exact", head: true}).is("baja", null);
      if (error) throw new Error(error.message);
      let saldo: unknown = null, aviso = "";
      try { saldo = await ina("/messages/balance"); } catch (e) { aviso = (e as Error).message; }
      return json({inscritos: count ?? 0, saldo, aviso});
    }
    if (b.accion === "estado") return json(await ina("/messages/job/" + encodeURIComponent(String(b.jobId ?? ""))));
    if (b.accion !== "enviar") return json({error: "Acción desconocida"}, 400);

    let texto = String(b.texto ?? "").replace(/\s+/g, " ").trim();
    if (!texto) return json({error: "Falta el texto del SMS"}, 400);
    if (!texto.startsWith(PREFIX.trim())) texto = PREFIX + texto;
    if (texto.length > MAX) return json({error: `El SMS es muy largo (${texto.length} caracteres, máximo ${MAX})`}, 400);

    let numeros: string[];
    if (b.prueba) { const t = tel(b.prueba); if (!t) return json({error: "Número de prueba no válido (celular de Colombia, 10 dígitos)"}, 400); numeros = [t]; }
    else {
      const {data, error} = await admin.from("sms_inscritos").select("telefono").is("baja", null);
      if (error) throw new Error(error.message);
      numeros = (data ?? []).map(r => r.telefono);
      if (!numeros.length) return json({destinatarios: 0, trabajos: []});
    }
    const trabajos: unknown[] = [], respuestas: unknown[] = [];
    for (let i = 0; i < numeros.length; i += LOTE) {
      const r = await ina("/messages/send", {method: "POST", body: JSON.stringify({content: texto, recipients: numeros.slice(i, i + LOTE), async: true})});
      respuestas.push(r); trabajos.push(r.jobId ?? r.consumptionId ?? null);
    }
    await admin.from("sms_envios").insert({autor: (who.user_metadata?.handle as string) || who.email, texto,
      destinatarios: numeros.length, prueba: !!b.prueba, trabajos, respuesta: respuestas});
    return json({destinatarios: numeros.length, trabajos, texto});
  } catch (e) {
    const msg = (e as Error).message;
    if (b.accion === "enviar") await admin.from("sms_envios").insert({autor: who.email, texto: String(b.texto ?? ""), destinatarios: 0,
      prueba: !!b.prueba, respuesta: {error: msg}});
    return json({error: msg}, 502);
  }
});
