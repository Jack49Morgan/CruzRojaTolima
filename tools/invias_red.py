# One-off: builds data/invias-red-tolima.json, the INVÍAS national road sectors around Tolima as single lines ordered by PR,
# used by tools/cierres_viales.py to place closures given as "PR 25+430" on a road.
# Inputs:
#   1. INVÍAS Red Vial Nacional (CC BY-SA 4.0) as GeoJSON for a box around Tolima:
#      https://www.datos.gov.co/resource/ie7y-asdn.geojson?$limit=50000&$where=within_box(multiline,5.4,-76.2,2.8,-74.3)
#   2. HOT's OSM populated places for Colombia (gpkg, ODbL), to find the towns a sector is named after:
#      https://production-raw-data-api.s3.amazonaws.com/ISO3/COL/populated_places/hotosm_col_populated_places_osm_gpkg.zip
#   3. output path
# Each sector is a MultiLineString whose parts come in no particular order and, on dual carriageways, twice. The parts
# become a graph; the line is the shortest path between its two far ends. INVÍAS sectors are named "A - B" with the PR
# growing from A to B, so the end nearer to town A is the start ("o": 1). Where neither town is found, a neighbouring
# sector of the same tramo whose end PR equals this start PR decides; otherwise "o": 0 (direction unknown).
import sys, json, re, unicodedata
import networkx as nx, pyogrio, shapely
from shapely.geometry import shape, Point, LineString

src, places, out = sys.argv[1:4]
def norm(s): return re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()).strip()

meta, _, geom, f = pyogrio.raw.read(places, bbox=(-76.6, 2.4, -73.9, 5.8), columns=["name"])
gaz = {}
for n, g in zip(f[0], geom):
    if not n: continue
    p = shapely.from_wkb(g); p = p if p.geom_type == "Point" else p.centroid
    gaz.setdefault(norm(n), []).append((p.x, p.y))

def town(label, line):
    """coordinates of the town named in one side of a sector label, the one nearest the line (≤ 15 km)"""
    label = re.sub(r"cruce ruta \d+\w*|paso nacional por|variante( de)?|puente|interseccion|calzada \w+|accesos?", " ", norm(label))
    words = [w for w in label.split() if w]
    for k in range(min(4, len(words)), 0, -1):            # longest run of words that names a place
        for i in range(len(words) - k + 1):
            cand = gaz.get(" ".join(words[i:i + k]))
            if cand:
                best = min(cand, key=lambda c: line.distance(Point(c)))
                if line.distance(Point(best)) < 0.14: return best
    return None

def chain(g):
    parts = list(g.geoms) if g.geom_type == "MultiLineString" else [g]
    G = nx.Graph()
    key = lambda c: (round(c[0], 4), round(c[1], 4))        # ~10 m snapping joins parts that nearly touch
    for p in parts:
        cs = list(p.coords)
        for a, b in zip(cs, cs[1:]):
            if key(a) != key(b): G.add_edge(key(a), key(b), w=Point(a).distance(Point(b)), pts=(a, b))
    if not G.number_of_edges(): return None
    comp = max(nx.connected_components(G), key=lambda c: sum(G.edges[e]["w"] for e in G.subgraph(c).edges))
    H = G.subgraph(comp)
    # far ends: farthest node from any node, then farthest from that one
    n0 = next(iter(H.nodes)); d = nx.single_source_dijkstra_path_length(H, n0, weight="w"); a = max(d, key=d.get)
    d = nx.single_source_dijkstra_path_length(H, a, weight="w"); b = max(d, key=d.get)
    return nx.shortest_path(H, a, b, weight="w")

feats = [x for x in json.load(open(src, encoding="utf-8"))["features"] if "fuera de servicio" not in norm(x["properties"].get("sector"))]
rows = []
for x in feats:
    p = x["properties"]; path = chain(shape(x["geometry"]))
    if not path or len(path) < 2: continue
    sector = " ".join((p.get("sector") or "").split())
    line = LineString(path)
    sides = re.split(r"\s+-\s*|\s*-\s+", sector, maxsplit=1)
    o = 0
    if len(sides) == 2:
        A, B = town(sides[0], line), town(sides[1], line)
        s0, s1 = Point(path[0]), Point(path[-1])
        if A or B:
            fwd = (s0.distance(Point(A)) if A else -s0.distance(Point(B))) < (s1.distance(Point(A)) if A else -s1.distance(Point(B)))
            if not fwd: path = path[::-1]
            o = 1
    tramo = p.get("codigo_tramo") or ""
    rows.append({"t": tramo, "r": p.get("ruta") or tramo[:2], "n": p.get("nombre_ruta") or "", "s": sector, "cal": p.get("calzada") or "",
                 "pi": float(p.get("poste_de_referencia_inicial") or 0), "di": float(p.get("distancia_inicial") or 0),
                 "pf": float(p.get("poste_de_referencia_final") or 0), "df": float(p.get("distancia_final") or 0), "o": o,
                 "c": [[round(c[0], 5), round(c[1], 5)] for c in LineString(path).simplify(0.0001).coords]})
# sectors still without a direction: a sector of the same tramo ending where this one starts (PR) touches its start
for r in rows:
    if r["o"]: continue
    start = r["pi"] + r["di"] / 1000
    for q in rows:
        if q is r or q["t"][:4] != r["t"][:4] or abs(q["pf"] + q["df"] / 1000 - start) > 0.5: continue
        qe = Point(q["c"][-1] if q["o"] else q["c"][0]) if q["o"] else None
        if qe is None: continue
        if Point(r["c"][-1]).distance(qe) < Point(r["c"][0]).distance(qe): r["c"] = r["c"][::-1]
        r["o"] = 1; break
json.dump({"fuente": "INVÍAS, Red Vial Nacional (datos.gov.co ie7y-asdn, CC BY-SA 4.0), 2026-11-19; recorte Tolima y vecinos",
           "f": rows}, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(rows), "sectores;", sum(r["o"] for r in rows), "con dirección conocida")
for r in rows:
    if not r["o"]: print("  sin dirección:", r["t"], r["s"])
