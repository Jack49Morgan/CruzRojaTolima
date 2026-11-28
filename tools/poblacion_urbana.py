# One-off: builds data/poblacion-urbana.json for the "Medir → Área" population estimate.
# The DANE 2020 veredas in index.html leave out the cabeceras (town centres), so the per-vereda GHS-POP 2025 totals (VPOP)
# add up to ~0.3 M of Tolima's ~1.3 M. For each municipio the rest (MUNPOP − its veredas) lives in the gaps between veredas;
# it is spread over those gaps in proportion to the OpenStreetMap buildings there (≈110 m cells), so it lands on the
# built-up area and not on slivers along borders. A municipio with no mapped buildings in its gaps spreads it evenly.
# Inputs: index.html, HOT's OSM buildings export for Colombia (FlatGeobuf, ODbL):
#   https://production-raw-data-api.s3.amazonaws.com/ISO3/COL/buildings/polygons/hotosm_col_buildings_polygons_fgb.zip
# Usage: python3 tools/poblacion_urbana.py index.html buildings.fgb data/poblacion-urbana.json
import sys, json, re, collections
import numpy as np, pyogrio, shapely
from shapely.geometry import Polygon, MultiPolygon, shape
from shapely.strtree import STRtree

html, fgb, out = sys.argv[1:4]
s = open(html, encoding="utf-8").read()
def const(name):
    m = re.search(r"^const " + name + r" = (.*?);?$", s, re.M); return json.loads(m.group(1).rstrip(";"))
VEREDAS, VPOP, MUNPOP, GEO = const("VEREDAS"), const("VPOP"), const("MUNPOP"), const("TOLIMA_GEO")

def dec(st):
    out, i, x, y = [], 0, 0, 0
    def nx():
        nonlocal i
        r = sh = 0
        while True:
            b = ord(st[i]) - 63; i += 1; r |= (b & 31) << sh; sh += 5
            if b < 32: break
        return ~(r >> 1) if r & 1 else r >> 1
    while i < len(st):
        y += nx(); x += nx(); out.append((x / 1e4, y / 1e4))
    return out

vgeom = []
for m, n, polys in VEREDAS["f"]:
    ps = []
    for rings in polys:
        rr = [dec(r) for r in rings]
        p = Polygon(rr[0], rr[1:]).buffer(0)
        if not p.is_empty: ps.append(p)
    vgeom.append(shapely.union_all(ps) if ps else Polygon())
vtree = STRtree(vgeom)
vsum = collections.Counter()
for (m, n, _), p in zip(VEREDAS["f"], VPOP): vsum[VEREDAS["m"][m]] += p

C = 0.001   # cell size in degrees (~110 m)
meta, _, geom, _ = pyogrio.raw.read(fgb, bbox=(-76.2, 2.8, -74.3, 5.4), columns=[])
cent = shapely.centroid(shapely.from_wkb(geom))
bx, by = shapely.get_x(cent), shapely.get_y(cent)
print(len(bx), "buildings in the box")

cells = {}
for f in GEO["mun"]["features"]:
    name = f["properties"]["n"]
    mg = shape(f["geometry"]).buffer(0)
    rest = MUNPOP[name][2] - vsum.get(name, 0)
    if rest <= 0: continue
    minx, miny, maxx, maxy = mg.bounds
    sel = np.where((bx >= minx) & (bx <= maxx) & (by >= miny) & (by <= maxy))[0]
    pts = shapely.points(bx[sel], by[sel])
    inm = shapely.contains_xy(mg, bx[sel], by[sel])
    sel, pts = sel[inm], pts[inm]
    # buildings that fall inside a vereda are rural, already counted
    hit = vtree.query(pts, predicate="within")
    inv = np.zeros(len(sel), bool); inv[hit[0]] = True
    gx, gy = bx[sel][~inv], by[sel][~inv]
    cnt = collections.Counter(zip(np.floor(gy / C).astype(int), np.floor(gx / C).astype(int)))
    if not cnt:   # no mapped buildings in the gaps: spread over the gap evenly
        ys = np.arange(miny, maxy, C) + C / 2; xs = np.arange(minx, maxx, C) + C / 2
        X, Y = np.meshgrid(xs, ys); X, Y = X.ravel(), Y.ravel()
        ok = shapely.contains_xy(mg, X, Y); X, Y = X[ok], Y[ok]
        hit = vtree.query(shapely.points(X, Y), predicate="within"); gap = np.ones(len(X), bool); gap[hit[0]] = False
        cnt = collections.Counter(zip(np.floor(Y[gap] / C).astype(int), np.floor(X[gap] / C).astype(int)))
        print(name, "sin edificios en los huecos; reparto parejo en", len(cnt), "celdas")
    tot = sum(cnt.values())
    for k, c in cnt.items(): cells[k] = cells.get(k, 0) + rest * c / tot

rows = sorted([int(la), int(lo), round(float(p), 1)] for (la, lo), p in cells.items() if p >= 0.05)
json.dump({"fuente": "GHS-POP R2023A 2025 por municipio menos sus veredas, repartido sobre edificios de OpenStreetMap (ODbL)",
           "celda": C, "c": rows}, open(out, "w"), separators=(",", ":"))
print(len(rows), "cells, people", round(sum(r[2] for r in rows)), "of", round(sum(v[2] for v in MUNPOP.values()) - sum(VPOP)))
