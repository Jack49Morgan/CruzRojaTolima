# One-off: builds data/vias-tolima.json, the road layer ("Vías"), from OpenStreetMap.
# Inputs (arguments):
#   1. roads.gpkg from HOT's OSM export for Colombia (ODbL):
#      https://production-raw-data-api.s3.amazonaws.com/ISO3/COL/roads/hotosm_col_roads_osm_gpkg.zip
#   2. INVÍAS Red Vial Nacional (CC BY-SA 4.0), GeoJSON for a box around Tolima:
#      https://www.datos.gov.co/resource/ie7y-asdn.geojson?$limit=50000&$where=within_box(multiline,5.4,-76.2,2.8,-74.3)
#   3. output path
# OSM classes: primaria = motorway/trunk/primary, secundaria = secondary, terciaria = tertiary/unclassified,
# camino = track (carreteable sin clasificar). Segments with the same name, class, surface and municipio are merged,
# simplified (~15 m) and stored as integer coordinates (1e-5 degrees) delta-encoded per line.
# Primaria/secundaria segments that run along an INVÍAS national route get its route number and sector.
import sys, json, collections
import pyogrio, shapely
from shapely.ops import linemerge
from shapely.strtree import STRtree

gpkg, invias_path, out = sys.argv[1:4]
CLS = {"motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0, "primary": 0, "primary_link": 0,
       "secondary": 1, "secondary_link": 1, "tertiary": 2, "tertiary_link": 2, "unclassified": 2, "track": 3}
SURF = {"asphalt": "a", "paved": "a", "concrete": "c", "concrete:plates": "c", "concrete:lanes": "c", "paving_stones": "c",
        "unpaved": "d", "compacted": "d", "gravel": "d", "fine_gravel": "d", "ground": "d", "dirt": "d", "earth": "d", "mud": "d", "sand": "d", "grass": "d"}
meta, _, geom, f = pyogrio.raw.read(gpkg, bbox=(-76.2, 2.8, -74.3, 5.4),
                                    columns=["name", "highway", "surface", "bridge", "adm1_name", "adm2_name"])
d = dict(zip(meta["fields"], f))
groups = collections.defaultdict(list)
bridges = []
for i, g in enumerate(geom):
    if d["adm1_name"][i] != "Tolima" or d["highway"][i] not in CLS: continue
    ln = shapely.from_wkb(g)
    if ln.geom_type not in ("LineString", "MultiLineString"): continue
    c = CLS[d["highway"][i]]
    key = (c, (d["name"][i] or "").strip(), SURF.get(d["surface"][i] or "", ""), d["adm2_name"][i] or "")
    if d["bridge"][i] not in (None, "no") and c < 3: bridges.append((key, ln))
    else: groups[key].append(ln)

inv = [x for x in json.load(open(invias_path))["features"] if "Fuera de Servicio" not in (x["properties"].get("sector") or "")]
inv_g = [shapely.geometry.shape(x["geometry"]) for x in inv]
tree = STRtree(inv_g)
def invias(line):
    # national route whose axis stays within ~150 m of the segment's middle and ends
    pts = [line.interpolate(t, normalized=True) for t in (0.1, 0.5, 0.9)]
    best = None
    for j in tree.query(line.buffer(0.0015)):
        if all(inv_g[j].distance(p) < 0.0015 for p in pts):
            dist = sum(inv_g[j].distance(p) for p in pts)
            if best is None or dist < best[0]: best = (dist, j)
    if best is None: return None
    p = inv[best[1]]["properties"]
    tramo = p.get("codigo_tramo") or ""
    return [p.get("ruta") or tramo[:2], p.get("nombre_ruta") or "", " ".join((p.get("sector") or "").split()), tramo]

def enc(ls):
    out, px, py = [], 0, 0
    for x, y in ls.coords:
        ix, iy = round(x * 1e5), round(y * 1e5)
        out += [ix - px, iy - py]; px, py = ix, iy
    return out

roads, rutas, rmap = [], [], {}
def emit(key, geoms, bridge=False):
    c, name, surf, mun = key
    m = linemerge(geoms) if len(geoms) > 1 else geoms[0]
    parts = list(m.geoms) if m.geom_type == "MultiLineString" else [m]
    for p in parts:
        s = p.simplify(0.00012 if c < 2 else 0.00015)
        if s.length < 0.0003 and c >= 2: continue      # drop scraps under ~30 m
        r = invias(p) if c < 2 else None
        ri = -1
        if r:
            k = tuple(r)
            if k not in rmap: rmap[k] = len(rutas); rutas.append(r)
            ri = rmap[k]
        roads.append([c, name, surf, mun, ri, 1 if bridge else 0, enc(s)])
for key, gs in groups.items(): emit(key, gs)
for key, ln in bridges: emit(key, [ln], True)
roads.sort(key=lambda r: -r[0])   # draw caminos first, primarias last (on top)
muns = sorted({r[3] for r in roads}); mi = {m: i for i, m in enumerate(muns)}
for r in roads: r[3] = mi[r[3]]
json.dump({"fuente": "OpenStreetMap (ODbL), exportación HOT de " + sys.argv[4] if len(sys.argv) > 4 else "OpenStreetMap (ODbL)",
           "mun": muns, "rutas": rutas, "v": roads}, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
print(len(roads), "lines,", len(rutas), "INVÍAS sectors", collections.Counter(r[0] for r in roads))
