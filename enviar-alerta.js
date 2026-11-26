// "📣 Enviar alerta" window (signed-in team only), shared by the dashboard and the event page.
// Sends a push notification to the phones subscribed with "🔔 Recibir alertas" (Edge Function enviar-alerta)
// and/or an SMS to the people signed up on sms.html (Edge Function enviar-sms, Inalambria Express).
// window.SATAlert.compose({title, body, url, tag}, note) opens it, empty or prefilled from an event.
(() => {
if (typeof IncStore === "undefined" || !IncStore.remote) return;
const PREFIX = "Cruz Roja Tolima: ";
const SMS_MAX = 160;      // one SMS; longer texts may be charged as more than one
const SMS_PRECIO = 39;    // COP per SMS, Inalambria "Starter" list price (Nov 2026); cheaper on bigger top-ups
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"})[c]);
const cop = n => "$" + Math.round(n).toLocaleString("es-CO");
// SMS text: no emojis, and plain punctuation instead of "·" and "–" (they can make the SMS cost more)
const noEmoji = s => String(s || "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s*\u00B7\s*/g, ", ")
  .replace(/[\u2013\u2014]/g, "-").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").trim();

const st = document.createElement("style");
st.textContent = `#sadlg{max-width:min(560px,calc(100vw - 24px));width:100%;box-sizing:border-box;border:1px solid var(--line,#ccc);border-radius:12px;
  background:var(--panel,#fff);color:var(--fg,#111);padding:16px 18px;font:14px/1.5 system-ui,sans-serif}
#sadlg::backdrop{background:#0008} #sadlg h3{margin:0 0 6px;font-size:17px} #sadlg p{margin:6px 0}
#sadlg label.f{display:grid;gap:4px;margin:8px 0} #sadlg .m{color:var(--muted,#666);font-size:13px}
#sadlg input[type=text],#sadlg input[type=tel],#sadlg textarea{font:inherit;width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line,#ccc);border-radius:6px;background:var(--bg,#fff);color:var(--fg,#111)}
#sadlg fieldset{border:1px solid var(--line,#ccc);border-radius:8px;padding:8px 10px;margin:10px 0;display:grid;gap:6px}
#sadlg legend{font-weight:600;padding:0 4px} #sadlg .ch{display:flex;gap:8px;align-items:center;font-weight:600}
#sadlg .ch input{width:18px;height:18px;accent-color:#c8102e} #sadlg .bad{color:#b83a3a;font-weight:600} #sadlg .ok{color:#2f8f6b;font-weight:600}
#sadlg .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center} #sadlg .row input{flex:1;min-width:140px}
#sadlg .go{background:#c8102e;border-color:#c8102e;color:#fff;font-weight:600} #sadlg .foot{display:flex;justify-content:flex-end;margin-top:10px}`;
document.head.appendChild(st);
const dlg = document.createElement("dialog");
dlg.id = "sadlg"; dlg.setAttribute("aria-labelledby", "sat_t");
dlg.innerHTML = `<form method="dialog"><h3 id="sat_t">Enviar alerta</h3><div id="sab_"></div>
  <div class="foot"><button class="btn">Cerrar</button></div></form>`;
document.body.appendChild(dlg);
const body = dlg.querySelector("#sab_"), $ = s => body.querySelector(s);
let target = {url:"./"}, info = null, lastJobs = [];

function smsText(){ return $("#sa_sms").value.replace(/\s+/g, " ").trim(); }
function smsCount(){
  const t = smsText(), n = (PREFIX + t).length, c = $("#sa_cnt");
  c.innerHTML = `${n} de ${SMS_MAX} caracteres, contando «${esc(PREFIX.trim())}» al inicio`
    + (n > SMS_MAX ? ` · <span class="bad">muy largo: puede cobrarse como más de un SMS. Acórtelo.</span>` : "");
}
function showInfo(){
  const el = $("#sa_info"); if (!el) return;
  if (!info) { el.textContent = "Consultando inscritos y saldo…"; return; }
  if (info.error) { el.innerHTML = `<span class="bad">${esc(info.error)}</span>`; return; }
  const b = info.saldo || {}, saldo = [b.balance, b.credits, b.saldo, b.amount].find(v => typeof v === "number" || typeof v === "string");
  el.innerHTML = `<b>${info.inscritos}</b> persona(s) inscrita(s) para SMS · costo estimado <b>${cop(info.inscritos * SMS_PRECIO)}</b> COP`
    + (saldo != null ? ` · saldo en Inalambria: <b>${esc(typeof saldo === "number" ? cop(saldo) : saldo)}</b>` : "")
    + (info.aviso ? `<br><span class="bad">${esc(info.aviso)}</span>` : "")
    + (info.inscritos ? "" : `<br>Nadie se ha inscrito todavía: comparta el enlace <a href="sms.html" target="_blank">sms.html</a>.`);
}
function sync(){ $("#sa_smsbox").hidden = !$("#sa_csms").checked; $("#sa_pushbox").hidden = !$("#sa_cpush").checked;
  if ($("#sa_csms").checked && !info) IncStore.smsInfo().then(r => info = r, e => info = {error:e.message}).then(showInfo); }

function compose(pre = {}, note = ""){
  target = {url:pre.url || "./", tag:pre.tag};
  info = null;
  dlg.querySelector("#sat_t").textContent = pre.title ? "Enviar evento como alerta" : "Enviar alerta";
  const sms = noEmoji([pre.title, (pre.body || "").split("\n")[0]].filter(Boolean).join(". ")).slice(0, SMS_MAX - PREFIX.length);
  body.innerHTML = `${note ? `<p class="ok">${esc(note)}</p>` : ""}
    <label class="ch"><input type="checkbox" id="sa_cpush" checked> Notificación en los celulares con el tablero (gratis)</label>
    <label class="ch"><input type="checkbox" id="sa_csms"> SMS a las personas inscritas (con costo)</label>
    <fieldset id="sa_pushbox"><legend>Notificación</legend>
      <label class="f"><span>Título</span><input type="text" id="sa_t" maxlength="120" placeholder="🚨 Cierre de la vía Ibagué–Cajamarca" value="${esc(pre.title)}"></label>
      <label class="f"><span>Mensaje</span><textarea id="sa_b" rows="3" maxlength="400" placeholder="Qué pasa, dónde y qué hacer">${esc(pre.body)}</textarea></label>
      ${pre.url && pre.url !== "./" ? `<p class="m">Al tocarla se abre el seguimiento del evento.</p>` : ""}
    </fieldset>
    <fieldset id="sa_smsbox" hidden><legend>SMS</legend>
      <label class="f"><span>Texto del SMS (corto, sin emojis)</span><textarea id="sa_sms" rows="3" maxlength="300">${esc(sms)}</textarea></label>
      <p class="m" id="sa_cnt"></p>
      <p class="m" id="sa_info"></p>
      <div class="row"><input type="tel" id="sa_tel" inputmode="tel" placeholder="Probar con un número: 300 123 4567">
        <button type="button" class="btn" data-x="test">Enviar prueba</button></div>
    </fieldset>
    <p class="row"><button type="button" class="btn go" data-x="go">Enviar</button><span id="sa_msg" role="status"></span></p>`;
  smsCount(); showInfo();
  if (!dlg.open) dlg.showModal();
}
body.addEventListener("input", e => { if (e.target.id === "sa_sms") smsCount(); });
body.addEventListener("change", e => { if (e.target.id === "sa_cpush" || e.target.id === "sa_csms") sync(); });
const say = (html) => { $("#sa_msg").innerHTML = html; };
const jobsLine = jobs => jobs.filter(Boolean).length ? ` <button type="button" class="btn" data-x="estado">Ver estado de entrega</button>` : "";

body.addEventListener("click", async e => {
  const x = e.target.closest("[data-x]")?.dataset.x; if (!x) return;
  const b = e.target; b.disabled = true;
  try {
    if (x === "test") {
      if (!smsText()) throw new Error("Escriba el texto del SMS");
      const r = await IncStore.sendSms({texto:smsText(), prueba:$("#sa_tel").value});
      lastJobs = r.trabajos || [];
      say(`<span class="ok">SMS de prueba enviado a ${esc($("#sa_tel").value)}.</span>${jobsLine(lastJobs)}`);
    }
    if (x === "estado") {
      const out = await Promise.all(lastJobs.filter(Boolean).map(j => IncStore.smsStatus(j).catch(err => ({status:err.message}))));
      say(out.map(o => esc(`Estado: ${o.status ?? JSON.stringify(o)}`)).join("<br>") + jobsLine(lastJobs)
        + `<br><span class="m">El detalle por número está en Inalambria > Historial de envíos.</span>`);
    }
    if (x === "go") {
      const push = $("#sa_cpush").checked, sms = $("#sa_csms").checked, out = [];
      if (!push && !sms) throw new Error("Elija notificación, SMS o ambos");
      const t = $("#sa_t").value.trim();
      if (push && !t) throw new Error("Escriba el título de la notificación");
      if (sms && !smsText()) throw new Error("Escriba el texto del SMS");
      if (sms && info && !info.error && !confirm(`Se enviará un SMS a ${info.inscritos} persona(s), costo estimado ${cop(info.inscritos * SMS_PRECIO)} COP. ¿Enviar?`)) { b.disabled = false; return; }
      say("Enviando…");
      if (push) try {
        const r = await IncStore.sendAlert({title:t, body:$("#sa_b").value.trim(), ...target});
        out.push(r.suscritos === 0 ? `<span class="bad">Notificación: no hay celulares suscritos todavía (toque «🔔 Recibir alertas» en cada celular).</span>`
          : `<span class="ok">Notificación enviada a ${r.enviadas} de ${r.suscritos} celular(es)${r.errores ? `, ${r.errores} con error` : ""}.</span>`);
      } catch (err) { out.push(`<span class="bad">Notificación: no se pudo enviar (${esc(err.message)}).</span>`); }
      if (sms) try {
        const r = await IncStore.sendSms({texto:smsText()}); lastJobs = r.trabajos || [];
        out.push(r.destinatarios === 0 ? `<span class="bad">SMS: nadie se ha inscrito todavía.</span>`
          : `<span class="ok">SMS enviado a ${r.destinatarios} persona(s).</span>${jobsLine(lastJobs)}`);
      } catch (err) { out.push(`<span class="bad">SMS: no se pudo enviar (${esc(err.message)}).</span>`); }
      say(out.join("<br>"));
    }
  } catch (err) { say(`<span class="bad">${esc(err.message)}</span>`); }
  b.disabled = false;
});

window.SATAlert = {compose};
// header button on the dashboard
const send = document.getElementById("sendalertbtn");
if (send) {
  const show = () => { send.hidden = !IncStore.user(); };
  IncStore.ready().then(show); IncStore.onAuth(show);
  send.addEventListener("click", () => compose());
}
})();
