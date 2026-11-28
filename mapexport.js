// "Imagen para informe": draws a part of the page (the shared map with its title, legend and source line) into a PNG
// sized for Word, and can wrap that PNG in a small .docx. No library: a small renderer that knows what a Leaflet map
// is made of (tile images, SVG and canvas layers, HTML/SVG markers and labels) and plain HTML boxes with text.
// Tiles are fetched again with CORS so the picture can be saved; a tile server that refuses leaves a grey gap.
// © 2026 Cruz Roja Colombiana, Seccional Tolima.
"use strict";

const MapExport = (() => {
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.decoding = "async"; i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const tileCache = new Map();
  async function tileBitmap(url){
    if (!tileCache.has(url)) tileCache.set(url, (async () => {
      const r = await fetch(url, {mode:"cors", credentials:"omit"}); if (!r.ok) throw new Error(r.status);
      return await createImageBitmap(await r.blob());
    })().catch(() => null));
    return tileCache.get(url);
  }
  function svgImage(svg, w, h){
    const c = svg.cloneNode(true);
    c.setAttribute("xmlns", "http://www.w3.org/2000/svg"); c.setAttribute("width", w); c.setAttribute("height", h);
    c.removeAttribute("style"); c.style.transform = "";
    // <use href="#id"> pointing at symbols elsewhere in the page: copy those symbols in
    const ids = [...c.querySelectorAll("use")].map(u => (u.getAttribute("href") || u.getAttribute("xlink:href") || "").slice(1)).filter(Boolean);
    if (ids.length) { const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      for (const id of new Set(ids)) { const s = document.getElementById(id); if (s) defs.appendChild(s.cloneNode(true)); } c.prepend(defs); }
    // inline the computed fill/stroke of shapes styled only by CSS classes
    const src = [svg, ...svg.querySelectorAll("*")], dst = [c, ...c.querySelectorAll("*")];
    src.forEach((el, i) => { const d = dst[i]; if (!d || !(el instanceof SVGGraphicsElement)) return; const cs = getComputedStyle(el);
      for (const p of ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-family", "font-size", "font-weight"])
        if (!d.getAttribute(p)) d.setAttribute(p, cs.getPropertyValue(p)); });
    const xml = new XMLSerializer().serializeToString(c);
    return loadImg("data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml));
  }
  const px = v => parseFloat(v) || 0;
  const visible = (el, cs) => cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity !== 0;
  function rrect(ctx, x, y, w, h, r){ r = Math.max(0, Math.min(r, w / 2, h / 2)); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // Draws `root` and what is inside it. O = top-left of root on the page; every position comes from getBoundingClientRect,
  // so CSS transforms (Leaflet moves its panes with them) are already applied.
  async function render(root, scale = 2, skip = () => false, bg = "#ffffff"){
    const R = root.getBoundingClientRect(), cv = document.createElement("canvas");
    cv.width = Math.round(R.width * scale); cv.height = Math.round(R.height * scale);
    const ctx = cv.getContext("2d"); ctx.scale(scale, scale); ctx.fillStyle = bg; ctx.fillRect(0, 0, R.width, R.height);
    const stats = {tilesMissing:0};
    const rel = r => ({x:r.left - R.left, y:r.top - R.top, w:r.width, h:r.height});
    const inter = (c, r) => { if (!c) return r; const x = Math.max(c.x, r.x), y = Math.max(c.y, r.y);
      return {x, y, w:Math.max(0, Math.min(c.x + c.w, r.x + r.w) - x), h:Math.max(0, Math.min(c.y + c.h, r.y + r.h) - y)}; };
    const draw = (a, clip, fn) => { ctx.save(); ctx.globalAlpha = a; if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); } try { fn(); } finally { ctx.restore(); } };
    async function node(el, alpha, clip){
      if (skip(el)) return;
      if (!el.getClientRects().length) return;            // not rendered (display:none, inside a closed <details>, …)
      const cs = getComputedStyle(el); if (!visible(el, cs)) return;
      const a = alpha * (cs.opacity === "" ? 1 : +cs.opacity), r = rel(el.getBoundingClientRect());
      // outside the clip: skip, except empty-sized wrappers (Leaflet panes are 0×0 boxes moved by transforms)
      if (clip && r.w && r.h && (r.x > clip.x + clip.w || r.y > clip.y + clip.h || r.x + r.w < clip.x || r.y + r.h < clip.y)) return;
      if (el.tagName === "IMG") {
        if (!r.w || !r.h) return;
        const cross = /^https?:/.test(el.src) && new URL(el.src).origin !== location.origin;
        if (cross) { const b = await tileBitmap(el.currentSrc || el.src); if (b) draw(a, clip, () => ctx.drawImage(b, r.x, r.y, r.w, r.h)); else stats.tilesMissing++; }
        else if (el.complete && el.naturalWidth) draw(a, clip, () => ctx.drawImage(el, r.x, r.y, r.w, r.h));
        return;
      }
      if (el.tagName === "CANVAS") { if (r.w && r.h) draw(a, clip, () => ctx.drawImage(el, r.x, r.y, r.w, r.h)); return; }
      if (el instanceof SVGSVGElement) { if (r.w && r.h) { const im = await svgImage(el, r.w, r.h).catch(() => null); if (im) draw(a, clip, () => ctx.drawImage(im, r.x, r.y, r.w, r.h)); } return; }
      if (el instanceof SVGElement) return;
      // the box: background and borders
      draw(a, clip, () => {
        const bgc = cs.backgroundColor, bT = px(cs.borderTopWidth), bL = px(cs.borderLeftWidth), bB = px(cs.borderBottomWidth), bR = px(cs.borderRightWidth);
        let rad = cs.borderTopLeftRadius; rad = rad.endsWith("%") ? px(rad) / 100 * Math.min(r.w, r.h) : px(rad);
        if (bgc && !/rgba\(0, 0, 0, 0\)|transparent/.test(bgc) && r.w && r.h) { ctx.fillStyle = bgc; rrect(ctx, r.x, r.y, r.w, r.h, rad); ctx.fill(); }
        const on = (w, st) => w > 0 && st !== "none" && st !== "hidden";
        if (on(bT, cs.borderTopStyle) && on(bL, cs.borderLeftStyle) && on(bB, cs.borderBottomStyle) && on(bR, cs.borderRightStyle) && cs.borderTopColor === cs.borderLeftColor) {
          ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = bT; rrect(ctx, r.x + bT / 2, r.y + bT / 2, r.w - bT, r.h - bT, Math.max(0, rad - bT / 2)); ctx.stroke(); return; }
        const side = (w, st, c, x1, y1, x2, y2) => { if (!on(w, st)) return; ctx.strokeStyle = c; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
        side(bT, cs.borderTopStyle, cs.borderTopColor, r.x, r.y + bT / 2, r.x + r.w, r.y + bT / 2);
        side(bB, cs.borderBottomStyle, cs.borderBottomColor, r.x, r.y + r.h - bB / 2, r.x + r.w, r.y + r.h - bB / 2);
        side(bL, cs.borderLeftStyle, cs.borderLeftColor, r.x + bL / 2, r.y, r.x + bL / 2, r.y + r.h);
        side(bR, cs.borderRightStyle, cs.borderRightColor, r.x + r.w - bR / 2, r.y, r.x + r.w - bR / 2, r.y + r.h);
      });
      const sub = el.classList.contains("leaflet-container") || cs.overflow === "hidden" ? inter(clip, r) : clip;
      // children in paint order: by z-index where set (Leaflet panes: tiles 200, shapes 400, markers 600, labels 650), else page order
      const kids = [...el.childNodes].map((ch, i) => [ch, i, ch.nodeType === 1 ? (ch.classList.contains("leaflet-control-container") ? 1000 : parseInt(getComputedStyle(ch).zIndex) || 0) : 0])
        .sort((p, q) => p[2] - q[2] || p[1] - q[1]).map(k => k[0]);
      for (const ch of kids) {
        if (ch.nodeType === 3) { if (ch.textContent.trim()) draw(a, sub, () => text(ch, cs)); }
        else if (ch.nodeType === 1) await node(ch, a, sub);
      }
    }
    // text: word by word, where the browser laid it out
    function text(tn, cs){
      // canvas fonts reject some CSS family names (-apple-system…), which would silently keep the previous font
      const fam = cs.fontFamily.split(",").map(f => f.trim()).filter(f => !/^-|BlinkMacSystemFont/i.test(f)).join(", ") || "sans-serif";
      ctx.fillStyle = cs.color; ctx.font = "10px serif"; ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${fam}`;
      if (ctx.font === "10px serif") ctx.font = `${cs.fontWeight} ${cs.fontSize} sans-serif`; ctx.textBaseline = "alphabetic";
      const s = tn.textContent, rg = document.createRange(), re = /[^\s-]+-?|-/g, fs = px(cs.fontSize), up = cs.textTransform === "uppercase"; let m;
      while ((m = re.exec(s))) { rg.setStart(tn, m.index); rg.setEnd(tn, m.index + m[0].length);
        const rs = rg.getClientRects(); if (!rs.length) continue; const q = rel(rs[0]);
        ctx.fillText(up ? m[0].toUpperCase() : m[0], q.x, q.y + (q.h - fs) / 2 + fs * 0.8, q.w + 0.5); }   // never wider than in the page
    }
    await node(root, 1, null);
    cv._stats = stats; return cv;
  }

  // ---- PNG with its print size (pHYs chunk), so Word inserts it at the intended width
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b, c = 0xffffffff) => { for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return c; };
  async function pngBytes(canvas, dpi){
    const blob = await new Promise(r => canvas.toBlob(r, "image/png")), b = new Uint8Array(await blob.arrayBuffer());
    const ppm = Math.round(dpi / 0.0254), ch = new Uint8Array(21), dv = new DataView(ch.buffer);
    dv.setUint32(0, 9); ch.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); ch[16] = 1;
    dv.setUint32(17, (crc32(ch.subarray(4, 17)) ^ 0xffffffff) >>> 0);
    const at = 33;   // signature (8) + IHDR chunk (25)
    const out = new Uint8Array(b.length + 21); out.set(b.subarray(0, at)); out.set(ch, at); out.set(b.subarray(at), at + 21); return out;
  }
  // ---- .docx with the picture at its width and a caption under it (stored ZIP, no compression)
  function zip(files){
    const enc = new TextEncoder(), parts = [], dir = []; let off = 0;
    for (const [name, content] of files) {
      const nm = enc.encode(name), data = typeof content === "string" ? enc.encode(content) : content, crc = (crc32(data) ^ 0xffffffff) >>> 0;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      parts.push(h.buffer, nm, data); dir.push(c.buffer, nm); off += 30 + nm.length + data.length;
    }
    const dlen = dir.reduce((s, x) => s + (x.byteLength ?? x.length), 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dlen, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...dir, e.buffer], {type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
  }
  const x = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;"}[c]));
  function docx(png, wPx, hPx, cmWidth, title, caption){
    const cx = Math.round(cmWidth * 360000), cy = Math.round(cx * hPx / wPx);
    const run = (t, b) => `<w:r>${b ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Mapa" descr="${x(title)}"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="mapa.png"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60"/></w:pPr>${run("Mapa 1. ", true)}${run(title)}</w:p>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${x(caption)}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return zip([
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
      ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/mapa.png"/></Relationships>`],
      ["word/document.xml", doc],
      ["word/media/mapa.png", png],
    ]);
  }
  return {render, pngBytes, docx};
})();
