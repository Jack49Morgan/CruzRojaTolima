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
// red classic road bike (Móvil 6000), same size and direction as the truck
const BIKE = `<svg viewBox="0 0 48 30" width="44" height="27.5" aria-hidden="true">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="10.5" cy="20" r="8" stroke="#fff" stroke-width="4"/><circle cx="37.5" cy="20" r="8" stroke="#fff" stroke-width="4"/>
    <circle cx="10.5" cy="20" r="8" stroke="#1d2430" stroke-width="2.2"/><circle cx="37.5" cy="20" r="8" stroke="#1d2430" stroke-width="2.2"/>
    <path d="M10.5 20L23 20.5L19.5 8.5M10.5 20L19.8 9.5M19.5 9H33M23 20.5L33.6 11M33 8.3L37.5 20" stroke="#fff" stroke-width="4.2"/>
    <path d="M10.5 20L23 20.5L19.5 8.5M10.5 20L19.8 9.5M19.5 9H33M23 20.5L33.6 11M33 8.3L37.5 20" stroke="#c8102e" stroke-width="2.4"/>
    <path d="M32.6 8.2L33.6 5.6H37.2Q39.4 5.6 39.4 7.8V9.2Q39.4 10.8 37.8 10.8" stroke="#1d2430" stroke-width="1.6"/>
    <path d="M16.6 6.6H22.4" stroke="#1d2430" stroke-width="2.2"/><path d="M19.5 6.8V8.6" stroke="#1d2430" stroke-width="1.4"/>
  </g>
  <circle cx="23" cy="20.5" r="2" fill="#1d2430"/><circle cx="10.5" cy="20" r="1.3" fill="#1d2430"/><circle cx="37.5" cy="20" r="1.3" fill="#1d2430"/>
</svg>`;
// white double-cab pickup with a red cross on the doors (generic shape, no brand), nose to the right
const PICKUP = `<svg viewBox="0 0 48 30" width="44" height="27.5" aria-hidden="true">
  <path d="M3 12.6H15.6V8.2Q15.6 6 17.8 6H31L36.2 12.6H42.5Q45.5 13 45.5 16V21.5Q45.5 23 44 23H4.5Q3 23 3 21.5Z" fill="#fff" stroke="#0b2a5b" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M17.6 7.8H24.6V12.4H17.6ZM26.2 7.8H30.4L34 12.4H26.2Z" fill="#5b7fa6"/>
  <path d="M4 14.6H14.8" stroke="#0b2a5b" stroke-width="1.1" stroke-linecap="round"/>
  <path d="M15.6 12.6V21M25.4 12.6V20.6" stroke="#0b2a5b" stroke-width="1" stroke-linecap="round"/>
  <rect x="43" y="19.2" width="3.4" height="2.4" rx=".6" fill="#8a97a8"/><rect x="43.4" y="14.4" width="2" height="2" rx=".5" fill="#f2b13a"/>
  <path d="M16.8 16H19.3V13.5H21.9V16H24.4V18.6H21.9V21.1H19.3V18.6H16.8Z" fill="#c8102e"/>
  <circle cx="11.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="11.5" cy="23" r="1.9" fill="#c9cfd8"/>
  <circle cx="37.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="37.5" cy="23" r="1.9" fill="#c9cfd8"/></svg>`;
// white ambulance van: tall box with a big red cross, red stripe and roof light bar, nose to the right
const AMBU = `<svg viewBox="0 0 48 30" width="44" height="27.5" aria-hidden="true">
  <rect x="25.5" y=".6" width="6.4" height="2.6" rx="1" fill="#c8102e" stroke="#0b2a5b" stroke-width=".8"/><rect x="27.2" y="1.2" width="1.4" height="1.4" rx=".4" fill="#ffb3bd"/>
  <path d="M3 5.2Q3 3 5.2 3H31.4Q33 3 33.8 4.6L38.8 12.4H42.5Q45.5 12.8 45.5 16V21.5Q45.5 23 44 23H4.5Q3 23 3 21.5Z" fill="#fff" stroke="#0b2a5b" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M33.6 6.8L37.2 12.4H33.6Z" fill="#5b7fa6"/>
  <path d="M3.7 16.4H44.8V18.2H3.7Z" fill="#c8102e"/>
  <path d="M12.6 8H16V4.6H19.4V8H22.8V11.4H19.4V14.8H16V11.4H12.6Z" fill="#c8102e"/>
  <path d="M32.6 5V20.6" stroke="#0b2a5b" stroke-width="1" stroke-linecap="round"/>
  <rect x="43" y="19.4" width="3.4" height="2.2" rx=".6" fill="#8a97a8"/><rect x="43.4" y="13.8" width="2" height="2" rx=".5" fill="#f2b13a"/>
  <circle cx="11.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="11.5" cy="23" r="1.9" fill="#c9cfd8"/>
  <circle cx="37.5" cy="23" r="4.6" fill="#1d2430"/><circle cx="37.5" cy="23" r="1.9" fill="#c9cfd8"/></svg>`;
const ICONS = {camioneta:CAR, pickup:PICKUP, ambulancia:AMBU, bicicleta:BIKE};
// vehicle types offered in the panel: [clase, emoji, name]
const CLASES = [["camioneta", "🚙", "Camioneta"], ["pickup", "🛻", "Pickup"], ["ambulancia", "🚑", "Ambulancia"], ["bicicleta", "🚲", "Bicicleta"]];
const shape = r => ICONS[r?.clase] || CAR;
// unit number shown on the marker: "Móvil 20" -> "20", "MOVIL 007" -> "007"
const unidad = n => (String(n || "").match(/(\d+)(?!.*\d)/) || [])[1] || "";
const icon = r => { const a = ageMin(r.creado), cls = r.estado === "fin" ? " parked" : r.estado === "pausa" ? " paused" : a > OLD_MIN ? " old" : a > STALE_MIN ? " stale" : "";
  if (r.tipo === "vehiculo") {
    // the truck faces the way it is going (left or right); the small arrow gives the exact heading
    const west = r.rumbo != null && r.rumbo > 180 && r.rumbo < 360, num = unidad(r.nombre);
    const moving = !r.estado && r.rumbo != null && (r.velocidad == null || r.velocidad >= 3);
    return L.divIcon({className:"locpin car" + cls, iconSize:[48, 34], iconAnchor:[24, 30], popupAnchor:[0, -26],
      html:`<span class="body${west ? " west" : ""}">${shape(r)}</span>${num ? `<b class="num">${esc(num)}</b>` : ""}`
        + (r.estado === "fin" ? `<i class="pk" title="Estacionado">P</i>` : r.estado === "pausa" ? `<i class="pk pa" title="En pausa">❚❚</i>` : "")
        + (moving ? `<i class="hd" title="Rumbo ${Math.round(r.rumbo)}°"><svg viewBox="0 0 16 16" width="16" height="16" style="transform:rotate(${Math.round(r.rumbo)}deg)"><circle cx="8" cy="8" r="7.2" fill="#0b2a5b" stroke="#fff" stroke-width="1.5"/><path d="M8 3.2L11.6 12 8 10 4.4 12Z" fill="#fff"/></svg></i>` : "")});
  }
  return L.divIcon({className:"locpin" + cls, iconSize:[30, 30], iconAnchor:[15, 15], popupAnchor:[0, -14],
    html:`<span class="dotp" style="--c:${COLORS[r.tipo] || "#616161"}">🧍</span>`}); };
// kilometraje (summed in the database, kept after the 24 h): today and, for vehicles, the odometer
const nf = (v, d = 1) => Number(v).toLocaleString("es-CO", {maximumFractionDigits:d, minimumFractionDigits:d});
const km = r => r.km_hoy == null && r.km_total == null ? "" : `<div class="lockm">
  ${r.km_hoy != null ? `<span><b>${nf(r.km_hoy)} km</b> hoy</span>` : ""}
  ${r.tipo === "vehiculo" && r.km_total != null ? `<span>Odómetro <b>${nf(r.km_total, 0)} km</b></span>` : ""}</div>`;
const RUMBOS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
const popup = r => `<div class="locpop"><b>${esc(r.nombre)}</b>${r.estado === "fin" ? `<div class="fin">🅿 Estacionado desde ${esc(IncUtil.hora(r.fin_en || r.creado))}</div>` : r.estado === "pausa" ? `<div class="fin pa">⏸ En pausa desde ${esc(IncUtil.hora(r.fin_en || r.creado))}</div>` : ""}<div class="sub">${r.tipo === "vehiculo" ? ((CLASES.find(c => c[0] === r.clase) || CLASES[0])[2]) : "Persona"} · <b>${esc(visto(r.creado))}</b><br>
  ${IncUtil.when(r.creado)}${r.precision_m != null ? ` · ±${Math.round(r.precision_m)} m` : ""}</div>
  ${r.estado ? "" : [r.velocidad != null ? `${Math.round(r.velocidad)} km/h` : "", r.rumbo != null && (r.velocidad == null || r.velocidad >= 3) ? "hacia el " + RUMBOS[Math.round(r.rumbo / 45) % 8] : ""].filter(Boolean).join(" · ")}
  ${km(r)}
  <div class="locbtns"><button type="button" class="btn" data-trail="${esc(r.clave)}">Recorrido 24 h · exportar</button>
  ${/^[dt]:/.test(r.clave) ? `<button type="button" class="btn" data-rename="${esc(r.clave)}">Cambiar nombre</button>
    <button type="button" class="btn" data-odo="${esc(r.clave)}">Odómetro</button>
    ${r.estado ? `<button type="button" class="btn" data-est="${esc(r.clave)}" data-v="">▶ Reanudar</button>`
      : `<button type="button" class="btn" data-est="${esc(r.clave)}" data-v="pausa">⏸ Pausar</button><button type="button" class="btn" data-est="${esc(r.clave)}" data-v="fin">🅿 Terminar recorrido</button>`}` : ""}
  ${/^d:\d+$/.test(r.clave) ? `<button type="button" class="btn" data-popqr="${esc(r.clave.slice(2))}">Código QR</button>` : ""}</div></div>`;
const tip = r => `${esc(r.nombre)} <span>${r.estado === "fin" ? "estacionado" : r.estado === "pausa" ? "en pausa" : esc(visto(r.creado).replace("visto ", ""))}</span>`;
function put(r){
  rows[r.clave] = r;
  // "Terminar recorrido": the vehicle leaves the map (it stays in the Vehículos panel as "Fuera de servicio")
  if (r.estado === "fin") { if (marks[r.clave]) { layer.removeLayer(marks[r.clave]); delete marks[r.clave]; } if (trailInfo?.clave === r.clave) { trail.clearLayers(); trailBar.hidden = true; trailInfo = null; } return; }
  let m = marks[r.clave];
  if (!m) { m = marks[r.clave] = L.marker([r.lat, r.lon], {icon:icon(r), pane:"loc", title:r.nombre}).addTo(layer);
    m.bindTooltip(tip(r), {permanent:true, direction:"right", offset:[14, 0], className:"loctip"});
    m.bindPopup(() => popup(rows[r.clave]), {maxWidth:Math.min(260, innerWidth - 90)}); }
  else { m.setLatLng([r.lat, r.lon]); m.setIcon(icon(r)); m.setTooltipContent(tip(r)); if (m.isPopupOpen()) m.setPopupContent(popup(r)); }
}
function drop(clave){ if (marks[clave]) { layer.removeLayer(marks[clave]); delete marks[clave]; } delete rows[clave]; }
async function load(){
  const {data, error} = await sb.from("ubicaciones").select("*");
  if (error) { console.warn("ubicaciones:", error.message); return; }
  const keep = new Set(data.map(r => r.clave));
  for (const k of Object.keys(rows)) if (!keep.has(k)) drop(k);
  data.forEach(put);
}
// distance between two points, km
const hav = (a, b) => { const R = 6371.0088, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2)); };
let trailInfo = null;   // {clave, nombre, pts:[{lat,lon,creado,velocidad,km}]}
const trailBar = document.createElement("div"); trailBar.className = "trailbar"; trailBar.hidden = true;
async function showTrail(clave){
  trail.clearLayers();
  let {data, error} = await sb.from("ubicaciones_recorrido").select("lat,lon,velocidad,creado").eq("clave", clave).order("creado").limit(5000);
  if (error) ({data, error} = await sb.from("ubicaciones_recorrido").select("lat,lon,creado").eq("clave", clave).order("creado").limit(5000));   // before the velocidad column
  const r = rows[clave];
  if (!map.getContainer().contains(trailBar)) { map.getContainer().append(trailBar); L.DomEvent.disableClickPropagation(trailBar); }
  if (error || !data?.length) { trailInfo = null; trailBar.hidden = false;
    trailBar.innerHTML = `<span>${esc(r?.nombre || "")}: sin recorrido en las últimas 24 h</span><button type="button" data-tb="x" aria-label="Cerrar">✕</button>`; return; }
  // the route is split where the GPS was silent for a while and the vehicle reappears elsewhere, or where the jump is
  // impossible (a test point, a bad fix): no straight line is drawn across, and those km are not added.
  // Moves under 30 m are GPS wobble and are not added either.
  const segs = [[data[0]]];
  let km = 0, anchor = data[0]; data[0].km = 0;
  for (let i = 1; i < data.length; i++) {
    const p = data[i], prev = data[i - 1], d = hav(prev, p), h = (new Date(p.creado) - new Date(prev.creado)) / 3600e3;
    if ((h > 5 / 60 && d > 1) || (h > 0 ? d / h : d > 0.5 ? Infinity : 0) > 150) { segs.push([p]); anchor = p; }
    else { segs.at(-1).push(p); const da = hav(anchor, p); if (da >= 0.03) { km += da; anchor = p; } }
    p.km = Math.round(km * 100) / 100;
  }
  trailInfo = {clave, nombre:r?.nombre || clave, pts:data, segs};
  const color = COLORS[r?.tipo] || "#616161";
  for (const sg of segs) if (sg.length > 1)
    L.polyline(sg.map(p => [p.lat, p.lon]), {pane:"loc", color, weight:3, opacity:0.8, dashArray:"1 6", lineCap:"round"}).addTo(trail);
  for (const p of data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / 60)) === 0))
    L.circleMarker([p.lat, p.lon], {pane:"loc", radius:3, color, weight:1, fillOpacity:0.7})
      .bindTooltip(IncUtil.hora(p.creado)).addTo(trail);
  const b = L.latLngBounds(data.map(p => [p.lat, p.lon])); if (r) b.extend([r.lat, r.lon]);
  map.closePopup(); map.fitBounds(b, {padding:[30, 30], maxZoom:15});
  trailBar.hidden = false;
  trailBar.innerHTML = `<span><b>${esc(trailInfo.nombre)}</b> · ${IncUtil.hora(data[0].creado)} a ${IncUtil.hora(data.at(-1).creado)} · ${nf(km)} km</span>
    <span class="tbx">Exportar: <button type="button" data-tb="gpx">GPX</button><button type="button" data-tb="kml">KML</button><button type="button" data-tb="csv">CSV</button></span>
    <button type="button" data-tb="x" aria-label="Cerrar recorrido">✕</button>`;
}
// route export: GPX (GPS apps), KML (Google Earth / Maps), CSV (Excel). Only the last 24 h are kept.
function exportTrail(fmt){
  const t = trailInfo; if (!t) return;
  const x = s => String(s).replace(/[<>&"]/g, c => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"})[c]);
  const co = iso => new Date(iso).toLocaleString("sv-SE", {timeZone:"America/Bogota"});   // "2026-11-25 14:05:09"
  const day = co(t.pts[0].creado).slice(0, 10), base = `recorrido-${t.nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}-${day}`;
  let text, type;
  if (fmt === "gpx") {
    type = "application/gpx+xml";
    text = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="SAT Tolima - Cruz Roja Colombiana Seccional Tolima" xmlns="http://www.topografix.com/GPX/1/1">\n`
      + `<trk><name>${x(t.nombre)} ${day}</name>\n`
      + t.segs.map(sg => `<trkseg>\n` + sg.map(p => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.creado).toISOString()}</time>${p.velocidad != null ? `<extensions><speed>${(p.velocidad / 3.6).toFixed(2)}</speed></extensions>` : ""}</trkpt>`).join("\n") + `\n</trkseg>`).join("\n")
      + `\n</trk>\n</gpx>\n`;
  } else if (fmt === "kml") {
    type = "application/vnd.google-earth.kml+xml";
    const end = t.pts.at(-1);
    text = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(t.nombre)} ${day}</name>\n`
      + `<Style id="r"><LineStyle><color>ff2e10c8</color><width>4</width></LineStyle></Style>\n`
      + `<Placemark><name>${x(t.nombre)}</name><description>${x(co(t.pts[0].creado))} a ${x(co(end.creado))} · ${end.km} km</description><styleUrl>#r</styleUrl>`
      + `<MultiGeometry>${t.segs.filter(sg => sg.length > 1).map(sg => `<LineString><tessellate>1</tessellate><coordinates>${sg.map(p => `${p.lon},${p.lat}`).join(" ")}</coordinates></LineString>`).join("")}</MultiGeometry></Placemark>\n`
      + `<Placemark><name>Inicio ${x(co(t.pts[0].creado).slice(11, 16))}</name><Point><coordinates>${t.pts[0].lon},${t.pts[0].lat}</coordinates></Point></Placemark>\n`
      + `<Placemark><name>Fin ${x(co(end.creado).slice(11, 16))}</name><Point><coordinates>${end.lon},${end.lat}</coordinates></Point></Placemark>\n`
      + `</Document></kml>\n`;
  } else {
    type = "text/csv;charset=utf-8";
    text = "﻿hora_colombia;latitud;longitud;velocidad_kmh;km_acumulados\n"   // BOM + ";" so Excel in Spanish opens it in columns
      + t.pts.map(p => [co(p.creado), p.lat, p.lon, p.velocidad ?? "", p.km].map(v => String(v).replace(".", ",")).join(";")).join("\n") + "\n";
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = `${base}.${fmt}`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
trailBar.addEventListener("click", e => { const k = e.target.closest("[data-tb]")?.dataset.tb; if (!k) return;
  if (k === "x") { trail.clearLayers(); trailBar.hidden = true; trailInfo = null; } else exportTrail(k); });
// "Cambiar nombre" (vehicles): the name or unit number the team uses, e.g. "Móvil 20"
async function rename(clave){
  const r = rows[clave]; if (!r) return;
  const n = prompt("Nombre o número de este vehículo (por ejemplo: Móvil 20 - Ibagué). El número se ve sobre el ícono.", r.nombre);
  if (n === null || !n.trim()) return;
  const {error} = await sb.rpc("renombrar_ubicacion", {clave, nombre:n.trim()});
  if (error) return alert("No se pudo cambiar el nombre: " + error.message);
  put({...r, nombre:n.trim().slice(0, 40)});
}
// Pausar / Terminar recorrido / Reanudar from the map: the vehicle stays where it is and its positions are ignored
// until it is resumed (the driver can do the same from the QR page; ending there also silences OwnTracks)
async function estado(clave, v){
  const r = rows[clave]; if (!r) return;
  if (v === "fin" && !confirm(`¿Terminar el recorrido de ${r.nombre}? Sale del mapa (queda "Fuera de servicio" en 🚑 Vehículos) y no sigue al celular hasta que el conductor toque Conectar.`)) return;
  const {error} = await sb.rpc("estado_vehiculo", {clave, estado:v});
  if (error) return alert("No se pudo cambiar: " + (/estado_vehiculo|function|schema cache/i.test(error.message) ? "falta correr la última versión de supabase/ubicaciones.sql." : error.message));
  put({...r, estado:v, fin_en:v ? new Date().toISOString() : null});
  if (vdlg()?.open && vehs.length) renderVeh();
}
// "Odómetro": the team types the vehicle's real odometer reading; from then on the GPS kilometres add to it
async function odometro(clave){
  const r = rows[clave]; if (!r) return;
  const v = prompt(`Lectura actual del odómetro de ${r.nombre}, en km (la que marca el tablero del vehículo):`,
    r.km_total != null ? Math.round(r.km_total) : "");
  if (v === null || !v.trim()) return;
  const n = Number(v.replace(/[.\s]/g, "").replace(",", "."));
  if (!isFinite(n) || n < 0) return alert("Escriba solo el número de kilómetros, por ejemplo 152300.");
  const {error} = await sb.rpc("fijar_odometro", {clave, km:n});
  if (error) return alert("No se pudo guardar: " + error.message);
  put({...r, km_total:n});
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
  clearInterval(tick); layer.clearLayers(); trail.clearLayers(); trailBar.hidden = true; trailInfo = null; marks = {}; rows = {};
  ctrl.removeLayer(layer); map.removeLayer(layer);
}
// called by index.html once the map and its layer control exist
window.initUbicaciones = (m, c) => {
  map = m; ctrl = c;
  map.createPane("loc").style.zIndex = 640;   // above the station markers (600), below tooltips and popups
  layer = L.layerGroup(); trail = L.layerGroup().addTo(layer);
  document.addEventListener("click", e => { const b = e.target.closest("[data-trail]"); if (b) showTrail(b.dataset.trail);
    const rn = e.target.closest("[data-rename]"); if (rn) rename(rn.dataset.rename);
    const od = e.target.closest("[data-odo]"); if (od) odometro(od.dataset.odo);
    const es = e.target.closest("[data-est]"); if (es) estado(es.dataset.est, es.dataset.v || null);
    const pq = e.target.closest("[data-popqr]"); if (pq && vbtn) { map.closePopup(); openVeh(+pq.dataset.popqr); } });
  map.on("overlayremove", e => { if (e.layer === layer) { trail.clearLayers(); trailBar.hidden = true; } });
  const sync = () => IncStore.user() ? on() : off();
  IncStore.ready().then(sync).catch(() => {}); IncStore.onAuth(sync);
};

/* ---------------- "🚑 Vehículos": add vehicles and print the QR that connects a phone to each ---------------- */
// Scanning a vehicle's QR opens owntracks.html, which loads that vehicle into OwnTracks (iPhone and Android).
// A driver who changes trucks scans the QR stuck in the new truck; the phone then reports as that one.
// "Mi vehículo": this phone scanned a vehicle's QR (owntracks.html remembers it), so the dashboard offers a shortcut
// back to that vehicle's Pausar / Reanudar / Terminar buttons, signed in or not
(() => { const b = document.getElementById("mivehbtn"); if (!b) return;
  let m = null; try { m = JSON.parse(localStorage.getItem("crt-mi-vehiculo")); } catch {}
  if (!m?.k) return;
  b.href = "owntracks.html#" + new URLSearchParams({n:m.n, k:m.k, t:m.t || ""}); b.textContent = "🚑 Mi vehículo: " + m.n; b.hidden = false; })();
const vbtn = document.getElementById("vehbtn"), vdlg = () => document.getElementById("vehdlg"), vbody = () => document.getElementById("vehb");
let qrLib = null;
const loadQr = () => qrLib ??= new Promise((ok, bad) => { if (self.qrcode) return ok(self.qrcode);
  const sc = document.createElement("script"); sc.src = "vendor/qrcode-generator-1.4.4.min.js";
  sc.onload = () => ok(self.qrcode); sc.onerror = () => { qrLib = null; bad(new Error("no se pudo cargar el generador de QR")); }; document.head.append(sc); });
const qrLink = (v, clave) => new URL("owntracks.html", location.href).href.split("#")[0]
  + "#" + new URLSearchParams({n:v.nombre, k:clave, t:unidad(v.nombre)}).toString();
async function qrSvg(text, px = 260){
  const qrcode = await loadQr(), q = qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, cell = px / (n + 2 * m);
  let d = ""; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const card = (v, svg) => `<div class="vehcard"><div class="vhd">${shape(v)}<div><b>${esc(v.nombre)}</b><span>Cruz Roja Colombiana · Seccional Tolima</span></div></div>
  ${svg}<p><b>Conductor:</b> escanee este código con la cámara del celular para enviar la ubicación como <b>${esc(v.nombre)}</b>
  (necesita la aplicación OwnTracks). Al cambiar de vehículo, escanee el código del otro.
  Al terminar el día, vuelva a escanearlo y toque <b>Terminar recorrido</b>.</p></div>`;
let vehs = [], vmsg = "";
// status in the panel, from the live table: fuera de servicio (after Terminar recorrido), en pausa, or en servicio
const servicio = v => { const r = rows["d:" + v.id]; if (!r) return ` · <span class="vs">sin datos hoy</span>`;
  return r.estado === "fin" ? ` · <span class="vs off">Fuera de servicio desde ${esc(IncUtil.hora(r.fin_en || r.creado))}</span>`
    : r.estado === "pausa" ? ` · <span class="vs pa">En pausa</span>` : ` · <span class="vs on">En servicio</span>`; };
async function renderVeh(){
  const {data, error} = await sb.rpc("vehiculos");
  if (error) { vbody().innerHTML = `<p class="err">${/vehiculos|function|schema cache/i.test(error.message) ? "Falta correr la última versión de supabase/ubicaciones.sql." : esc(error.message)}</p>`; return; }
  vehs = data;
  vbody().innerHTML = `<p>Cada vehículo tiene su código QR. Imprímalo y péguelo en el vehículo: el conductor lo escanea con su celular y desde ese momento el celular envía la ubicación como ese vehículo.</p>
    <form class="vehadd"><input name="n" maxlength="40" placeholder="Móvil 20 - Ibagué" aria-label="Nombre del vehículo" required>
      <select name="c" aria-label="Tipo">${CLASES.map(([k, e, n]) => `<option value="${k}">${e} ${n}</option>`).join("")}</select>
      <button class="btn new">＋ Agregar</button></form>
    ${vmsg ? `<p>${vmsg}</p>` : ""}
    <ul class="vehlist">${vehs.map(v => `<li class="${v.activo ? "" : "off"}"><span class="vn"><span class="vi">${shape(v)}</span><b>${esc(v.nombre)}</b>${v.activo ? servicio(v) : " · desactivado"}</span>
      <span class="vb">${v.activo ? `<button type="button" class="btn" data-vqr="${v.id}">Código QR</button>` : ""}
      <select data-vclase="${v.id}" aria-label="Tipo de ${esc(v.nombre)}">${CLASES.map(([k, e]) => `<option value="${k}"${v.clase === k ? " selected" : ""}>${e}</option>`).join("")}</select>
      ${rows["d:" + v.id]?.estado === "fin" ? `<button type="button" class="btn" data-est="d:${v.id}" data-v="">▶ Reanudar</button>` : ""}
      ${v.activo ? "" : `<button type="button" class="btn" data-von="${v.id}" data-a="1">Activar</button>`}
      <button type="button" class="btn del" data-vdel="${v.id}">🗑 Eliminar</button></span></li>`).join("") || "<li>Aún no hay vehículos.</li>"}</ul>
    ${informeHtml()}`;
}
async function showQr(id, nueva = false){
  const v = vehs.find(x => x.id === id); if (!v) return;
  const {data:clave, error} = await sb.rpc("vehiculo_qr", {id, nueva});
  if (error) { vmsg = `<span class="err">${esc(error.message)}</span>`; return renderVeh(); }
  if (!clave) {
    vbody().innerHTML = `<p><b>${esc(v.nombre)}</b> se creó antes de los códigos QR y su clave no quedó guardada.</p>
      <p>Para hacer su QR se le da una clave nueva. El celular que hoy envía como ${esc(v.nombre)} con la clave anterior dejará de aparecer hasta escanear el QR nuevo.</p>
      <p><button type="button" class="btn new" data-vnew="${id}">Darle una clave nueva y hacer el QR</button> <button type="button" class="btn" data-vback>Volver</button></p>`;
    return;
  }
  const link = qrLink(v, clave), svg = await qrSvg(link);
  vbody().innerHTML = `${card(v, svg)}
    <p><button type="button" class="btn new" data-vprint="${id}">🖨 Imprimir</button> <button type="button" class="btn" data-vback>Volver</button></p>
    <p class="sub">Quien tenga este código puede enviar posiciones como ${esc(v.nombre)}. Si se pierde, desactive el vehículo o pídale clave nueva.</p>
    <details><summary>Enlace del código</summary><p><a href="${esc(link)}" target="_blank" rel="noopener">Abrir en este celular</a></p></details>`;
  vbody().dataset.print = card(v, await qrSvg(link, 420));
}
async function openVeh(qrId){
  vmsg = ""; vbody().innerHTML = "<p>Cargando…</p>"; if (!vdlg().open) vdlg().showModal();
  if (qrId) { await renderVeh(); await showQr(qrId); } else await cargarInforme();
}
function printQr(){
  const w = open("", "_blank"); if (!w) return alert("Permita las ventanas emergentes para imprimir.");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Código QR</title><style>
    body{margin:0;font:15px/1.45 system-ui,sans-serif;color:#000;display:grid;place-items:center;min-height:100vh}
    .vehcard{width:120mm;border:2px solid #000;border-radius:6mm;padding:8mm;text-align:center}
    .vhd{display:flex;gap:12px;align-items:center;justify-content:center;margin-bottom:6mm}.vhd svg{width:64px;height:40px}
    .vhd b{display:block;font-size:24px}.vhd span{font-size:12px}.vehcard>svg{width:90mm;height:90mm}
    @page{margin:10mm}</style>${vbody().dataset.print}<script>onload=()=>{print()}<\/script>`);
  w.document.close();
}
/* ---------------- "Kilómetros por semana": km of each vehicle per day, for Excel ---------------- */
const bogota = d => d.toLocaleDateString("en-CA", {timeZone:"America/Bogota"});   // "2026-11-25"
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = iso => { const wd = (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7; return addDays(iso, -wd); };
let inf = (() => { const m = monday(bogota(new Date())); return {desde:m, hasta:addDays(m, 6), filas:null, msg:""}; })();
const DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const diaCorto = iso => { const d = new Date(iso + "T12:00:00Z"); return `${DIAS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()}`; };
// columns: one per day for up to 14 days, else one per week (from Monday)
function tablaKm(filas, desde, hasta){
  const days = []; for (let d = desde; d <= hasta; d = addDays(d, 1)) days.push(d);
  const porSemana = days.length > 14;
  const cols = porSemana ? [...new Set(days.map(monday))] : days;
  const colOf = d => porSemana ? monday(d) : d;
  const veh = new Map();
  for (const f of filas) { const v = veh.get(f.clave) || {nombre:f.nombre, km:{}}; veh.set(f.clave, v);
    v.km[colOf(f.dia)] = (v.km[colOf(f.dia)] || 0) + f.km; }
  const list = [...veh.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", {numeric:true}));
  for (const v of list) v.total = Object.values(v.km).reduce((a, b) => a + b, 0);
  return {cols, porSemana, list};
}
function informeHtml(){
  const t = inf.filas ? tablaKm(inf.filas, inf.desde, inf.hasta) : null;
  const head = t ? t.cols.map(c => `<th>${t.porSemana ? "sem. " + diaCorto(c) : diaCorto(c)}</th>`).join("") : "";
  return `<h4 class="infh">📊 Kilómetros por semana</h4>
    <div class="infq"><label>Desde <input type="date" id="infd" value="${inf.desde}"></label><label>Hasta <input type="date" id="infh" value="${inf.hasta}"></label></div>
    <div class="infq"><button type="button" class="btn" data-inf="esta">Esta semana</button><button type="button" class="btn" data-inf="pasada">Semana pasada</button>
      <button type="button" class="btn" data-inf="ver">Ver</button><button type="button" class="btn new" data-inf="xls"${t?.list.length ? "" : " disabled"}>⬇ Descargar para Excel</button></div>
    ${inf.msg ? `<p>${inf.msg}</p>` : ""}
    ${t ? t.list.length ? `<div class="inft"><table><thead><tr><th>Vehículo</th>${head}<th>Total</th></tr></thead><tbody>
      ${t.list.map(v => `<tr><th>${esc(v.nombre)}</th>${t.cols.map(c => `<td>${v.km[c] ? nf(v.km[c]) : "–"}</td>`).join("")}<td><b>${nf(v.total)}</b></td></tr>`).join("")}
      </tbody></table></div><p class="sub">Km medidos por el GPS del celular de cada vehículo (hora Colombia).</p>`
      : `<p class="sub">No hay kilómetros registrados en esas fechas.</p>` : ""}`;
}
async function cargarInforme(){
  inf.msg = "Cargando…"; await renderVeh();
  const {data, error} = await sb.rpc("km_por_dia", {desde:inf.desde, hasta:inf.hasta});
  inf.filas = error ? null : data; inf.msg = error ? `<span class="err">${/km_por_dia|function|schema cache/i.test(error.message) ? "Falta correr la última versión de supabase/ubicaciones.sql." : esc(error.message)}</span>` : "";
  await renderVeh();
}
function descargarInforme(){
  const t = tablaKm(inf.filas || [], inf.desde, inf.hasta), n = v => String(Math.round(v * 10) / 10).replace(".", ",");
  const lines = [`Kilómetros por vehículo;${inf.desde} a ${inf.hasta}`, "",
    ["Vehículo", ...t.cols.map(c => (t.porSemana ? "Semana del " : "") + c), "Total km"].join(";"),
    ...t.list.map(v => [`"${v.nombre.replace(/"/g, '""')}"`, ...t.cols.map(c => v.km[c] ? n(v.km[c]) : "0"), n(v.total)].join(";")),
    ["Total", ...t.cols.map(c => n(t.list.reduce((a, v) => a + (v.km[c] || 0), 0))), n(t.list.reduce((a, v) => a + v.total, 0))].join(";")];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n") + "\r\n"], {type:"text/csv;charset=utf-8"}));   // BOM + ";" = columns in Excel in Spanish
  a.download = `km-vehiculos-${inf.desde}-a-${inf.hasta}.csv`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
if (vbtn) {
  vbtn.addEventListener("click", () => openVeh());
  document.addEventListener("submit", async e => { const f = e.target.closest?.(".vehadd"); if (!f) return; e.preventDefault();
    const {data:id, error} = await sb.rpc("crear_vehiculo", {nombre:f.n.value.trim(), clase:f.c.value});
    vmsg = error ? `<span class="err">${esc(error.message)}</span>` : "";
    await renderVeh(); if (!error) showQr(id); });
  document.addEventListener("change", async e => { const sel = e.target.closest?.("[data-vclase]"); if (!sel) return;
    const {error} = await sb.rpc("clase_vehiculo", {id:+sel.dataset.vclase, clase:sel.value});
    vmsg = error ? `<span class="err">${esc(error.message)}</span>` : ""; renderVeh(); });
  document.addEventListener("click", async e => {
    if (!e.target.closest?.("#vehb")) return;
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.inf) { const k = b.dataset.inf;
      if (k === "esta" || k === "pasada") { const m = monday(bogota(new Date())), d = k === "esta" ? m : addDays(m, -7); inf.desde = d; inf.hasta = addDays(d, 6); }
      else { inf.desde = vbody().querySelector("#infd").value || inf.desde; inf.hasta = vbody().querySelector("#infh").value || inf.hasta; }
      if (inf.hasta < inf.desde) [inf.desde, inf.hasta] = [inf.hasta, inf.desde];
      if (k === "xls") return descargarInforme();
      return cargarInforme(); }
    if (b.dataset.vqr) showQr(+b.dataset.vqr);
    else if (b.dataset.vnew) showQr(+b.dataset.vnew, true);
    else if (b.dataset.vprint) printQr();
    else if ("vback" in b.dataset) renderVeh();
    else if (b.dataset.vdel) { const v = vehs.find(x => x.id === +b.dataset.vdel);
      if (!confirm(`¿Eliminar ${v?.nombre}?\n\nSe borra el vehículo y su código QR deja de servir. No se puede deshacer.\nSus km de días pasados se conservan en el informe semanal.`)) return;
      const {error} = await sb.rpc("eliminar_vehiculo", {id:+b.dataset.vdel});
      vmsg = error ? `<span class="err">${/eliminar_vehiculo|function|schema cache/i.test(error.message) ? "Falta correr la última versión de supabase/ubicaciones.sql." : esc(error.message)}</span>` : `${esc(v?.nombre)} se eliminó.`;
      if (!error) drop("d:" + v.id); renderVeh(); }
    else if (b.dataset.von) { const on = b.dataset.a === "1", v = vehs.find(x => x.id === +b.dataset.von);
      if (!on && !confirm(`¿Desactivar ${v?.nombre}? Su celular dejará de aparecer en el mapa.`)) return;
      const {error} = await sb.rpc("activar_vehiculo", {id:+b.dataset.von, activo:on});
      vmsg = error ? `<span class="err">${esc(error.message)}</span>` : ""; renderVeh(); }
  });
}

// button only for the signed-in team; resume sharing after a reload if it was on and the permission stands
const auth = async () => {
  const u = IncStore.user();
  if (btn) btn.hidden = !u;
  if (vbtn) vbtn.hidden = !u;
  if (!u) { if (sharing()) stop(false); return; }
  if (ls.get(ON_KEY) && !sharing()) {
    let ok = false; try { ok = (await navigator.permissions?.query({name:"geolocation"}))?.state === "granted"; } catch {}
    if (ok) start(); else { ls.set(ON_KEY, null); flush(); }
  } else flush();
  paint();
};
IncStore.ready().then(auth).catch(() => {}); IncStore.onAuth(auth);
})();
