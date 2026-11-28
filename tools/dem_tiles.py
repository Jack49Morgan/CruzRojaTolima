"""Altitude tiles for the map, from Jack's 'DEM Tolima.tif' (38.2 m cells, MAGNA-SIRGAS / Origen Nacional).

Writes data/dem/{z}/{x}/{y}.webp (lossless WebP, ~40 % smaller than PNG): 256 px Web Mercator tiles (the same grid as the basemaps), zoom 7 to 12.
Each pixel holds the altitude in whole metres as red * 256 + green (blue is 0); 0 means no data.
The page reads the pixels to show the altitude of a point and draws the relief shading from them.
Only tiles that touch Tolima (plus a ~2 km margin) are kept; pixels farther out are left empty, to keep the files small.

  pip install rasterio pillow numpy shapely
  python tools/dem_tiles.py "DEM Tolima.tif" data/dem
"""
import json, math, os, re, sys
import numpy as np, rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_bounds
from rasterio.features import rasterize
from PIL import Image
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union

SRC, OUT = sys.argv[1], sys.argv[2]
ZMIN, ZMAX = 7, 12
R = 20037508.342789244

# Tolima outline from the page itself (TOLIMA_GEO.dep, lon/lat)
html = open(os.path.join(os.path.dirname(__file__), "..", "index.html"), encoding="utf8").read()
geo = json.loads(re.search(r"const TOLIMA_GEO = (\{.*?\});\n", html).group(1))
d = geo["dep"]; dep = unary_union([shape(f["geometry"]) for f in d["features"]]) if "features" in d else shape(d["geometry"])

def merc(lon, lat):
    return lon * R / 180, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R / math.pi

# mask polygon in Web Mercator, ~2 km beyond the department
import shapely
dep_m = shapely.transform(dep, lambda c: np.column_stack([c[:, 0] * R / 180, np.log(np.tan(np.pi / 4 + np.radians(c[:, 1]) / 2)) * R / np.pi])).buffer(2000)

src = rasterio.open(SRC)
w, s, e, n = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
total = 0; count = 0
for z in range(ZMIN, ZMAX + 1):
    N = 2 ** z; size = 2 * R / N
    def tx(lon): return int((lon + 180) / 360 * N)
    def ty(lat): return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N)
    for x in range(tx(w), tx(e) + 1):
        for y in range(ty(n), ty(s) + 1):
            x0 = -R + x * size; y1 = R - y * size
            if not dep_m.intersects(box(x0, y1 - size, x0 + size, y1)): continue
            tr = from_bounds(x0, y1 - size, x0 + size, y1, 256, 256)
            a = np.full((256, 256), np.nan, "float32")
            reproject(rasterio.band(src, 1), a, dst_transform=tr, dst_crs="EPSG:3857", src_nodata=src.nodata,
                      dst_nodata=np.nan, resampling=Resampling.bilinear if z == ZMAX else Resampling.average)
            inside = rasterize([mapping(dep_m)], out_shape=(256, 256), transform=tr, fill=0, default_value=1, all_touched=True).astype(bool)
            ok = inside & np.isfinite(a) & (a > 0)
            if not ok.any(): continue
            h = np.where(ok, np.clip(np.rint(a), 1, 65535), 0).astype(np.uint16)
            rgb = np.zeros((256, 256, 3), np.uint8); rgb[..., 0] = h >> 8; rgb[..., 1] = h & 255
            p = os.path.join(OUT, str(z), str(x)); os.makedirs(p, exist_ok=True)
            f = os.path.join(p, f"{y}.webp"); Image.fromarray(rgb, "RGB").save(f, "WEBP", lossless=True, quality=100, method=6)
            total += os.path.getsize(f); count += 1
    print(f"z{z}: {count} tiles so far, {total / 1e6:.1f} MB", flush=True)
