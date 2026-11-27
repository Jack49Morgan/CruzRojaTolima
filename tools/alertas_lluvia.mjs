// Rain alerts: sums each Tolima IDEAM station's rain (and each Davis/WeatherLink station's, see below) over the windows in data/umbrales-lluvia.json and,
// when a station passes its threshold, sends a web push to every phone subscribed in Supabase.
// It alerts once per crossing: the station must drop below 90 % of the threshold before it can alert again.
// Notification links are relative to the site (sw.js resolves them). Run by .github/workflows/alertas-lluvia.yml. Needs secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
// SUPABASE_SERVICE_ROLE_KEY. PRUEBA=true sends a test message instead. DRY_RUN=1 prints what it would send without sending or saving anything.
import webpush from "web-push";
import fs from "node:fs/promises";

const SITE = "https://jack49morgan.github.io/cruzrojatolima/";
const API = "https://www.datos.gov.co/resource/";
const HIST = "s54a-sgyg", TODAY = "57sv-p2fu", RAIN = "0240";
const DEP = "departamento in('Tolima','TOLIMA')";
const RESET = 0.9;
const DRY = !!process.env.DRY_RUN;
const DAVIS_URL = "https://raw.githubusercontent.com/jack49morgan/cruzrojatolima/davis-datos/davis.json";

const cfg = JSON.parse(await fs.readFile("data/umbrales-lluvia.json", "utf8"));
const inc = await fs.readFile("incstore.js", "utf8");
const SB = process.env.SUPABASE_URL || (inc.match(/url:\s*"([^"]+)"/) || [])[1];
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const {VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: PRIV} = process.env;
if (!DRY && (!SB || !KEY || !PUB || !PRIV)) {
  console.log("Faltan secretos (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, SUPABASE_SERVICE_ROLE_KEY): no se envían alertas.");
  process.exit(0);
}

// IDEAM times are Colombia local time (UTC-5)
const soql = d => new Date(d.getTime() - 5*3600e3).toISOString().slice(0, 19);
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const clean = s => String(s || "").replace(/\s*\[\d+\]\s*$/, "").replace(/\s+/g, " ").trim();
const title = s => clean(s).toLowerCase().replace(/(^|[\s(-])\p{L}/gu, m => m.toUpperCase());

async function q(id, params){
  const u = API + id + ".json?" + Object.entries(params).map(([k, v]) => "$" + k + "=" + encodeURIComponent(v)).join("&");
  // datos.gov.co sometimes hangs or drops the connection: 45 s limit per try, 3 tries
  for (let i = 0; ; i++) {
    let err;
    try {
      const r = await fetch(u, {signal:AbortSignal.timeout(45000)});
      if (r.ok) return r.json();
      err = new Error(`${id} respondió ${r.status}`);
    } catch (e) { err = new Error(`${id}: ${e.cause?.code || e.name || e.message}`); }
    if (i >= 2) throw err;
    console.log(`Reintentando (${err.message})…`);
    await new Promise(ok => setTimeout(ok, 10000 * (i + 1)));
  }
}

async function sb(path, opts = {}){
  const r = await fetch(SB + "/rest/v1/" + path, {...opts, headers:{apikey:KEY, Authorization:"Bearer " + KEY,
    "Content-Type":"application/json", ...(opts.headers || {})}});
  if (!r.ok) throw new Error(`Supabase ${path} respondió ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

// PRUEBA=true (manual run with "prueba" checked): only send one test message to every phone, to check
// delivery end to end without depending on the IDEAM data
if (process.env.PRUEBA === "true") {
  await push([{title:"Prueba de alertas Cruz Roja Tolima", body:"Si ve este mensaje, su celular recibe las alertas.", url:"./", tag:"prueba"}]);
  process.exit();
}

// Where today's feed takes over from the historical dataset (same split as the dashboard)
const [t] = await q(TODAY, {select:"min(fechaobservacion) as mn,max(fechaobservacion) as mx", where:`${DEP} AND codigosensor='${RAIN}'`});
const cut = t?.mn ? new Date(t.mn.slice(0, 19) + "-05:00") : null;
const now = new Date();

// Rain per station over each window: historical dataset before `cut`, today's feed from `cut` (as the dashboard does)
const sel = {select:"codigoestacion,nombreestacion,municipio,sum(valorobservado) as s",
  group:"codigoestacion,nombreestacion,municipio", limit:"5000"};
const st = {};
for (const h of cfg.ventanas) {
  const where = `${DEP} AND fechaobservacion>'${soql(new Date(now.getTime() - h*3600e3))}'`;
  const rows = (await Promise.all([
    q(HIST, {...sel, where: where + (cut ? ` AND fechaobservacion<'${soql(cut)}'` : "")}),
    cut ? q(TODAY, {...sel, where: `${where} AND codigosensor='${RAIN}' AND fechaobservacion>='${soql(cut)}'`}) : [],
  ])).flat();
  for (const r of rows) {
    const s = st[r.codigoestacion] ||= {id:r.codigoestacion, name:title(r.nombreestacion), mun:title(r.municipio), mm:{}};
    s.mm[h] = (s.mm[h] || 0) + (+r.s || 0);
  }
}
console.log(`Datos hasta ${t?.mx || "?"} (hora Colombia), ${Object.keys(st).length} estaciones con lluvia registrada.`);

// Davis stations of the WeatherLink account (written every 15 min by .github/workflows/davis.yml on the branch davis-datos).
// Only stations that reported in the last 2 hours count; a window is checked once the rain history covers it.
// Their id in data/umbrales-lluvia.json "estaciones" is "davis-" + the WeatherLink station number.
try {
  const r = await fetch(DAVIS_URL + "?t=" + Date.now(), {signal:AbortSignal.timeout(30000)});
  const est = r.ok ? (await r.json()).est || [] : [];
  const nowS = now.getTime() / 1000; let n = 0;
  for (const d of est) {
    if (!d.ts || nowS - d.ts > 2*3600) continue;
    const s = {id:"davis-" + d.id, name:`${d.n} (Davis)`, mun:d.ciudad || "", mm:{}, davis:true};
    for (const h of cfg.ventanas) {
      const covered = (d.h || []).some(([ts]) => ts <= nowS - (h - 1)*3600);
      if (h === 24 && d.r24 != null) s.mm[h] = d.r24;   // the station's own 24 h total when it gives one
      else if (covered) s.mm[h] = (d.h || []).reduce((a, [ts, mm]) => ts > nowS - h*3600 ? a + mm : a, 0);
    }
    if (Object.keys(s.mm).length) { st[s.id] = s; n++; }
  }
  console.log(`Estaciones Davis con datos recientes: ${n} de ${est.length}.`);
} catch (e) { console.log(`Sin datos de estaciones Davis (${e.message}).`); }

const munCfg = Object.fromEntries(Object.entries(cfg.municipios || {}).map(([k, v]) => [norm(k), v]));
const stCfg = Object.fromEntries(Object.entries(cfg.estaciones || {}).map(([k, v]) => [k.replace(/^0+/, ""), v]));
const umbral = (s, h) => {
  for (const o of [stCfg[s.id.replace(/^0+/, "")], munCfg[norm(s.mun)], cfg.defecto]) if (o && String(h) in o) return o[h];
  return null;
};

const state = DRY ? [] : await sb("alertas_lluvia_estado?select=clave,activa");
const active = new Set(state.filter(x => x.activa).map(x => x.clave));
const alerts = [], changes = [];
for (const s of Object.values(st)) for (const h of cfg.ventanas) {
  const u = umbral(s, h); if (u == null) continue;
  if (s.davis && s.mm[h] == null) continue;
  const mm = s.mm[h] || 0;
  const key = `${s.id}|${h}`, was = active.has(key);
  if (mm >= u && !was) { alerts.push({...s, h, mm, u}); changes.push({clave:key, activa:true, valor:+mm.toFixed(1), umbral:u}); }
  else if (was && mm < u*RESET) changes.push({clave:key, activa:false, valor:+mm.toFixed(1), umbral:u});
}
// a station over both windows gets one message, for the shorter window
const seen = new Set(), msgs = [];
for (const a of alerts.sort((x, y) => x.h - y.h)) if (!seen.has(a.id)) { seen.add(a.id); msgs.push(a); }
msgs.sort((x, y) => y.mm/y.u - x.mm/x.u);
for (const a of msgs) console.log(`ALERTA ${a.name} (${a.mun}): ${a.mm.toFixed(0)} mm en ${a.h} h (umbral ${a.u} mm)`);

const notes = msgs.length <= 3
  ? msgs.map(a => ({title:`⚠ Lluvia fuerte: ${a.name}`,
      body:`Estación ${a.name}${a.mun ? ` (${a.mun})` : ""}: ${a.mm.toFixed(0)} mm en ${a.h} h (umbral ${a.u} mm)`,
      url:a.davis ? "./" : `./?estacion=${encodeURIComponent(a.id)}`, tag:`lluvia-${a.id}`}))
  : [{title:`⚠ Lluvia fuerte en ${msgs.length} estaciones`,
      body: msgs.slice(0, 6).map(a => `${a.name} ${a.mm.toFixed(0)} mm/${a.h} h`).join(" · ") + (msgs.length > 6 ? " · …" : ""),
      url:"./", tag:"lluvia-varias"}];

if (DRY) { console.log(JSON.stringify(notes, null, 1)); process.exit(0); }

if (notes.length) await push(notes);
if (changes.length) await sb("alertas_lluvia_estado", {method:"POST", body:JSON.stringify(changes.map(c => ({...c, actualizado:now.toISOString()}))),
  headers:{Prefer:"resolution=merge-duplicates"}});

async function push(notes){
  webpush.setVapidDetails(SITE, PUB, PRIV);
  const subs = await sb("push_suscripciones?select=endpoint,p256dh,auth");
  if (!subs.length) console.log("No hay celulares suscritos: nadie ha tocado «Recibir alertas» todavía (o la suscripción no se guardó).");
  let ok = 0, gone = 0, fail = 0;
  for (const sub of subs) for (const n of notes) {
    try {
      await webpush.sendNotification({endpoint:sub.endpoint, keys:{p256dh:sub.p256dh, auth:sub.auth}},
        JSON.stringify(n), {TTL:6*3600, urgency:"high", topic:n.tag.slice(0, 32)});
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {   // phone unsubscribed or browser data cleared
        gone++; await sb("push_suscripciones?endpoint=eq." + encodeURIComponent(sub.endpoint), {method:"DELETE"});
        break;
      }
      fail++; console.log(`Error enviando (${e.statusCode || ""}): ${e.body || e.message}`);
    }
  }
  console.log(`${subs.length} celulares suscritos: ${ok} enviadas, ${gone} suscripciones vencidas borradas, ${fail} errores.`);
  if (fail) process.exitCode = 1;
}
