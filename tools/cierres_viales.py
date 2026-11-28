#!/usr/bin/env python3
"""Road closures in Tolima (cierres viales INVÍAS) for the "Cierres viales" map layer, into data/cierres-viales.json.

Source: the "Estado de las vías" table of the Policía Nacional (https://www.policia.gov.co/estado-de-las-vias), which lists
the closures INVÍAS declares by resolution: road, PR (kilometre marker), condition, reason, alternate route and dates.
It is an HTML page that browsers on other sites cannot read, so this runs on a schedule (GitHub Actions).

The table has no coordinates. Each closure is placed on INVÍAS' Red Vial Nacional (data/invias-red-tolima.json): among the
national road sectors whose PR range covers the closure's PR, the one whose names best match the closure text, then the
point at that PR by interpolating along the sector. Closures that cannot be placed inside Tolima keep ll = null and are
listed without a marker. Only closures still in force (no end date, end date ahead, or "cierre indefinido") are kept.

Usage: python3 tools/cierres_viales.py data/invias-red-tolima.json data/cierres-viales.json [saved.html ...]
(extra arguments: parse saved copies of the page instead of downloading, for testing)."""
import sys, re, json, html, math, unicodedata, urllib.request, datetime as dt

URL = "https://www.policia.gov.co/estado-de-las-vias?field_departamento_via_target_id=2213"   # 2213 = Tolima
BOX = (-76.2, 2.8, -74.35, 5.35)   # Tolima, with a small margin (lon, lat)

def norm(s):
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9+]+", " ", s).strip()
STOP = set("via de del la el las los y a al en sector sin ruta nacional cruce pr km tramo corredor puente variante paso por con".split())
def toks(s): return {w for w in norm(s).split() if len(w) > 2 and w not in STOP and not w.isdigit()}

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (sat-tolima-dashboard)"})
    with urllib.request.urlopen(req, timeout=60) as r: return r.read().decode("utf-8", "replace")

def cell(td):
    t = re.search(r'<time datetime="([^"]+)"', td)
    if t: return t.group(1)
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", td)).split())

def parse(page):
    rows = []
    body = re.search(r"<tbody>(.*?)</tbody>", page, re.S)
    if not body: return rows
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body.group(1), re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) < 11: continue
        c = [cell(x) for x in tds]
        ent = c[10]
        link = re.search(r'href="([^"]+)"', tds[10]) or re.search(r"(https?://\S+)", ent)
        rows.append({"via": c[0], "dep": c[1], "sector": "" if norm(c[2]) == "sin sector" else c[2], "km": c[3], "cond": c[4],
                     "motivo": c[5], "alterna": "" if norm(c[6]) in ("no aplica", "") else c[6], "ini": c[7], "fin": c[8],
                     "indef": norm(c[9]).startswith("s"), "res": "" if ent.startswith("http") else ent, "url": link.group(1) if link else ""})
    return rows

def prs(s):
    """PR markers in a text, as km floats: 'PR41+0800' -> 41.8, 'Pr 47+380' -> 47.38, '18+000' -> 18.0"""
    out = []
    for a, b in re.findall(r"(?:PR\s*)?(\d{1,3})\s*\+\s*(\d{1,4})", s, re.I):
        out.append(int(a) + int(b) / 1000)   # the part after + is metres, written with 3 or 4 digits
    return out

def seg_range(f): return f["pi"] + f["di"] / 1000, f["pf"] + f["df"] / 1000

def point_at(f, km):
    a, b = seg_range(f)
    t = 0.5 if b <= a or not f.get("o") else min(1, max(0, (km - a) / (b - a)))   # direction unknown: middle of the sector
    pts = f["c"]
    L = [0.0]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]): L.append(L[-1] + math.hypot(x2 - x1, (y2 - y1)))
    goal = t * L[-1]
    for i in range(1, len(L)):
        if L[i] >= goal:
            u = 0 if L[i] == L[i - 1] else (goal - L[i - 1]) / (L[i] - L[i - 1])
            (x1, y1), (x2, y2) = pts[i - 1], pts[i]
            return [round(y1 + u * (y2 - y1), 5), round(x1 + u * (x2 - x1), 5)]
    return [pts[-1][1], pts[-1][0]]

def locate(row, red):
    text = " ".join([row["via"], row["sector"]])
    codes = {c.upper() for c in re.findall(r"(?:ruta nacional|c[oó]digo)\s*([0-9]{2}[0-9A-Z]{0,4})", text, re.I)}   # not "Cruce Ruta 45"
    want = toks(text)
    kms = prs(row["km"]) or prs(row["via"])
    best = None
    for km in kms[:2]:
        for f in red:
            a, b = sorted(seg_range(f))
            off = max(0, a - km, km - b)          # km outside the sector's PR range (INVÍAS and the resolutions differ a little)
            if off > 2: continue
            score = len(want & toks(f["s"])) * 2 + len(want & toks(f["n"])) + (3 if f["t"].upper() in codes or f["r"].upper() in codes else 0) - off
            if score > 0.5 and (best is None or score > best[0]): best = (score, f, min(max(km, a), b))
        if best: break
    if not best: return None, None
    _, f, km = best
    ll = point_at(f, km)
    if not (BOX[1] <= ll[0] <= BOX[3] and BOX[0] <= ll[1] <= BOX[2]): return None, None
    return ll, {"tramo": f["t"], "ruta": f["r"], "sector": f["s"], "pr": km, "aprox": not f.get("o")}

def main():
    red_path, out_path, *saved = sys.argv[1:]
    red = json.load(open(red_path, encoding="utf-8"))["f"]
    rows = []
    if saved:
        for p in saved: rows += parse(open(p, encoding="utf-8").read())
    else:
        for page in range(10):
            got = parse(fetch(URL + f"&page={page}"))
            if not got: break
            rows += got
    now = dt.datetime.now(dt.timezone.utc)
    items = []
    for r in rows:
        fin = r["fin"]
        try: fin_d = dt.datetime.fromisoformat(fin.replace("Z", "+00:00")) if fin else None
        except ValueError: fin_d = None
        if fin_d and fin_d < now and not r["indef"]: continue
        ll, where = locate(r, red)
        items.append({**r, "ll": ll, "en": where})
    json.dump({"actualizado": now.strftime("%Y-%m-%dT%H:%MZ"), "fuente": "INVÍAS, cierres viales publicados por la Policía Nacional (Estado de las vías)",
               "url": URL, "cierres": items}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(len(rows), "filas,", len(items), "vigentes,", sum(1 for i in items if i["ll"]), "ubicadas")

if __name__ == "__main__":
    main()
