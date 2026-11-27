// "Exportar a Excel": writes the team's eventos for a date range to an .xlsx file, all in the browser.
// The workbook is plain SpreadsheetML in an uncompressed ZIP, so no spreadsheet library is needed.
// © 2026 Cruz Roja Colombiana, Seccional Tolima.
"use strict";

const IncExport = (() => {
  // ---- minimal ZIP (stored, no compression) ----
  const CRC = (() => { const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t; })();
  const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files){   // files: [[name, string]]
    const enc = new TextEncoder(), parts = [], dir = []; let off = 0;
    for (const [name, text] of files) {
      const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);   // UTF-8 names
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      parts.push(h.buffer, nm, data); dir.push(c.buffer, nm); off += 30 + nm.length + data.length;
    }
    const dlen = dir.reduce((s, x) => s + (x.byteLength ?? x.length), 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dlen, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...dir, e.buffer], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  }

  // ---- one-sheet workbook; cells are numbers or inline strings, first row bold and frozen ----
  const x = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"}[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  const col = i => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  function xlsx(rows, widths, sheet = "Eventos"){
    const sd = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => { const ref = col(ci) + (ri + 1), st = ri ? "" : ' s="1"';
      if (v == null || v === "") return "";
      return typeof v === "number" ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${x(v)}</t></is></c>`; }).join("")}</row>`).join("");
    const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
    return zip([
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${x(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC8102E"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sd}</sheetData><autoFilter ref="A1:${col(rows[0].length - 1)}${rows.length}"/></worksheet>`],
    ]);
  }

  // ---- eventos -> rows ----
  const bog = iso => { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return String(iso).replace("T", " ");
    return d.toLocaleString("sv-SE", {timeZone:"America/Bogota", hour12:false}).slice(0, 16); };
  const num = v => v == null || v === "" ? "" : +v;
  const COLS = [
    ["Título", 34, i => i.titulo],
    ["Tipo", 22, i => (INC_TIPOS[i.tipo] || INC_TIPOS.otro)[0]],
    ["Municipio", 16, i => i.municipio],
    ["Lugar / vereda", 22, i => i.lugar],
    ["Latitud", 11, i => i.punto ? +(+i.punto[0]).toFixed(6) : ""],
    ["Longitud", 11, i => i.punto ? +(+i.punto[1]).toFixed(6) : ""],
    ["Estado", 12, i => INC_ESTADOS[i.estado] || i.estado],
    ["Inicio (hora Colombia)", 18, i => String(i.fecha || "").replace("T", " ").slice(0, 16)],
    ["Registrado (hora Colombia)", 18, i => bog(i.creado)],
    ["Última actualización", 18, i => bog(i.actualizado)],
    ["Fallecidos", 10, i => num(i.afectados?.fallecidos)],
    ["Heridos", 9, i => num(i.afectados?.heridos)],
    ["Personas afectadas", 11, i => num(i.afectados?.personas)],
    ["Viviendas afectadas", 11, i => num(i.afectados?.viviendas)],
    ["Vía afectada", 9, i => i.via ? "Sí" : "No"],
    ["Puente afectado", 9, i => i.puente ? "Sí" : "No"],
    ["Respuesta Cruz Roja", 10, i => i.respcr === "si" ? "Sí" : i.respcr === "no" ? "No" : ""],
    ["Descripción Respuesta Cruz Roja", 40, i => i.respcr === "si" ? i.respcrdesc : ""],
    ["Descripción", 50, i => i.descripcion],
    ["Acciones de otras entidades", 40, i => i.acciones],
    ["Registrado por", 18, i => IncUtil.registra(i)],
    ["Enlace de seguimiento", 50, i => new URL("incidente.html?id=" + encodeURIComponent(i.id), location.href).href],
  ];
  const day = d => d.toLocaleDateString("en-CA", {timeZone:"America/Bogota"});   // YYYY-MM-DD in Colombia
  const minus = months => { const d = new Date(); d.setMonth(d.getMonth() - months); return day(d); };
  const RANGOS = {mes:["Último mes", () => minus(1)], seis:["Últimos 6 meses", () => minus(6)], anio:["Último año", () => minus(12)], fechas:["Entre fechas", null]};

  // filter by the event's start date (inclusive), newest first, and download
  async function exportar(desde, hasta){
    const incs = (await IncStore.list()).filter(i => { const f = String(i.fecha || i.creado || "").slice(0, 10); return f >= desde && f <= hasta; })
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const blob = xlsx([COLS.map(c => c[0]), ...incs.map(i => COLS.map(c => { const v = c[2](i); return v ?? ""; }))], COLS.map(c => c[1]));
    const a = Object.assign(document.createElement("a"), {href:URL.createObjectURL(blob), download:`eventos-cruz-roja-tolima_${desde}_a_${hasta}.xlsx`});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return incs.length;
  }

  // the small form: range choice, optional dates, download button and a result line
  function mount(box){
    const hoy = day(new Date());
    box.innerHTML = `<b>Exportar a Excel:</b>
      <select aria-label="Periodo">${Object.entries(RANGOS).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join("")}</select>
      <span class="xfechas" hidden><label>desde <input type="date" name="desde" value="${minus(1)}" max="${hoy}"></label> <label>hasta <input type="date" name="hasta" value="${hoy}" max="${hoy}"></label></span>
      <button type="button" class="btn">⬇ Descargar .xlsx</button> <span class="xmsg sub" role="status"></span>`;
    const sel = box.querySelector("select"), fechas = box.querySelector(".xfechas"), msg = box.querySelector(".xmsg");
    sel.onchange = () => { fechas.hidden = sel.value !== "fechas"; msg.textContent = ""; };
    box.querySelector("button").onclick = async () => {
      let desde, hasta = day(new Date());
      if (sel.value === "fechas") { desde = box.querySelector("[name=desde]").value; hasta = box.querySelector("[name=hasta]").value;
        if (!desde || !hasta || desde > hasta) { msg.textContent = "Revise las fechas: “desde” debe ser anterior a “hasta”."; return; } }
      else desde = RANGOS[sel.value][1]();
      msg.textContent = "Preparando…";
      try { const n = await exportar(desde, hasta); msg.textContent = n ? `${n} evento(s) exportados (${desde} a ${hasta}).` : `No hay eventos entre ${desde} y ${hasta}; el archivo solo trae los títulos.`; }
      catch (e) { msg.textContent = "No se pudo exportar: " + (e.message || e); }
    };
  }
  return {mount, exportar, xlsx};
})();
