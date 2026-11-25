// Supabase Edge Function "ubicacion": vehicles (or phones kept in a vehicle) send their GPS position here.
// Each sender has its own key, made in the SQL Editor with nuevo_dispositivo() (supabase/ubicaciones.sql).
// The latest position lands in public.ubicaciones, which the dashboard's "Equipo en terreno" layer shows live.
//
// Accepted senders (the key can go in any of the places listed):
//   * OwnTracks (HTTP mode): JSON {"_type":"location","lat","lon","tst","acc","vel","cog","batt"};
//     key as the password (Basic auth; any user name), or ?clave=KEY in the URL. Answers [] as OwnTracks expects.
//   * Traccar Client, old OsmAnd style: ?id=KEY&lat=..&lon=..&timestamp=..&speed=(knots)&bearing=..&accuracy=..&batt=..
//   * Traccar Client 9+: JSON {"device_id":KEY,"location":{"timestamp","coords":{latitude,longitude,accuracy,speed(m/s),heading},"battery":{level 0-1}}}
//   * A Traccar server forwarding its hardware GPS trackers (forward.url = .../ubicacion?clave=KEY, forward.json = true):
//     JSON {"position":{latitude,longitude,speed(knots),course,accuracy,fixTime,attributes:{batteryLevel}},"device":{id,name,uniqueId}}.
//     The key must belong to a dispositivo of tipo "servidor"; each tracker shows under its Traccar name.
//     If the tracker reports the vehicle's odometer (attributes.odometer, metres) it becomes the kilometraje.
//
// Deploy with JWT verification OFF (these apps cannot send a Supabase token): see supabase/LEEME.md.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"};
const json = (o: unknown, status = 200) => {
  // errors go to Edge Functions > ubicacion > Logs too, since OwnTracks only shows the status code
  if (status >= 400) console.error("ubicacion", status, JSON.stringify(o));
  return new Response(JSON.stringify(o), {status, headers: {...CORS, "Content-Type": "application/json"}});
};
const env = (k: string) => Deno.env.get(k) ?? "";
const num = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const KNOTS = 1.852, MS = 3.6;   // to km/h

type Pos = {lat: number, lon: number, t: Date | null, acc: number | null, kmh: number | null, rumbo: number | null, batt: number | null,
  fuente: string, sub?: {id: string, nombre: string}, odo?: number | null};

async function sha256(s: string){
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map(b => b.toString(16).padStart(2, "0")).join("");
}
const fromEpoch = (v: unknown) => { const n = num(v); if (n !== null) return new Date(n > 1e12 ? n : n * 1000);
  if (typeof v === "string" && v) { const d = new Date(v); return isNaN(+d) ? null : d; } return null; };

// reads the position and the key from whatever the sender used
function parse(url: URL, body: Record<string, any> | null, auth: string): {key: string | null, pos: Pos | null, owntracks: boolean} {
  const q = Object.fromEntries(url.searchParams);
  let key = q.clave || q.token || q.id || q.deviceid || null;
  const basic = /^Basic\s+(.+)$/i.exec(auth);
  if (basic) { try { const [, pw] = atob(basic[1]).split(/:(.*)/s); if (pw) key = pw; } catch { /* bad header */ } }
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && !key && !bearer[1].startsWith("ey") && !bearer[1].startsWith("sb_")) key = bearer[1];

  // OwnTracks
  if (body?._type !== undefined) {
    if (body._type !== "location") return {key, pos: null, owntracks: true};
    return {key, owntracks: true, pos: {lat: num(body.lat)!, lon: num(body.lon)!, t: fromEpoch(body.tst), acc: num(body.acc),
      kmh: num(body.vel), rumbo: num(body.cog), batt: num(body.batt), fuente: "owntracks"}};
  }
  // Traccar server forwarding (hardware trackers)
  if (body?.position && body?.device) {
    const p = body.position, d = body.device, a = p.attributes || {};
    const kn = num(p.speed);
    return {key, owntracks: false, pos: {lat: num(p.latitude)!, lon: num(p.longitude)!, t: fromEpoch(p.fixTime || p.deviceTime),
      acc: num(p.accuracy) || null, kmh: kn === null ? null : kn * KNOTS, rumbo: num(p.course), batt: num(a.batteryLevel),
      fuente: "traccar-servidor", sub: {id: String(d.uniqueId ?? d.id ?? ""), nombre: String(d.name || d.uniqueId || "GPS")},
      // the vehicle's own odometer (OBD / CAN), in metres; Traccar's GPS-computed totalDistance is not used:
      // the kilometraje is summed in the database instead, from the team's odometer reading
      odo: num(a.odometer) && num(a.odometer)! > 0 ? num(a.odometer)! / 1000 : null}};
  }
  // Traccar Client 9+
  if (body?.location?.coords) {
    const l = body.location, c = l.coords, ms = num(c.speed), lvl = num(l.battery?.level);
    key = key || (body.device_id ? String(body.device_id) : null);
    return {key, owntracks: false, pos: {lat: num(c.latitude)!, lon: num(c.longitude)!, t: fromEpoch(l.timestamp), acc: num(c.accuracy),
      kmh: ms === null || ms < 0 ? null : ms * MS, rumbo: num(c.heading), batt: lvl === null || lvl < 0 ? null : lvl <= 1 ? lvl * 100 : lvl,
      fuente: "traccar"}};
  }
  // Traccar Client, OsmAnd style (query string or form body)
  const f = {...(body || {}), ...q};
  if (f.lat !== undefined && f.lon !== undefined) {
    const kn = num(f.speed);
    return {key, owntracks: false, pos: {lat: num(f.lat)!, lon: num(f.lon)!, t: fromEpoch(f.timestamp), acc: num(f.accuracy),
      kmh: kn === null ? null : kn * KNOTS, rumbo: num(f.bearing), batt: num(f.batt), fuente: "traccar"}};
  }
  return {key, pos: null, owntracks: false};
}

Deno.serve(async req => {
  try { return await handle(req); }
  catch (e) { return json({error: "Error inesperado: " + ((e as Error)?.message ?? String(e))}, 500); }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", {headers: CORS});
  if (req.method !== "POST" && req.method !== "GET") return json({error: "Use POST"}, 405);
  const url = new URL(req.url);
  let body: Record<string, any> | null = null;
  const text = req.method === "POST" ? await req.text() : "";
  if (text) { try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); } }

  const {key, pos, owntracks} = parse(url, body, req.headers.get("Authorization") ?? "");
  const done = () => owntracks ? json([]) : json({ok: true});
  if (!key) return json({error: "Falta la clave del dispositivo"}, 401);

  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return json({error: "La función no recibe SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"}, 500);
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {auth: {persistSession: false}});
  const {data: dev, error} = await admin.from("dispositivos").select("id,nombre,tipo,activo").eq("clave_hash", await sha256(key)).maybeSingle();
  if (error) return json({error: "No se pudo leer la tabla dispositivos (¿se corrió ubicaciones.sql?): " + error.message}, 500);
  if (!dev || !dev.activo) return json({error: "Clave de dispositivo no válida o desactivada"}, 403);
  if (!pos) return done();   // OwnTracks also sends other messages (status, waypoints…): accept and ignore them
  if (!(pos.lat >= -90 && pos.lat <= 90 && pos.lon >= -180 && pos.lon <= 180) || (pos.lat === 0 && pos.lon === 0))
    return json({error: "Coordenadas inválidas"}, 400);

  // positions in the future are set to now; ones older than 24 h (sent late from a queue) are not kept
  const now = Date.now();
  let t = pos.t && !isNaN(+pos.t) ? +pos.t : now;
  if (t > now + 60e3) t = now;
  if (t < now - 24 * 3600e3) return done();

  const servidor = dev.tipo === "servidor";
  if (servidor && !pos.sub?.id) return json({error: "Falta el GPS que reenvía el servidor Traccar"}, 400);
  const clave = servidor ? `t:${dev.id}:${pos.sub!.id}`.slice(0, 120) : `d:${dev.id}`;
  // apps queue positions while there is no signal and send them later with the time the GPS took them:
  // an older one goes only into the 24 h trail, so it never moves the marker back
  const {data: cur} = await admin.from("ubicaciones").select("creado").eq("clave", clave).maybeSingle();
  if (cur && +new Date(cur.creado) > t) {
    const {error: e1} = await admin.from("ubicaciones_recorrido").insert({clave, lat: pos.lat, lon: pos.lon, creado: new Date(t).toISOString()});
    return e1 ? json({error: e1.message}, 500) : done();
  }

  // a name the team gave this vehicle on the map ("Móvil 20") wins over the one the device sends
  const {data: alias} = await admin.from("ubicaciones_nombres").select("nombre").eq("clave", clave).maybeSingle();
  const r = (v: number | null, d = 1) => v === null ? null : Math.round(v * 10 ** d) / 10 ** d;
  const {error: e2} = await admin.from("ubicaciones").upsert({
    clave, tipo: servidor ? "vehiculo" : dev.tipo, nombre: (alias?.nombre || (servidor ? pos.sub!.nombre : dev.nombre)).slice(0, 60),
    lat: pos.lat, lon: pos.lon, precision_m: r(pos.acc, 0), velocidad: r(pos.kmh), rumbo: r(pos.rumbo, 0),
    bateria: pos.batt === null ? null : r(Math.max(0, Math.min(100, pos.batt)), 0), fuente: pos.fuente, usuario: null,
    odometro_km: pos.odo ?? null,   // the kilometraje (km_hoy, km_total) is worked out by the ubicaciones_km trigger
    creado: new Date(t).toISOString()});
  if (e2) return json({error: "No se pudo guardar la posición (¿se corrió la última versión de ubicaciones.sql?): " + e2.message}, 500);
  return done();
}
