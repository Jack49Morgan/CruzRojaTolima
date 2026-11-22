#!/usr/bin/env python3
"""Keep a growing list of SGC earthquakes (M4+, Tolima and ~150 km around) in data/sismos-sgc.json.
Source: the public feed behind www.sgc.gov.co/sismos (archive.sgc.gov.co, last five days). It doesn't allow
browsers on other sites to read it, so this runs on a schedule (GitHub Actions) and adds new events to the file.
Usage: sgc_sismos.py data/sismos-sgc.json"""
import json, sys, urllib.request, datetime as dt, pathlib
FEED = "https://archive.sgc.gov.co/feed/v1.0.1/summary/five_days_all.json"
BOX = (2.0, 6.5, -77.0, -73.0)   # lat min, lat max, lon min, lon max (same area the page used before)
MINMAG = 4.0
def num(x):
    try: return float(x)
    except (TypeError, ValueError): return None
def norm(f):
    p = f.get("properties") or {}
    c = (f.get("geometry") or {}).get("coordinates") or []
    if len(c) < 2: return None
    a, b = num(c[0]), num(c[1])
    # the SGC archive feed writes [lat, lon, depth]; standard GeoJSON is [lon, lat, depth]. Colombia: lat ~ -5..13, lon ~ -82..-66
    lat, lon = (a, b) if a is not None and a > -20 and (b or 0) < -50 else (b, a)
    dep = num(c[2]) if len(c) > 2 else num(p.get("depth"))
    t = p.get("utcTime") or p.get("time")
    if isinstance(t, (int, float)): t = dt.datetime.utcfromtimestamp(t / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")
    mag = num(p.get("mag"))
    if None in (lat, lon, mag) or not t: return None
    return {"id": str(f.get("id") or p.get("id") or t), "t": str(t).replace(" ", "T"), "mag": round(mag, 1),
            "mt": p.get("magType"), "lat": round(lat, 4), "lon": round(lon, 4), "dep": None if dep is None else round(dep, 1),
            "place": p.get("place") or p.get("closerTowns") or p.get("locality") or "", "status": p.get("status"),
            "mmi": p.get("mmi")}
def main(path):
    req = urllib.request.Request(FEED, headers={"User-Agent": "sat-tolima-dashboard (Cruz Roja Tolima)"})
    with urllib.request.urlopen(req, timeout=60) as r: j = json.load(r)
    feats = j.get("features") or []
    if feats: print("sample properties:", sorted((feats[0].get("properties") or {}).keys()), feats[0].get("geometry"))
    p = pathlib.Path(path)
    old = json.loads(p.read_text()) if p.exists() else {"events": []}
    ev = {e["id"]: e for e in old.get("events", [])}
    n0 = len(ev)
    for f in feats:
        if (f.get("properties") or {}).get("agency") not in (None, "SGC"): continue
        e = norm(f)
        if not e or e["mag"] < MINMAG: continue
        if not (BOX[0] <= e["lat"] <= BOX[1] and BOX[2] <= e["lon"] <= BOX[3]): continue
        ev[e["id"]] = e   # newer copy wins (automatic -> reviewed)
    data = {"updated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "source": "Servicio Geológico Colombiano (archive.sgc.gov.co)",
            "minmag": MINMAG, "box": BOX, "since": old.get("since") or dt.datetime.utcnow().strftime("%Y-%m-%d"),
            "events": sorted(ev.values(), key=lambda e: e["t"], reverse=True)}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {path}: {len(ev)} events ({len(ev) - n0} new) from {len(feats)} in feed")
if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/sismos-sgc.json")
