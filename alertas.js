// "Alertas" button: subscribes this phone to the rain alerts (web push). The subscription is saved in
// Supabase through the push_alta function (supabase/alertas.sql); the scheduled job
// tools/alertas_lluvia.mjs sends the alerts. Needs INC_CONFIG from incstore.js.
(() => {
const VAPID_PUBLIC = "BHptJ4vGEtmTNRtFbPCjFZ5aYiAco_3RkrKJ-UxYxefNHBoDwY8cMRoG1I4xd6d9G60ESylpd8NZT2sPcb8golQ";
const btn = document.getElementById("alertbtn"), dlg = document.getElementById("alertdlg");
if (!btn || !dlg) return;
const body = dlg.querySelector("#alertb");
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const cfg = typeof INC_CONFIG !== "undefined" ? INC_CONFIG : {};
let umbrales = null;

const reg = supported ? navigator.serviceWorker.register("sw.js").catch(() => null) : Promise.resolve(null);

async function rpc(fn, args){
  const r = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {method:"POST",
    headers:{apikey:cfg.key, Authorization:"Bearer " + cfg.key, "Content-Type":"application/json"}, body:JSON.stringify(args)});
  if (!r.ok) throw new Error("el servidor respondió " + r.status);
}
const b64 = s => { s = (s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function current(){ const r = await reg; return r ? r.pushManager.getSubscription() : null; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"})[c]);

async function setLabel(){
  const on = !!(await current()) && Notification.permission === "granted";
  btn.textContent = on ? "🔔 Alertas activas" : "🔔 Recibir alertas";
  btn.setAttribute("aria-pressed", on);
}

async function render(msg = ""){
  if (!umbrales) umbrales = await fetch("data/umbrales-lluvia.json", {cache:"no-cache"}).then(r => r.json()).catch(() => null);
  const d = umbrales?.defecto || {};
  const rule = umbrales ? `<p>Avisa cuando una estación del IDEAM en el Tolima acumula
    ${umbrales.ventanas.filter(h => d[h] != null).map(h => `<b>${d[h]} mm en ${h} h</b>`).join(" o ")}${Object.keys(umbrales.municipios || {}).length + Object.keys(umbrales.estaciones || {}).length ? " (algunos municipios o estaciones tienen su propio umbral)" : ""}.
    Avisa una vez y vuelve a avisar solo si la lluvia baja y luego supera otra vez el umbral.
    La alerta llega tan pronto como el IDEAM publica el dato, que a veces tarda una hora o más.</p>` : "";
  let html = rule;
  if (!cfg.url) html += `<p class="err">Las alertas necesitan la conexión a Supabase (incstore.js).</p>`;
  else if (ios && !standalone) html += `<p><b>En iPhone primero hay que instalar el tablero:</b></p>
    <ol><li>Abra esta página en <b>Safari</b>.</li><li>Toque <b>Compartir</b> (el cuadro con la flecha hacia arriba).</li>
    <li>Elija <b>Añadir a pantalla de inicio</b> y toque <b>Añadir</b>.</li>
    <li>Abra el tablero desde el nuevo ícono de Cruz Roja Tolima y toque otra vez <b>🔔 Recibir alertas</b>.</li></ol>
    <p>Necesita iOS 16.4 o más reciente (Ajustes &gt; General &gt; Información).</p>`;
  else if (!supported) html += `<p class="err">Este navegador no recibe notificaciones. En Android use Chrome; en iPhone, Safari con iOS 16.4 o más reciente.</p>`;
  else if (Notification.permission === "denied") html += `<p class="err">Las notificaciones están bloqueadas para este sitio.
    ${ios ? "Actívelas en Ajustes &gt; Notificaciones &gt; Cruz Roja Tolima." : "Permítalas en la configuración del sitio (el candado junto a la dirección)."}</p>`;
  else if (await current()) html += `<p><b>Este celular está recibiendo las alertas.</b></p>
    <p><button type="button" class="btn" data-a="test">Enviar una prueba a este celular</button>
    <button type="button" class="btn" data-a="off">Desactivar</button></p>`;
  else html += `<p><button type="button" class="btn new" data-a="on">🔔 Activar alertas en este celular</button></p>
    <p style="color:var(--muted)">El celular le pedirá permiso para mostrar notificaciones. No se guarda su nombre ni su número.</p>`;
  if (msg) html += `<p>${msg}</p>`;
  body.innerHTML = html;
}

async function subscribe(){
  if (await Notification.requestPermission() !== "granted") return render("No se dio permiso para notificaciones.");
  const r = await reg; if (!r) throw new Error("no se pudo instalar el servicio de notificaciones");
  await navigator.serviceWorker.ready;
  const sub = await r.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64(VAPID_PUBLIC)});
  const j = sub.toJSON();
  await rpc("push_alta", {endpoint:j.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth, agente:navigator.userAgent});
  await r.showNotification("Alertas de lluvia activadas", {body:"Así se verán los avisos de lluvia fuerte del IDEAM.", icon:"icon-192.png", tag:"prueba"});
  await render("Listo. Le llegará un aviso cuando una estación supere el umbral.");
}

body.addEventListener("click", async e => {
  const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
  e.target.disabled = true;
  try {
    if (a === "on") await subscribe();
    if (a === "test") { const r = await reg; await r.showNotification("Prueba de alerta", {body:"⚠ Estación Ejemplo (Ibagué): 62 mm en 24 h (umbral 50 mm)", icon:"icon-192.png", tag:"prueba"}); await render(); }
    if (a === "off") { const s = await current(); if (s) { await rpc("push_baja", {endpoint:s.endpoint}).catch(() => {}); await s.unsubscribe(); } await render("Alertas desactivadas en este celular."); }
  } catch (err) { await render(`<span class="err">No se pudo completar: ${esc(err.message)}</span>`); }
  setLabel();
});

btn.addEventListener("click", async () => { dlg.querySelector("#alertt").textContent = "Alertas al celular"; await render(); dlg.showModal(); });

// "📣 Enviar alerta" (signed-in team only): free-text alert to every subscribed phone
const send = document.getElementById("sendalertbtn");
if (send && typeof IncStore !== "undefined" && IncStore.remote) {
  const show = () => { send.hidden = !IncStore.user(); };
  IncStore.ready().then(show); IncStore.onAuth(show);
  send.addEventListener("click", () => {
    dlg.querySelector("#alertt").textContent = "Enviar alerta a los celulares";
    body.innerHTML = `<p>Llega a todos los celulares que activaron las alertas. Úsela para avisos importantes.</p>
      <label><span>Título</span><input id="sat" maxlength="120" placeholder="🚨 Cierre de la vía Ibagué–Cajamarca"></label>
      <label><span>Mensaje</span><textarea id="sab" rows="3" maxlength="400" placeholder="Qué pasa, dónde y qué hacer"></textarea></label>
      <p><button type="button" class="btn new" data-s="go">Enviar a todos</button> <span id="sam" role="status"></span></p>`;
    dlg.showModal();
  });
  body.addEventListener("click", async e => {
    if (!e.target.closest("[data-s=go]")) return;
    const t = body.querySelector("#sat").value.trim(), m = body.querySelector("#sam");
    if (!t) { m.innerHTML = `<span class="err">Escriba un título.</span>`; return; }
    e.target.disabled = true; m.textContent = "Enviando…";
    try { const r = await IncStore.sendAlert({title:t, body:body.querySelector("#sab").value.trim(), url:"./"});
      m.textContent = `Enviada a ${r.enviadas} celular(es)${r.errores ? `, ${r.errores} con error` : ""}.`; }
    catch (err) { m.innerHTML = `<span class="err">No se pudo enviar: ${esc(err.message)}</span>`; }
    e.target.disabled = false;
  });
}
// keep Supabase in sync if the browser renewed the subscription keys
current().then(s => { if (s && cfg.url) { const j = s.toJSON(); rpc("push_alta", {endpoint:j.endpoint, p256dh:j.keys.p256dh, auth:j.keys.auth, agente:navigator.userAgent}).catch(() => {}); } });
if (supported) setLabel();
})();
