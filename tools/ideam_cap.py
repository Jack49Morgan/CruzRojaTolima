#!/usr/bin/env python3
"""Read IDEAM's official alerts in CAP format (Common Alerting Protocol, feed https://alertascap.ideam.gov.co/ospa/xml) and keep
the ones that touch Tolima in data/ideam-cap.json. Runs on a schedule (GitHub Actions); the dashboard reads the JSON file.

Each feed entry links to one CAP 1.2 document. Landslide and forest fire alerts list municipios as "Tolima (Cajamarca, Líbano)";
flash flood watches and marine/regional warnings cover zones (hydrographic subzones, regions) given as polygons. For zone alerts the
polygons that overlap Tolima are kept (simplified) with the Tolima municipios they touch. The Tolima outline and municipios come from
TOLIMA_GEO in index.html, so the map and this script use the same shapes."""
import json, re, sys, pathlib, unicodedata, urllib.request, datetime as dt
import xml.etree.ElementTree as ET

FEED = "https://alertascap.ideam.gov.co/ospa/xml"
NS = {"a": "http://www.w3.org/2005/Atom", "c": "urn:oasis:names:tc:emergency:cap:1.2"}
UA = {"User-Agent": "sat-tolima-dashboard (Cruz Roja Tolima)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent

# event (English or Spanish, lower case, start of text) -> (key, plain Spanish name)
EVENTS = [
    ("landslide", "desl", "Deslizamientos"), ("deslizamiento", "desl", "Deslizamientos"), ("movimiento", "desl", "Deslizamientos"),
    ("forest fire", "inc", "Incendios forestales"), ("incendio", "inc", "Incendios forestales"),
    ("flash flood", "crec", "Crecientes súbitas"), ("creciente", "crec", "Crecientes súbitas"), ("avenida", "crec", "Crecientes súbitas"),
    ("flood", "inund", "Inundaciones"), ("inundaci", "inund", "Inundaciones"),
    ("severe weather", "tiempo", "Tiempo severo (lluvias fuertes, tormentas)"), ("tiempo", "tiempo", "Tiempo severo"),
    ("high tide", "mar", "Mar de leva / marea alta"), ("wind and waves", "mar", "Vientos y oleaje"), ("wind", "viento", "Vientos fuertes"),
    ("rain", "lluvia", "Lluvias fuertes"), ("lluvia", "lluvia", "Lluvias fuertes"),
]
LEVELS = [  # words in the text that give the alert level
    (r"\bhigh probability|probabilidad alta|\bred\b|\broja\b", "roja"),
    (r"\bmoderate probability|probabilidad moderada|\borange\b|\bnaranja\b", "naranja"),
    (r"\blow probability|probabilidad baja|\byellow\b|\bamarilla\b", "amarilla"),
]


def get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def norm(s):
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower().strip()


def load_tolima():
    """TOLIMA_GEO from index.html: department outline rings and municipio rings as [lat, lon] lists."""
    for line in (ROOT / "index.html").read_text(encoding="utf-8").splitlines():
        if line.startswith("const TOLIMA_GEO = "):
            g = json.loads(line[len("const TOLIMA_GEO = "):].rstrip().rstrip(";"))
            break
    else:
        sys.exit("TOLIMA_GEO not found in index.html")

    def rings(geom):
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        return [[[y, x] for x, y in p[0]] for p in polys]
    dep = [r for f in g["dep"].get("features", [g["dep"]]) for r in rings(f["geometry"])]
    mun = {f["properties"]["n"]: rings(f["geometry"]) for f in g["mun"]["features"]}
    return dep, mun


def inside(pt, ring):
    y, x = pt; c = False; j = len(ring) - 1
    for i in range(len(ring)):
        yi, xi = ring[i]; yj, xj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: c = not c
        j = i
    return c


def bbox(ring):
    ys = [p[0] for p in ring]; xs = [p[1] for p in ring]
    return min(ys), min(xs), max(ys), max(xs)


def overlaps(a, b):
    """Rough polygon overlap: bounding boxes meet and a vertex of one lies in the other (enough for map shapes this size)."""
    ba, bb = bbox(a), bbox(b)
    if ba[0] > bb[2] or bb[0] > ba[2] or ba[1] > bb[3] or bb[1] > ba[3]: return False
    step = max(1, len(a) // 400)
    if any(inside(p, b) for p in a[::step]): return True
    step = max(1, len(b) // 400)
    return any(inside(p, a) for p in b[::step])


def simplify(pts, tol=0.002):
    """Douglas-Peucker on [lat, lon] points (tol in degrees, ~200 m)."""
    if len(pts) < 5: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop(); (y1, x1), (y2, x2) = pts[s], pts[e]; dy, dx = y2 - y1, x2 - x1; L2 = dy * dy + dx * dx
        best, bi = 0, -1
        for i in range(s + 1, e):
            y, x = pts[i]
            d = abs(dx * (y1 - y) - dy * (x1 - x)) / L2 ** .5 if L2 else ((y - y1) ** 2 + (x - x1) ** 2) ** .5
            if d > best: best, bi = d, i
        if best > tol and bi > 0: keep[bi] = True; stack += [(s, bi), (bi, e)]
    return [[round(p[0], 4), round(p[1], 4)] for p, k in zip(pts, keep) if k]


def txt(el, path):
    x = el.find(path, NS)
    return (x.text or "").strip() if x is not None and x.text else ""


def level(*texts):
    t = " ".join(texts).lower()
    for rx, lv in LEVELS:
        if re.search(rx, t): return lv
    return None


def event_name(ev):
    e = norm(ev)
    for k, key, es in EVENTS:
        if k in e: return key, es
    return "otro", ev


def tolima_muns(text, mun_names):
    """Municipios listed as 'Tolima (A, B, C)' in the alert text, matched to the map's names."""
    by = {norm(n): n for n in mun_names}
    out = []
    for m in re.finditer(r"Tolima\s*\(([^)]*)\)", text or "", re.I):
        for n in re.split(r",|;| y | and ", m.group(1)):
            k = norm(n)
            k = {"san sebastian de mariquita": "mariquita", "armero guayabal": "armero", "armero (guayabal)": "armero"}.get(k, k)
            hit = by.get(k) or next((v for kk, v in by.items() if kk.startswith(k) or k.startswith(kk)), None) if k else None
            if hit and hit not in out: out.append(hit)
    return out


def parse_cap(xml, link, dep, mun):
    root = ET.fromstring(xml)
    if txt(root, "c:status") not in ("Actual", ""): return None
    if txt(root, "c:msgType") == "Cancel": return None
    infos = root.findall("c:info", NS)
    if not infos: return None
    info = next((i for i in infos if txt(i, "c:language").lower().startswith("es")), infos[0])
    ev = txt(info, "c:event"); key, ev_es = event_name(ev)
    desc, head, instr = txt(info, "c:description"), txt(info, "c:headline"), txt(info, "c:instruction")
    params = {txt(p, "c:valueName"): txt(p, "c:value") for p in info.findall("c:parameter", NS)}
    lv = level(desc, head, *[f"{k} {v}" for k, v in params.items()])
    if not lv: lv = {"Extreme": "roja", "Severe": "naranja"}.get(txt(info, "c:severity"), "amarilla")
    m = re.search(r"\b(low|moderate|high)\s+probability|probabilidad\s+(baja|moderada|alta)", desc + " " + head, re.I)
    prob = {"low": "baja", "moderate": "moderada", "high": "alta"}.get((m.group(1) or "").lower(), (m.group(2) or "").lower()) if m else ""
    area_desc = " ".join(txt(a, "c:areaDesc") for a in info.findall("c:area", NS))
    names = tolima_muns(" ".join([area_desc, desc, head]), mun.keys())
    listed = key in ("desl", "inc") or bool(names)  # municipio-style alert ("Tolima (mun, mun)"); others cover zones given as polygons
    poly, touch = [], []
    if not listed:  # zone alert: keep the polygons that overlap Tolima
        for a in info.findall("c:area", NS):
            for pg in a.findall("c:polygon", NS):
                ring = [[float(v) for v in pt.split(",")[:2]] for pt in (pg.text or "").split() if "," in pt]
                if len(ring) < 3 or not any(overlaps(ring, d) for d in dep): continue
                poly.append(simplify(ring))
                for n, rs in mun.items():
                    if n not in touch and any(overlaps(r, ring) for r in rs): touch.append(n)
        if not poly: return None
    elif not names:
        return None
    zonas = re.sub(r"^.*?\bfor\b\s*", "", head or "", flags=re.I) if not listed else ""
    return {
        "id": txt(root, "c:identifier"), "ev": ev_es, "ev_orig": ev, "tipo": key, "nivel": lv, "prob": prob,
        "sev": txt(info, "c:severity"), "urg": txt(info, "c:urgency"), "cert": txt(info, "c:certainty"),
        "sent": txt(root, "c:sent"), "eff": txt(info, "c:effective"), "onset": txt(info, "c:onset"), "exp": txt(info, "c:expires"),
        "head": head, "desc": desc[:1500], "instr": instr[:800], "web": txt(info, "c:web"), "link": link,
        "lang": txt(info, "c:language"), "mun": names or touch, "zona": bool(poly), "zonas": zonas[:600], "poly": poly,
    }


def main(path):
    dep, mun = load_tolima()
    feed = ET.fromstring(get(FEED))
    out, seen = [], set()
    for e in feed.findall("a:entry", NS):
        link = next((l.get("href") for l in e.findall("a:link", NS) if l.get("href")), None)
        title = txt(e, "a:title")
        if not link: continue
        try:
            a = parse_cap(get(link), link, dep, mun)
        except Exception as ex:
            print("skip", link, ex); continue
        if a and a["id"] not in seen:
            seen.add(a["id"]); out.append(a); print("Tolima:", a["nivel"], a["ev"], a["mun"][:6], "|", title[:80])
    order = {"roja": 0, "naranja": 1, "amarilla": 2}
    out.sort(key=lambda a: (order.get(a["nivel"], 3), a["ev"]))
    data = {"updated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "feed_updated": txt(feed, "a:updated"),
            "source": "IDEAM, alertas CAP (alertascap.ideam.gov.co)", "feed": FEED, "total": len(feed.findall("a:entry", NS)), "alerts": out}
    p = pathlib.Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    old = None
    try: old = json.loads(p.read_text())
    except Exception: pass
    if old and old.get("alerts") == out and old.get("total") == data["total"] and old.get("updated", "") > (dt.datetime.utcnow() - dt.timedelta(hours=3)).strftime("%Y-%m-%dT%H:%MZ"):
        print("no change"); return  # avoid a commit every half hour; still refresh the date every 3 h
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print("wrote", path, len(out), "alerts touching Tolima of", data["total"])


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data/ideam-cap.json"))
