import json, urllib.request
def post(ep, body):
    req = urllib.request.Request("https://servapibi.xm.com.co/" + ep, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "sat-tolima-dashboard"})
    with urllib.request.urlopen(req, timeout=90) as r: return json.load(r)
try:
    j = post("lists", {"MetricId": "ListadoRecursos", "Entity": "Sistema"})
    it = j.get("Items") or []
    print("lists items", len(it), list(it[0].keys()) if it else None)
    for x in it[:1]:
        ents = x.get("ListEntities") or []
        print(len(ents), ents[:1])
        for e in ents:
            if any(k in json.dumps(e, ensure_ascii=False).upper() for k in ("AMOY", "ESPERANZA", "CUCUANA")): print("MATCH", e)
except Exception as ex: print("lists err", ex)
j = post("hourly", {"MetricId": "Gene", "StartDate": "2026-11-20", "EndDate": "2026-11-23", "Entity": "Recurso"})
it = j.get("Items") or []
print("hourly items", len(it), [x.get("Date") for x in it])
if it:
    ents = it[-1]["HourlyEntities"]; print(len(ents), ents[0])
    for e in ents:
        s = json.dumps(e).upper()
        if "AMY" in s or "AMO" in s or "CUC" in s: print("H", e)
