"""One-off probe of SGC services for dated mass-movement records (runs in GitHub Actions)."""
import json, sys, urllib.request, urllib.parse
out = {}
def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (SAT Tolima dashboard)"})
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
        try: return json.loads(b)
        except Exception: return {"_text": b[:3000].decode("utf-8", "replace")}
    except Exception as e:
        return {"_error": repr(e)[:500]}
def slim_layer(j):
    if not isinstance(j, dict): return j
    return {k: j.get(k) for k in ("name", "type", "geometryType", "maxRecordCount", "_error", "_text")} | {
        "fields": [(f.get("name"), f.get("type"), f.get("alias")) for f in j.get("fields") or []]}
bases = ["https://geoportal.sgc.gov.co/arcgis/rest/services/SIMMA",
         "https://srvags.sgc.gov.co/arcgis/rest/services/SIMMA"]
for base in bases:
    d = get(base + "?f=json"); out[base] = d
    for s in (d.get("services") or [])[:20]:
        su = f"{base.rsplit('/SIMMA',1)[0]}/{s['name']}/{s['type']}"
        sj = get(su + "?f=json")
        out[su] = {"layers": [(l.get("id"), l.get("name")) for l in sj.get("layers") or []], "_error": sj.get("_error")}
        for l in (sj.get("layers") or [])[:15]:
            lu = f"{su}/{l['id']}"
            out[lu] = slim_layer(get(lu + "?f=json"))
            q = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "resultRecordCount": 2, "returnGeometry": "false", "f": "json"})
            fj = get(f"{lu}/query?{q}")
            out[lu]["sample"] = [f.get("attributes") for f in fj.get("features") or []] or fj.get("error") or fj.get("_error")
    if d.get("services"): break
item = get("https://www.arcgis.com/sharing/rest/content/items/312c8792ddb24954a9d2711bd89d1afe?f=json")
out["hub_item"] = {k: item.get(k) for k in ("title", "url", "type", "modified", "_error")}
if item.get("url"):
    lu = item["url"].rstrip("/")
    if not lu.split("/")[-1].isdigit(): lu += "/0"
    out["hub_layer"] = slim_layer(get(lu + "?f=json"))
    q = urllib.parse.urlencode({"where": "1=1", "outFields": "*", "resultRecordCount": 3, "returnGeometry": "true", "outSR": 4326, "f": "json"})
    out["hub_sample"] = get(f"{lu}/query?{q}")
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, indent=1, default=str)
