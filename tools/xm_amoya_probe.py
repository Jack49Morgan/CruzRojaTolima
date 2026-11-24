import json, urllib.request
def post(ep, body):
    req = urllib.request.Request("https://servapibi.xm.com.co/" + ep, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "sat-tolima-dashboard"})
    with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
codes = set()
j = post("lists", {"MetricId": "ListadoRecursos", "Entity": "Sistema"})
for x in j.get("Items") or []:
    for e in x.get("ListEntities") or []:
        s = json.dumps(e, ensure_ascii=False).upper()
        if "AMOY" in s or "ESPERANZA" in s or "CUCUANA" in s: print("REC", e["Values"]); codes.add(e["Values"]["Code"])
print("codes", codes)
for ep, m, s, e in [("hourly","Gene","2026-11-16","2026-11-23"), ("hourly","GeneProgDesp","2026-11-22","2026-11-25"), ("hourly","DispoReal","2026-11-16","2026-11-23"), ("daily","CapEfecNeta","2026-11-16","2026-11-23"), ("hourly","GeneProgRedesp","2026-11-22","2026-11-25")]:
    try:
        j = post(ep, {"MetricId": m, "StartDate": s, "EndDate": e, "Entity": "Recurso"})
        it = j.get("Items") or []
        print(m, "items", len(it), "dates", sorted({x.get("Date") for x in it}))
        for x in it:
            for en in x.get("HourlyEntities") or x.get("DailyEntities") or []:
                v = en.get("Values", en)
                c = v.get("code") or v.get("Code") or en.get("Name")
                if c in codes: print(" ", m, x["Date"], json.dumps(v)[:400])
    except Exception as ex: print(m, "err", ex)
