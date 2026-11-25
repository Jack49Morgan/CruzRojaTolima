// Live positions of the team and the vehicles (signed-in team only).
//   * "📍 Compartir mi ubicación": this phone sends its GPS position every 15 s while the dashboard is open.
//     Positions taken while there is no signal are kept and sent later with the time they were taken.
//   * Map layer "Equipo y vehículos en vivo": one marker per person/vehicle, updated live (Supabase Realtime),
//     with how long ago it was last seen; markers fade when the position is old. "Ver recorrido" draws the last 24 h.
// Vehicles send through the Edge Function supabase/functions/ubicacion (OwnTracks / Traccar).
// Tables and rules: supabase/ubicaciones.sql. Needs IncStore (incstore.js) connected to Supabase.
(() => {
if (typeof IncStore === "undefined" || !IncStore.remote || !IncStore.client) return;
const sb = IncStore.client, esc = IncUtil.esc;
const SEND_MS = 15e3, BEAT_MS = 60e3, STALE_MIN = 10, OLD_MIN = 60;
const ON_KEY = "sat-tolima-ubicacion", Q_KEY = "sat-tolima-ubicacion-cola";
const ls = {get:k => { try { return localStorage.getItem(k); } catch { return null; } },
  set:(k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }};
// the dialog sits further down the page than this script, so it is looked up when needed
const btn = document.getElementById("locbtn"), dlgEl = () => document.getElementById("locdlg"), bodyEl = () => document.getElementById("locb");

// "visto hace 40 min"
const visto = iso => { const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "visto hace un momento"; if (s < 3600) return `visto hace ${Math.round(s / 60)} min`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return `visto hace ${h} h${m ? " " + m + " min" : ""}`; }
  return "visto " + IncUtil.when(iso); };
const ageMin = iso => (Date.now() - new Date(iso)) / 60e3;

/* ---------------- sharing this phone's position ---------------- */
let watch = null, last = null, lastSent = 0, sending = false, wake = null, beat = null, lastErr = "";
let queue = []; try { queue = JSON.parse(ls.get(Q_KEY) || "[]"); } catch {}
const sharing = () => watch !== null;
const saveQ = () => ls.set(Q_KEY, queue.length ? JSON.stringify(queue.slice(-2000)) : null);

async function battery(){ try { const b = await navigator.getBattery?.(); return b ? Math.round(b.level * 100) : null; } catch { return null; } }

// sends the queued positions, oldest first; stops at the first failure (no signal) and tries again later
async function flush(){
  if (sending || !queue.length || !IncStore.user()) return;
  sending = true;
  try {
    while (queue.length) {
      const p = queue[0];
      if (Date.now() - new Date(p.momento) > 24 * 3600e3) { queue.shift(); continue; }
      const {error} = await sb.rpc("compartir_ubicacion", {...p, nombre:IncStore.handle()});
      if (error) { lastErr = !navigator.onLine || /fetch|network|load failed/i.test(error.message)
        ? "Sin conexión: las posiciones se guardan y se envían al volver la señal."
        : /compartir_ubicacion|function|schema cache/i.test(error.message)
        ? "Falta activar esta función en Supabase (supabase/ubicaciones.sql)." : error.message; break; }
      queue.shift(); lastErr = ""; lastSent = Date.now();
    }
  } catch (e) { lastErr = navigator.onLine ? e.message : "Sin conexión: las posiciones se guardan y se envían al volver la señal."; }
  sending = false; saveQ(); paint();
}

async function onFix(pos){
  const c = pos.coords;
  last = {lat:+c.latitude.toFixed(6), lon:+c.longitude.toFixed(6), precision_m:c.accuracy != null ? Math.round(c.accuracy) : null,
    velocidad:c.speed != null && c.speed >= 0 ? Math.round(c.speed * 36) / 10 : null,
    rumbo:c.heading != null && !isNaN(c.heading) ? Math.round(c.heading) : null, momento:new Date(pos.timestamp || Date.now()).toISOString()};
  lastErr = lastErr.startsWith("GPS") ? "" : lastErr;
  if (Date.now() - lastSent >= SEND_MS || !lastSent) await push(last);
  paint();
}
async function push(p){ queue.push({...p, bateria:await battery()}); saveQ(); lastSent = Date.now(); flush(); }
function onErr(e){
  lastErr = e.code === 1 ? "GPS: no hay permiso para usar la ubicación. Permítalo en la configuración del sitio (el candado junto a la dirección) o del celular."
    : e.code === 3 ? "GPS: sin posición todavía (¿está bajo techo o sin señal GPS?). Sigue intentando…"
    : "GPS: no se pudo obtener la posición. Sigue intentando…";
  if (e.code === 1) stop(false);
  paint();
}
async function lockScreen(){
  if (!sharing() || ls.get(ON_KEY + "-pantalla") === "no" || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { wake = await navigator.wakeLock.request("screen"); } catch { wake = null; }
}
function start(){
  if (!("geolocation" in navigator)) { lastErr = "Este navegador no puede dar la ubicación."; paint(); return; }
  if (sharing()) return;
  watch = navigator.geolocation.watchPosition(onFix, onErr, {enableHighAccuracy:true, maximumAge:10e3, timeout:60e3});
  ls.set(ON_KEY, "1");
  // standing still the phone sends no new fix: repeat the last one each minute so the team sees it is still there
  beat = setInterval(() => { if (last && Date.now() - lastSent >= BEAT_MS) push({...last, momento:new Date().toISOString()}); else flush(); }, SEND_MS);
  lockScreen(); paint();
}
async function stop(clear = true){
  if (watch !== null) navigator.geolocation.clearWatch(watch);
  watch = null; clearInterval(beat); beat = null; last = null; lastSent = 0;
  try { await wake?.release(); } catch {} wake = null;
  ls.set(ON_KEY, null);
  if (clear) { queue = []; saveQ();
    const {error} = await sb.rpc("dejar_de_compartir"); if (error && !/function|schema cache/i.test(error.message)) lastErr = error.message; }
  paint();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { lockScreen(); flush(); } });
addEventListener("online", flush);
// signing out stops sharing first, while the session can still delete the position
const signOut = IncStore.signOut;
IncStore.signOut = async () => { if (sharing() || ls.get(ON_KEY)) await stop(true).catch(() => {}); return signOut(); };

// floating bar while sharing, so it is always clear that the position is being sent
const bar = document.createElement("div"); bar.className = "locbar"; bar.hidden = true; bar.setAttribute("role", "status");
document.body.append(bar);
bar.addEventListener("click", e => { if (e.target.closest("[data-loc=stop]")) stop(); else if (e.target.closest("[data-loc=open]")) openDlg(); });
function paint(){
  if (btn) { btn.textContent = sharing() ? "📍 Compartiendo ubicación" : "📍 Compartir mi ubicación"; btn.setAttribute("aria-pressed", sharing()); }
  bar.hidden = !sharing();
  if (sharing()) {
    const pend = queue.length > 1 ? ` · ${queue.length} posiciones por enviar` : "";
    bar.innerHTML = `<span class="dot"></span><span class="t">Compartiendo su ubicación${last ? "" : " · buscando GPS…"}${pend}${lastErr ? `<br><small>${esc(lastErr)}</small>` : ""}</span>
      <button type="button" data-loc="open">Opciones</button><button type="button" data-loc="stop">Detener</button>`;
  }
  if (dlgEl()?.open) renderDlg();
}

function renderDlg(){
  const st = sharing();
  bodyEl().innerHTML = `<p>El equipo con sesión iniciada verá su posición en el mapa, con la hora en que se tomó. Nadie más la ve.
    Se envía cada 15 segundos mientras el tablero esté abierto, y se borra al detener o a las 24 horas.</p>
    <p><b>Importante:</b> el celular deja de enviar cuando la pantalla se apaga o se cambia de aplicación.
    Para vehículos o turnos largos use la aplicación OwnTracks o Traccar Client (vea supabase/LEEME.md).</p>
    <p>Sin señal de celular la posición se guarda en el teléfono y se envía sola al volver la señal. Bajo techo o en cañones profundos el GPS puede no tener posición.</p>
    <label class="chk"><input type="checkbox" id="locwake" ${ls.get(ON_KEY + "-pantalla") === "no" ? "" : "checked"}> Mantener la pantalla encendida mientras comparto</label>
    <p>Aparece como <b>${esc(IncStore.handle() || IncStore.user() || "")}</b>${IncStore.handle() ? "" : " (puede elegir un nombre en Eventos > Elegir mi nombre)"}.</p>
    <p>${st ? `<button type="button" class="btn" data-l="stop">Dejar de compartir</button>` : `<button type="button" class="btn new" data-l="go">📍 Empezar a compartir</button>`}</p>
    ${lastErr ? `<p class="err">${esc(lastErr)}</p>` : ""}`;
}
function openDlg(){ if (!dlgEl()) return; renderDlg(); dlgEl().showModal(); }
if (btn) {
  btn.addEventListener("click", openDlg);
  document.addEventListener("click", e => { if (!e.target.closest?.("#locb")) return; const a = e.target.closest("[data-l]")?.dataset.l; if (a === "go") start(); if (a === "stop") stop(); });
  document.addEventListener("change", e => { if (e.target.id !== "locwake") return;
    ls.set(ON_KEY + "-pantalla", e.target.checked ? null : "no");
    if (e.target.checked) lockScreen(); else { wake?.release().catch(() => {}); wake = null; } });
}

/* ---------------- map layer ---------------- */
let map = null, ctrl = null, layer = null, trail = null, channel = null, marks = {}, rows = {}, tick = null, shown = false;
const COLORS = {persona:"#1f6fb2", vehiculo:"#c8102e"};
// white boxy 5-door wagon with a red cross, nose to the right (the Cruz Roja Tolima "móviles")
const CAR = `<svg viewBox="0 0 48 30" width="44" height="27.5" aria-hidden="true">
  <path d="M3 9.5Q3 6 6.5 6H30.5L35.5 12.2H42.5Q45.5 12.6 45.5 16V21.5Q45.5 23 44 23H4.5Q3 23 3 21.5Z" fill="#fff" stroke="#0b2a5b" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M5.6 8.2H11.4V12.6H5.6ZM13.2 8.2H20.6V12.6H13.2ZM22.4 8.2H29.6L33.4 12.6H22.4Z" fill="#5b7fa6"/>
  <path d="M33.2 12.4V8.6Q33.2 7.4 34.4 7.4" fill="none" stroke="#0b2a5b" stroke-width="1.3" stroke-linecap="round"/>
  <rect x="43" y="19.2" width="3.4" height="2.4" rx=".6" fill="#8a97a8"/><rect x="43.4" y="14" width="2" height="2" rx=".5" fill="#f2b13a"/>
  <path d="M18.4 15.2H21V12.6H23.6V15.2H26.2V17.8H23.6V20.4H21V17.8H18.4Z" fill="#c8102e"/>
  <circle cx="11.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="11.5" cy="23" r="1.9" fill="#c9cfd8"/>
  <circle cx="36.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="36.5" cy="23" r="1.9" fill="#c9cfd8"/></svg>`;
// unit number shown on the marker: "Móvil 20" -> "20", "MOVIL 007" -> "007"
const unidad = n => (String(n || "").match(/(\d+)(?!.*\d)/) || [])[1] || "";
const icon = r => { const a = ageMin(r.creado), cls = a > OLD_MIN ? " old" : a > STALE_MIN ? " stale" : "";
  if (r.tipo === "vehiculo") {
    // the truck faces the way it is going (left or right); the small arrow gives the exact heading
    const west = r.rumbo != null && r.rumbo > 180 && r.rumbo < 360, num = unidad(r.nombre);
    const moving = r.rumbo != null && (r.velocidad == null || r.velocidad >= 3);
    return L.divIcon({className:"locpin car" + cls, iconSize:[48, 34], iconAnchor:[24, 30], popupAnchor:[0, -26],
      html:`<span class="body${west ? " west" : ""}">${CAR}</span>${num ? `<b class="num">${esc(num)}</b>` : ""}`
        + (moving ? `<i class="hd" title="Rumbo ${Math.round(r.rumbo)}°"><svg viewBox="0 0 16 16" width="16" height="16" style="transform:rotate(${Math.round(r.rumbo)}deg)"><circle cx="8" cy="8" r="7.2" fill="#0b2a5b" stroke="#fff" stroke-width="1.5"/><path d="M8 3.2L11.6 12 8 10 4.4 12Z" fill="#fff"/></svg></i>` : "")});
  }
  return L.divIcon({className:"locpin" + cls, iconSize:[30, 30], iconAnchor:[15, 15], popupAnchor:[0, -14],
    html:`<span class="dotp" style="--c:${COLORS[r.tipo] || "#616161"}">🧍</span>`}); };
const RUMBOS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
const popup = r => `<div class="locpop"><b>${esc(r.nombre)}</b><div class="sub">${r.tipo === "vehiculo" ? "Vehículo" : "Persona"} · <b>${esc(visto(r.creado))}</b><br>
  ${IncUtil.when(r.creado)}${r.precision_m != null ? ` · ±${Math.round(r.precision_m)} m` : ""}</div>
  ${[r.velocidad != null ? `${Math.round(r.velocidad)} km/h` : "", r.rumbo != null && (r.velocidad == null || r.velocidad >= 3) ? "hacia el " + RUMBOS[Math.round(r.rumbo / 45) % 8] : "",
     r.bateria != null ? `🔋 ${Math.round(r.bateria)} %` : ""].filter(Boolean).join(" · ")}
  <div class="locbtns"><button type="button" class="btn" data-trail="${esc(r.clave)}">Ver recorrido (24 h)</button>
  ${/^[dt]:/.test(r.clave) ? `<button type="button" class="btn" data-rename="${esc(r.clave)}">Cambiar nombre</button>` : ""}</div></div>`;
const tip = r => `${esc(r.nombre)} <span>${esc(visto(r.creado).replace("visto ", ""))}</span>`;
function put(r){
  rows[r.clave] = r;
  let m = marks[r.clave];
  if (!m) { m = marks[r.clave] = L.marker([r.lat, r.lon], {icon:icon(r), pane:"loc", title:r.nombre}).addTo(layer);
    m.bindTooltip(tip(r), {permanent:true, direction:"right", offset:[14, 0], className:"loctip"});
    m.bindPopup(() => popup(rows[r.clave]), {maxWidth:Math.min(260, innerWidth - 90)}); }
  else { m.setLatLng([r.lat, r.lon]); m.setIcon(icon(r)); m.setTooltipContent(tip(r)); if (m.isPopupOpen()) m.setPopupContent(popup(r)); }
}
function drop(clave){ if (marks[clave]) { layer.removeLayer(marks[clave]); delete marks[clave]; delete rows[clave]; } }
async function load(){
  const {data, error} = await sb.from("ubicaciones").select("*");
  if (error) { console.warn("ubicaciones:", error.message); return; }
  const keep = new Set(data.map(r => r.clave));
  for (const k of Object.keys(marks)) if (!keep.has(k)) drop(k);
  data.forEach(put);
}
async function showTrail(clave){
  trail.clearLayers();
  const {data, error} = await sb.from("ubicaciones_recorrido").select("lat,lon,creado").eq("clave", clave).order("creado").limit(5000);
  if (error || !data?.length) return;
  const r = rows[clave], color = COLORS[r?.tipo] || "#616161";
  L.polyline(data.map(p => [p.lat, p.lon]), {pane:"loc", color, weight:3, opacity:0.8, dashArray:"1 6", lineCap:"round"}).addTo(trail);
  for (const p of data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / 60)) === 0))
    L.circleMarker([p.lat, p.lon], {pane:"loc", radius:3, color, weight:1, fillOpacity:0.7})
      .bindTooltip(IncUtil.hora(p.creado)).addTo(trail);
  const b = L.latLngBounds(data.map(p => [p.lat, p.lon])); if (r) b.extend([r.lat, r.lon]);
  map.closePopup(); map.fitBounds(b, {padding:[30, 30], maxZoom:15});
}
// "Cambiar nombre" (vehicles): the name or unit number the team uses, e.g. "Móvil 20"
async function rename(clave){
  const r = rows[clave]; if (!r) return;
  const n = prompt("Nombre o número de este vehículo (por ejemplo: Móvil 20 - Ibagué). El número se ve sobre el ícono.", r.nombre);
  if (n === null || !n.trim()) return;
  const {error} = await sb.rpc("renombrar_ubicacion", {clave, nombre:n.trim()});
  if (error) return alert("No se pudo cambiar el nombre: " + error.message);
  put({...r, nombre:n.trim().slice(0, 40)});
}
function on(){
  if (shown) return; shown = true;
  ctrl.addOverlay(layer, "Equipo y vehículos en vivo"); layer.addTo(map);
  load();
  channel = sb.channel("ubicaciones-vivo")
    .on("postgres_changes", {event:"*", schema:"public", table:"ubicaciones"}, p => {
      if (p.eventType === "DELETE") drop(p.old?.clave); else if (p.new?.clave) put(p.new); })
    .subscribe(s => { if (s === "SUBSCRIBED") load(); });
  tick = setInterval(() => { for (const r of Object.values(rows)) put(r); }, 30e3);   // refresh "hace X min" and fading
}
function off(){
  if (!shown) return; shown = false;
  if (channel) { sb.removeChannel(channel); channel = null; }
  clearInterval(tick); layer.clearLayers(); trail.clearLayers(); marks = {}; rows = {};
  ctrl.removeLayer(layer); map.removeLayer(layer);
}
// called by index.html once the map and its layer control exist
window.initUbicaciones = (m, c) => {
  map = m; ctrl = c;
  map.createPane("loc").style.zIndex = 640;   // above the station markers (600), below tooltips and popups
  layer = L.layerGroup(); trail = L.layerGroup().addTo(layer);
  document.addEventListener("click", e => { const b = e.target.closest("[data-trail]"); if (b) showTrail(b.dataset.trail);
    const rn = e.target.closest("[data-rename]"); if (rn) rename(rn.dataset.rename); });
  map.on("overlayremove", e => { if (e.layer === layer) trail.clearLayers(); });
  const sync = () => IncStore.user() ? on() : off();
  IncStore.ready().then(sync).catch(() => {}); IncStore.onAuth(sync);
};

// button only for the signed-in team; resume sharing after a reload if it was on and the permission stands
const auth = async () => {
  const u = IncStore.user();
  if (btn) btn.hidden = !u;
  if (!u) { if (sharing()) stop(false); return; }
  if (ls.get(ON_KEY) && !sharing()) {
    let ok = false; try { ok = (await navigator.permissions?.query({name:"geolocation"}))?.state === "granted"; } catch {}
    if (ok) start(); else { ls.set(ON_KEY, null); flush(); }
  } else flush();
  paint();
};
IncStore.ready().then(auth).catch(() => {}); IncStore.onAuth(auth);
})();
