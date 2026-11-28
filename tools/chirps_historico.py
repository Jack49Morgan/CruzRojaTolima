#!/usr/bin/env python3
"""Monthly CHIRPS rain (1981 to the latest month) averaged over each Tolima municipio, plus the NOAA ONI index
(El Niño / La Niña), into data/historico-lluvia.json for the "Histórico climático" panel.

CHIRPS v2.0 monthly (UCSB Climate Hazards Center) is read for the Tolima box only, as netCDF, from the IRI/LDEO
Data Library, which cuts the subset on its side (a few MB instead of the global files). Municipio shapes are the
ones the dashboard draws (TOLIMA_GEO in index.html). Each 0.05° CHIRPS cell counts with the share of its area that
falls in the municipio (5x5 sample points per cell), so small municipios are measured fairly.

Neither source lets browsers on other sites read it, so this runs monthly on GitHub Actions (historico.yml).
Usage: python3 tools/chirps_historico.py [index.html] [data/historico-lluvia.json]
Needs numpy and scipy (scipy only to read the netCDF file)."""
import datetime as dt, io, json, pathlib, re, sys, time, urllib.request
import numpy as np
from scipy.io import netcdf_file

BOX = (-76.15, -74.35, 2.80, 5.40)          # W, E, S, N: Tolima plus a margin
IRI = ("https://iridl.ldeo.columbia.edu/SOURCES/.UCSB/.CHIRPS/.v2p0/.monthly/.global/.precipitation/"
       "X/{w}/{e}/RANGEEDGES/Y/{s}/{n}/RANGEEDGES/data.nc")
ONI_URLS = ["https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt",
            "https://origin.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"]
START = 1981
UA = {"User-Agent": "sat-tolima-dashboard (GitHub Actions)"}


def fetch(url, timeout=300, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - network errors of every kind get a retry
            if i == tries - 1: raise
            print(f"retry {url}: {e}", file=sys.stderr); time.sleep(10 * (i + 1))


def municipios(index_html):
    s = pathlib.Path(index_html).read_text(encoding="utf8")
    g = json.loads(re.search(r"const TOLIMA_GEO = (\{.*?\});\n", s).group(1))
    out = {}
    for f in g["mun"]["features"]:
        geom = f["geometry"]
        polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        out[f["properties"]["n"]] = polys
    return out


def inside(px, py, poly):
    """Even-odd point-in-polygon for arrays of points; poly = [outer ring, holes...]."""
    res = np.zeros(px.shape, bool)
    for ring in poly:
        r = np.asarray(ring, float); x1, y1 = r[:, 0], r[:, 1]; x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
        for a, b, c, d in zip(x1, y1, x2, y2):
            if b == d: continue
            hit = ((b > py) != (d > py)) & (px < (c - a) * (py - b) / (d - b) + a)
            res ^= hit
    return res


def weights(lons, lats, polys, sub=5):
    """Share (0..1) of each grid cell inside the municipio, shape (len(lats), len(lons))."""
    dx, dy = abs(lons[1] - lons[0]), abs(lats[1] - lats[0])
    off = (np.arange(sub) + 0.5) / sub - 0.5
    gx, gy = np.meshgrid(lons, lats); sx, sy = np.meshgrid(off * dx, off * dy)
    px = (gx[..., None] + sx.ravel()).ravel(); py = (gy[..., None] + sy.ravel()).ravel()
    xs = np.concatenate([np.asarray(r)[:, 0] for p in polys for r in p]); ys = np.concatenate([np.asarray(r)[:, 1] for p in polys for r in p])
    box = (px >= xs.min()) & (px <= xs.max()) & (py >= ys.min()) & (py <= ys.max())
    hit = np.zeros(px.shape, bool)
    for p in polys: hit[box] |= inside(px[box], py[box], p)
    return hit.reshape(len(lats), len(lons), sub * sub).mean(axis=2)


def chirps():
    w, e, s, n = BOX
    raw = fetch(IRI.format(w=w, e=e, s=s, n=n))
    nc = netcdf_file(io.BytesIO(raw), mmap=False)
    v = nc.variables
    name = next(k for k in v if k.lower().startswith("prec"))
    p = v[name]
    data = np.array(p.data, float)
    for att in ("missing_value", "_FillValue"):
        mv = getattr(p, att, None)
        if mv is not None: data[np.isclose(data, float(np.ravel(mv)[0]))] = np.nan
    data[data < 0] = np.nan
    units = (getattr(p, "units", b"") or b"").decode() if isinstance(getattr(p, "units", b""), bytes) else str(getattr(p, "units", ""))
    dims = p.dimensions                                     # e.g. ('T', 'Y', 'X')
    tname = next(d for d in dims if d.upper().startswith("T"))
    yname = next(d for d in dims if d.upper().startswith(("Y", "LAT")))
    xname = next(d for d in dims if d.upper().startswith(("X", "LON")))
    data = np.transpose(data, (dims.index(tname), dims.index(yname), dims.index(xname)))
    t = np.array(v[tname].data, float); lats = np.array(v[yname].data, float); lons = np.array(v[xname].data, float)
    tu = v[tname].units.decode() if isinstance(v[tname].units, bytes) else v[tname].units
    m0 = re.match(r"months since (\d{4})-(\d{2})", tu)
    if not m0: raise SystemExit(f"unexpected time units: {tu}")
    base = int(m0.group(1)) * 12 + int(m0.group(2)) - 1
    months = [(base + int(np.floor(x))) for x in t]          # absolute month index (year*12 + month0)
    if "day" in units.lower():                              # mm/day -> mm in the month
        for i, mi in enumerate(months):
            y, m = divmod(mi, 12)
            nd = (dt.date(y + (m == 11), (m + 1) % 12 + 1, 1) - dt.date(y, m + 1, 1)).days
            data[i] *= nd
    nc.close()
    return months, lats, lons, data, units


def oni():
    """{absolute month index: ONI} with each 3-month season placed on its middle month (DJF -> January)."""
    seas = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
    for u in ONI_URLS:
        try: txt = fetch(u, timeout=60, tries=2).decode()
        except Exception as e: print(f"ONI {u}: {e}", file=sys.stderr); continue  # noqa: BLE001
        out = {}
        for line in txt.splitlines():
            f = line.split()
            if len(f) >= 4 and f[0] in seas:
                try: out[int(f[1]) * 12 + seas.index(f[0])] = float(f[3])
                except ValueError: pass
        if out: return out
    return {}


def phases(vals):
    """NOAA rule: El Niño (N) / La Niña (L) when ONI >= +0.5 / <= -0.5 for at least 5 overlapping seasons in a row."""
    ph = ["."] * len(vals)
    for sign, ch in ((1, "N"), (-1, "L")):
        i = 0
        while i < len(vals):
            j = i
            while j < len(vals) and vals[j] is not None and sign * vals[j] >= 0.5: j += 1
            if j - i >= 5: ph[i:j] = ch * (j - i)
            i = max(j, i + 1)
    return "".join(ph)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "index.html"
    dst = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "data/historico-lluvia.json")
    muns = municipios(src)
    months, lats, lons, data, units = chirps()
    keep = [i for i, m in enumerate(months) if m >= START * 12]
    months = [months[i] for i in keep]; data = data[keep]
    # drop trailing months that are all missing (the data library sometimes lists a month before it is filled)
    while months and np.isnan(data[-1]).all(): months.pop(); data = data[:-1]
    m0, m1 = months[0], months[-1]
    n = m1 - m0 + 1
    full = np.full((n,) + data.shape[1:], np.nan); full[[m - m0 for m in months]] = data
    out, wall = {}, np.zeros(data.shape[1:])
    for name, polys in muns.items():
        wt = weights(lons, lats, polys)
        if wt.sum() == 0: raise SystemExit(f"no CHIRPS cells for {name}")
        wall += wt
        out[name] = wt
    series = {}
    for name, wt in list(out.items()) + [("Tolima", np.minimum(wall, 1))]:
        ok = ~np.isnan(full)
        num = np.nansum(full * wt, axis=(1, 2)); den = (ok * wt).sum(axis=(1, 2))
        vals = np.where(den > 0.5 * wt.sum(), num / np.maximum(den, 1e-9), np.nan)
        series[name] = [None if np.isnan(x) else int(round(x)) for x in vals]
    tol = [x for x in series["Tolima"] if x is not None]
    if np.mean(tol) * 12 < 500 or np.mean(tol) * 12 > 6000:
        raise SystemExit(f"implausible Tolima annual rain {np.mean(tol) * 12:.0f} mm (units {units!r})")
    o = oni(); ov = [o.get(m) for m in range(m0, m1 + 1)]
    res = {
        "fuente": "CHIRPS v2.0 mensual (Climate Hazards Center, UCSB), vía IRI/LDEO Data Library; índice ONI de NOAA CPC",
        "actualizado": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "inicio": f"{m0 // 12}-{m0 % 12 + 1:02d}",
        "fin": f"{m1 // 12}-{m1 % 12 + 1:02d}",
        "unidad": "mm por mes, promedio del municipio",
        "oni": [None if x is None else round(x, 1) for x in ov],
        "fase": phases(ov),
        "mun": series,
    }
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"{dst}: {res['inicio']}..{res['fin']}, {len(series)} series, {dst.stat().st_size / 1024:.0f} KB, Tolima mean {np.mean(tol) * 12:.0f} mm/año")


if __name__ == "__main__":
    main()
