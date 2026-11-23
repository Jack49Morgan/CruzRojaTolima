// Incident store shared by the dashboard (index.html) and the incident form (incidente.html).
//
// With INC_CONFIG filled in, incidents, their timeline of updates and their photos/videos live in
// Supabase, so every phone and computer that signs in sees and updates the same incidents.
// With INC_CONFIG empty, everything stays in this browser (IndexedDB), as before.
//
// Setup steps: supabase/LEEME.md. The anon key is meant to be public; access is controlled by
// sign-in plus the row-level security rules in supabase/schema.sql.
const INC_CONFIG = {
  url: "https://hxwntvubhxahzsfhxgav.supabase.co",
  key: "sb_publishable_2pHCd189amDjitNxYtalsw_1bnILR_Y",   // publishable (public) key
};

const INC_TIPOS = {
  inundacion:   ["Inundación", "#1f6fb2"],
  avenida:      ["Avenida torrencial", "#0b2a5b"],
  deslizamiento:["Deslizamiento / movimiento en masa", "#8d5524"],
  vendaval:     ["Vendaval", "#6b5ca5"],
  incendio:     ["Incendio forestal", "#e65100"],
  volcan:       ["Actividad volcánica", "#5d4037"],
  sismo:        ["Sismo", "#455a64"],
  accidente:    ["Accidente / emergencia", "#c8102e"],
  otro:         ["Otro", "#616161"],
};
const INC_ESTADOS = {activo:"Activo", atencion:"En atención", controlado:"Controlado", cerrado:"Cerrado"};
const INC_AFECT_KEYS = ["fallecidos", "heridos", "personas", "familias", "viviendas"];   // counts kept on each incident
const INC_MAX_MB = 50;
const INC_VERSION = 13;   // bump with each change to the incident pages, so phones load the new page instead of a cached copy   // Supabase free plan: 50 MB per file

// Common interface (both stores):
//   remote, ready(), user(), signIn(email, pw), signOut(), onAuth(fn)
//   list(), get(id), save(inc, add, drop), remove(id)
//   media(incId) -> [{id,name,type,url,updId}]
//   updates(incId) -> oldest first; allUpdates() -> every update, newest first
//   addUpdate(incId, {texto, estado, afectados}, files) ; removeUpdate(upd)
//   onChange(fn)
// "add" items are {id,name,type,blob}; "drop" is a list of media ids.
const IncUtil = {
  uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  esc: s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])),
  // "hace 5 min", "hace 3 h", else a Colombian date and time
  ago: iso => { if (!iso) return ""; const d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s < 60) return "hace un momento"; if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return d.toLocaleString("es-CO", {timeZone:"America/Bogota", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"}); },
  // time of an update: "10:24" today, "ayer 18:05", else "21 nov 10:24" (Colombia time)
  hora: iso => { if (!iso) return ""; const tz = {timeZone:"America/Bogota"}, d = new Date(iso);
    const day = x => x.toLocaleDateString("en-CA", tz), hm = d.toLocaleTimeString("es-CO", {...tz, hour:"2-digit", minute:"2-digit", hour12:false});
    if (day(d) === day(new Date())) return hm;
    if (day(d) === day(new Date(Date.now() - 864e5))) return "ayer " + hm;
    return d.toLocaleDateString("es-CO", {...tz, day:"numeric", month:"short"}).replace(".", "") + " " + hm; },
  // photo → JPEG at most 1600 px wide/high; videos, GIFs and small images are left as they are
  shrink: async blob => {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(blob.type || "") || blob.size < 500e3) return blob;
    try {
      const bmp = await createImageBitmap(blob, {imageOrientation:"from-image"});
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
      return out && out.size < blob.size ? out : blob;
    } catch { return blob; }
  },
  when: iso => iso ? new Date(iso).toLocaleString("es-CO", {timeZone:"America/Bogota", day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"}) : "",
  afect: a => INC_AFECT_KEYS.filter(k => a?.[k] != null).map(k => `${a[k]} ${a[k] === 1 ? k.slice(0, -1) : k}`).join(" · "),
};

function incLocalStore(){
  const DB = "sat-tolima", V = 2;
  let dbp = null;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("inc")) d.createObjectStore("inc", {keyPath:"id"});
      if (!d.objectStoreNames.contains("media")) d.createObjectStore("media", {keyPath:"id"}).createIndex("inc", "incId");
      if (!d.objectStoreNames.contains("upd")) d.createObjectStore("upd", {keyPath:"id"}).createIndex("inc", "incId");
    };
    // another tab still running an older copy of the page can block the upgrade forever: give up after 4 s
    const tm = setTimeout(() => { dbp = null; rej(new Error("Cierre las otras pestañas del tablero o del formulario y recargue.")); }, 4000);
    r.onblocked = () => {};
    r.onsuccess = () => { clearTimeout(tm); const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
    r.onerror = () => { clearTimeout(tm); dbp = null; rej(r.error); };
  });
  const tx = async (stores, mode, fn) => { const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(stores, mode); let out;
      Promise.resolve(fn(t)).then(v => out = v);
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const chan = "BroadcastChannel" in self ? new BroadcastChannel("sat-tolima-inc") : null;
  const ping = () => { chan?.postMessage("changed"); try { localStorage.setItem("sat-tolima-inc", String(Date.now())); } catch {} };
  const urls = new Map();   // media id -> object URL, reused so re-renders don't leak
  const toUrl = m => { if (!urls.has(m.id)) urls.set(m.id, URL.createObjectURL(m.blob));
    return {id:m.id, name:m.name, type:m.type, updId:m.updId || null, url:urls.get(m.id), blob:m.blob}; };
  const S = {
    remote:false,
    ready: async () => null, user: () => null, onAuth: () => {}, signIn: async () => {}, signOut: async () => {},
    list: () => tx(["inc"], "readonly", t => req(t.objectStore("inc").getAll()))
      .then(a => a.sort((x, y) => (y.fecha || "").localeCompare(x.fecha || ""))),
    get: id => tx(["inc"], "readonly", t => req(t.objectStore("inc").get(id))),
    save: async (inc, add = [], drop = []) => {
      inc.actualizado = new Date().toISOString(); inc.creado ??= inc.actualizado;
      await tx(["inc", "media"], "readwrite", t => {
        const m = t.objectStore("media");
        for (const f of add) m.put({...f, incId:inc.id});
        for (const id of drop) m.delete(id);
        t.objectStore("inc").put(inc);
      });
      ping(); return inc;
    },
    remove: async id => {
      const [mk, uk] = await tx(["media", "upd"], "readonly", t => Promise.all([
        req(t.objectStore("media").index("inc").getAllKeys(id)), req(t.objectStore("upd").index("inc").getAllKeys(id))]));
      await tx(["inc", "media", "upd"], "readwrite", t => { t.objectStore("inc").delete(id);
        for (const k of mk) t.objectStore("media").delete(k); for (const k of uk) t.objectStore("upd").delete(k); });
      ping();
    },
    media: incId => tx(["media"], "readonly", t => req(t.objectStore("media").index("inc").getAll(incId))).then(a => a.map(toUrl)),
    mediaFor: async ids => Object.fromEntries(await Promise.all(ids.map(async id => [id, await S.media(id)]))),
    updates: incId => tx(["upd"], "readonly", t => req(t.objectStore("upd").index("inc").getAll(incId)))
      .then(a => a.sort((x, y) => x.creado.localeCompare(y.creado))),
    allUpdates: () => tx(["upd"], "readonly", t => req(t.objectStore("upd").getAll()))
      .then(a => a.sort((x, y) => y.creado.localeCompare(x.creado))),
    addUpdate: async (incId, u, files = []) => {
      const inc = await S.get(incId); if (!inc) throw new Error("El evento ya no existe.");
      const upd = {id:IncUtil.uid(), incId, creado:new Date().toISOString(), autor:null,
        texto:u.texto || "", estado:u.estado || null, afectados:u.afectados || null};
      if (upd.estado) inc.estado = upd.estado;
      if (upd.afectados) inc.afectados = {...inc.afectados, ...upd.afectados};
      inc.actualizado = upd.creado;
      await tx(["inc", "media", "upd"], "readwrite", t => {
        t.objectStore("upd").put(upd); t.objectStore("inc").put(inc);
        for (const f of files) t.objectStore("media").put({...f, incId, updId:upd.id});
      });
      ping(); return upd;
    },
    removeUpdate: async upd => {
      const mk = (await S.media(upd.incId)).filter(m => m.updId === upd.id).map(m => m.id);
      await tx(["upd", "media"], "readwrite", t => { t.objectStore("upd").delete(upd.id); for (const k of mk) t.objectStore("media").delete(k); });
      ping();
    },
    onChange: fn => { chan?.addEventListener("message", fn);
      addEventListener("storage", e => { if (e.key === "sat-tolima-inc") fn(); }); },
  };
  return S;
}

function incSupabaseStore(cfg){
  const sb = supabase.createClient(cfg.url, cfg.key, {auth:{persistSession:true, autoRefreshToken:true, storageKey:"sat-tolima-auth",
    // supabase-js serialises auth calls across tabs with a browser lock; with the dashboard and the form open
    // at once that lock can stall every request for several seconds. A no-op lock avoids it.
    lock:async (name, timeout, fn) => fn()}});
  const BUCKET = "incidentes";
  let session = null, authFns = [], changeFns = [], channel = null;
  const fire = () => changeFns.forEach(f => { try { f(); } catch {} });
  const listen = () => {
    if (channel || !session) return;
    channel = sb.channel("incidentes-cambios");
    for (const table of ["incidentes", "actualizaciones", "medios"])
      channel.on("postgres_changes", {event:"*", schema:"public", table}, fire);
    channel.subscribe();
  };
  const ready = (async () => { const {data} = await sb.auth.getSession(); session = data.session; listen(); return session; })();
  sb.auth.onAuthStateChange((ev, s) => {
    const was = !!session; session = s;
    if (s) listen(); else if (channel) { sb.removeChannel(channel); channel = null; }
    if (was !== !!s) authFns.forEach(f => f(s));
  });
  const signedCache = {};
  // signed out = public read-only view: only these columns are readable (no team e-mails), no photos
  const PUB = {incidentes:"id,datos,estado,afectados,fecha,creado,actualizado", actualizaciones:"id,incidente_id,creado,texto,estado,afectados"};
  const cols = t => session ? "*" : PUB[t];
  const ok = ({data, error}) => { if (error) throw new Error(error.message || String(error)); return data; };
  const who = () => session?.user?.email || null;
  const safe = n => (n || "archivo").normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-80);
  const fromRow = r => ({...r.datos, id:r.id, estado:r.estado ?? r.datos.estado, afectados:r.afectados ?? r.datos.afectados,
    creado:r.creado, actualizado:r.actualizado, autor:r.autor});
  const upload = async (incId, files, updId = null) => {
    const rows = [];
    // photos are shrunk first (a phone photo of 4 MB becomes ~300 KB), then everything uploads in parallel
    await Promise.all(files.map(async f => {
      const blob = await IncUtil.shrink(f.blob), type = blob === f.blob ? f.type : "image/jpeg";
      const name = blob === f.blob ? f.name : f.name.replace(/\.[^.]*$/, "") + ".jpg";
      const ruta = `${incId}/${f.id}-${safe(name)}`;
      ok(await sb.storage.from(BUCKET).upload(ruta, blob, {contentType:type || "application/octet-stream", upsert:true}));
      rows.push({id:f.id, incidente_id:incId, actualizacion_id:updId, ruta, nombre:name, tipo:type});
    }));
    if (rows.length) ok(await sb.from("medios").insert(rows));
  };
  const dropMedia = async rows => {
    if (!rows.length) return;
    ok(await sb.storage.from(BUCKET).remove(rows.map(r => r.ruta)));
    ok(await sb.from("medios").delete().in("id", rows.map(r => r.id)));
  };
  const S = {
    remote:true,
    ready: () => ready, user: who,
    onAuth: fn => authFns.push(fn),
    signIn: async (email, password) => { session = ok(await sb.auth.signInWithPassword({email, password})).session; listen(); authFns.forEach(f => f(session)); },
    signOut: async () => { await sb.auth.signOut(); },
    list: async () => ok(await sb.from("incidentes").select(cols("incidentes")).order("fecha", {ascending:false})).map(fromRow),
    get: async id => { const r = ok(await sb.from("incidentes").select(cols("incidentes")).eq("id", id).maybeSingle()); return r ? fromRow(r) : null; },
    save: async (inc, add = [], drop = []) => {
      const {id, estado, afectados, fecha, creado, actualizado, autor, ...datos} = inc;
      const isNew = !creado;
      const row = {id, estado, afectados, fecha, datos:{...datos, fecha}, actualizado:new Date().toISOString()};
      if (isNew) row.autor = who();
      // the row comes back with its server dates, so no second read is needed
      const saved = ok(await sb.from("incidentes").upsert(row).select().single());   // must exist before its photos
      await Promise.all([drop.length ? sb.from("medios").select("id,ruta").in("id", drop).then(ok).then(dropMedia) : null, upload(id, add)]);
      return {...inc, ...fromRow(saved)};
    },
    remove: async id => {
      await dropMedia(ok(await sb.from("medios").select("id,ruta").eq("incidente_id", id)));
      ok(await sb.from("incidentes").delete().eq("id", id));   // updates go with it (on delete cascade)
    },
    media: async incId => (await S.mediaFor([incId]))[incId] || [],
    // media of several events in two requests; signed links are reused for 5 hours instead of asked for again
    mediaFor: async ids => {
      if (!ids.length || !session) return {};
      const rows = ok(await sb.from("medios").select("*").in("incidente_id", ids).order("creado"));
      const need = rows.map(r => r.ruta).filter(p => !(signedCache[p]?.until > Date.now()));
      if (need.length) for (const x of ok(await sb.storage.from(BUCKET).createSignedUrls(need, 6 * 3600)))
        if (x.signedUrl) signedCache[x.path] = {url:x.signedUrl, until:Date.now() + 5 * 3600e3};
      const out = {};
      for (const r of rows) (out[r.incidente_id] ??= []).push({id:r.id, name:r.nombre, type:r.tipo || "", updId:r.actualizacion_id, url:signedCache[r.ruta]?.url, ruta:r.ruta});
      return out;
    },
    updates: async incId => ok(await sb.from("actualizaciones").select(cols("actualizaciones")).eq("incidente_id", incId).order("creado"))
      .map(r => ({...r, incId:r.incidente_id})),
    allUpdates: async () => ok(await sb.from("actualizaciones").select(cols("actualizaciones")).order("creado", {ascending:false}).limit(500))
      .map(r => ({...r, incId:r.incidente_id})),
    addUpdate: async (incId, u, files = []) => {
      const upd = {id:IncUtil.uid(), incidente_id:incId, autor:who(), texto:u.texto || "", estado:u.estado || null, afectados:u.afectados || null};
      const patch = {actualizado:new Date().toISOString()};
      if (upd.estado) patch.estado = upd.estado;
      if (upd.afectados) { const cur = await S.get(incId); patch.afectados = {...cur?.afectados, ...upd.afectados}; }
      ok(await sb.from("actualizaciones").insert(upd));   // first, so the photos below can point to it
      await Promise.all([sb.from("incidentes").update(patch).eq("id", incId).then(ok), upload(incId, files, upd.id)]);
      return upd;
    },
    removeUpdate: async upd => {
      await dropMedia(ok(await sb.from("medios").select("id,ruta").eq("actualizacion_id", upd.id)));
      ok(await sb.from("actualizaciones").delete().eq("id", upd.id));
    },
    onChange: fn => changeFns.push(fn),
  };
  // the public view has no live channel; it checks for news every minute instead
  setInterval(() => { if (!session && document.visibilityState === "visible") fire(); }, 60e3);
  return S;
}

const IncStore = INC_CONFIG.url && INC_CONFIG.key && self.supabase ? incSupabaseStore(INC_CONFIG) : incLocalStore();
IncStore.uid = IncUtil.uid;

// Sign-in box drawn into `el`; calls done() once signed in. Accounts are created by the
// administrator in Supabase (Authentication > Users), so there is no sign-up here.
function incLoginBox(el, done, intro = "Inicie sesión para ver y registrar eventos."){
  el.innerHTML = `<form class="inclogin" style="display:grid;gap:8px;max-width:360px">
    <div class="sub">${IncUtil.esc(intro)}</div>
    <input type="email" name="email" autocomplete="username" placeholder="Correo" required style="font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)">
    <input type="password" name="pw" autocomplete="current-password" placeholder="Contraseña" required style="font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn red redbtn" type="submit">Entrar</button><span class="msg" role="status" style="font-size:13px"></span></div>
  </form>`;
  const fm = el.querySelector("form"), msg = fm.querySelector(".msg");
  fm.onsubmit = async e => { e.preventDefault(); msg.textContent = "Entrando…"; msg.style.color = "";
    try { await IncStore.signIn(fm.email.value.trim(), fm.pw.value); done?.(); }
    catch (err) { msg.textContent = /invalid/i.test(err.message) ? "Correo o contraseña incorrectos." : "No se pudo entrar: " + err.message; msg.style.color = "var(--bad, #b83a3a)"; } };
}
