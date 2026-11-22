#!/usr/bin/env python3
"""Fetch daily reservoir data for Tolima and neighbours from XM's open API (servapibi.xm.com.co) into data/embalses.json.
XM's API does not allow browsers on other sites to read it, so this runs on a schedule (GitHub Actions) and the page reads the JSON file."""
import json, sys, urllib.request, datetime as dt, pathlib
API = "https://servapibi.xm.com.co/daily"
EMB = ["PRADO", "BETANIA", "EL QUIMBO", "AMANI"]
RIO = ["PRADO", "AMOYA", "CUCUANA", "MIEL I", "BETANIA CP", "EL QUIMBO"]
def get(metric, entity, names, start, end):
    body = json.dumps({"MetricId": metric, "StartDate": start, "EndDate": end, "Entity": entity}).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "User-Agent": "sat-tolima-dashboard"})
    with urllib.request.urlopen(req, timeout=60) as r: j = json.load(r)
    out = {}
    for it in j.get("Items") or []:
        for e in it["DailyEntities"]:
            if e["Name"] in names and e.get("Value") not in (None, ""): out.setdefault(e["Name"], {})[it["Date"]] = float(e["Value"])
    return out
def main(path):
    end = (dt.datetime.utcnow() - dt.timedelta(hours=5)).date()
    start = end - dt.timedelta(days=30)
    s, e = start.isoformat(), end.isoformat()
    pct, vol, cap = (get(m, "Embalse", EMB, s, e) for m in ("PorcVoluUtilDiar", "VoluUtilDiarMasa", "CapaUtilDiarMasa"))
    q, qh = (get(m, "Rio", RIO, s, e) for m in ("AporCaudal", "AporCaudalMediHist"))
    emb = {n: [[d, round(pct[n][d] * 100, 2), round(vol.get(n, {}).get(d, 0) / 1e6, 2), round(cap.get(n, {}).get(d, 0) / 1e6, 2)] for d in sorted(pct.get(n, {}))] for n in EMB}
    rio = {n: [[d, q[n][d], qh.get(n, {}).get(d)] for d in sorted(q.get(n, {}))] for n in RIO}
    if not any(emb.values()): sys.exit("XM returned no reservoir data; keeping the old file")
    data = {"updated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"), "source": "XM, API pública (servapibi.xm.com.co)", "emb": emb, "rio": rio}
    p = pathlib.Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print("wrote", path, {n: (v[-1] if v else None) for n, v in emb.items()})
if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/embalses.json")
