#!/usr/bin/env python3
"""Copy the SGC alert level and latest bulletins of the volcanoes that matter for Tolima into data/volcanes-sgc.json.
Source: https://archive.sgc.gov.co/volcanos/volcanos.json, the file behind www.sgc.gov.co/volcanes. SGC only lets its own
pages read it from a browser and answers 403 to GitHub Actions (checked 2026-11-24), so run this by hand from a
Colombian connection, or save volcanos.json from sgc.gov.co/volcanes and pass it with --from. The old file is kept on errors.
Usage: sgc_volcanes.py [out.json] [--from saved_volcanos.json]"""
import json, sys, urllib.request, datetime as dt, pathlib
SRC = "https://archive.sgc.gov.co/volcanos/volcanos.json"
IDS = [10, 12, 13]  # Cerro Machín, Nevado del Ruiz, Nevado del Tolima
def compact(src):
    out = []
    for f in src["features"]:
        if f.get("id") not in IDS: continue
        p = f["properties"]; b = sorted(p.get("bulletins") or [], key=lambda x: x.get("publication_date") or "", reverse=True)
        pick = []
        for kind in ("Semanales", "Mensuales"):
            x = next((x for x in b if x.get("type") == kind), None)
            if x: pick.append({"n": x["name"], "d": x.get("publication_date"), "f": x["file"], "k": kind})
        out.append({"id": f["id"], "n": p["VolcanoName"], "ll": [p["latitude"], p["longitude"]], "m": p.get("msnm"),
                    "lvl": p["activityLevel"], "t": p["activityLevelTitle"], "s": p["activityLevelShortDescription"],
                    "link": p.get("link"), "b": pick})
    return sorted(out, key=lambda v: IDS.index(v["id"]))
def main(path, local=None):
    try:
        if local: src = json.loads(pathlib.Path(local).read_text())
        else:
            req = urllib.request.Request(SRC, headers={"User-Agent": "sat-tolima-dashboard (Cruz Roja Tolima)"})
            with urllib.request.urlopen(req, timeout=60) as r: src = json.load(r)
        volc = compact(src)
    except Exception as e:
        print(f"::warning::SGC volcano data not available ({e}); keeping {path}"); return
    if not volc: print("::warning::no volcanoes found in SGC data; keeping old file"); return
    p = pathlib.Path(path); old = json.loads(p.read_text()) if p.exists() else {}
    if old.get("volc") == volc: print("no change"); return
    data = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "source": SRC, "volc": volc}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print("wrote", path, [(v["n"], v["t"]) for v in volc])
if __name__ == "__main__":
    a = sys.argv[1:]; local = None
    if "--from" in a: i = a.index("--from"); local = a[i + 1]; del a[i:i + 2]
    main(a[0] if a else "data/volcanes-sgc.json", local)
