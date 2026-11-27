#!/usr/bin/env python3
"""Fetch the Davis stations of the SAT's WeatherLink account (API v2) and write a small public JSON for the map and the rain alerts.

Usage: weatherlink_davis.py PREVIOUS.json OUTPUT.json
Needs WEATHERLINK_API_KEY and WEATHERLINK_API_SECRET (GitHub Actions secrets). Without them it prints a note and exits 0
without writing anything. The secret only travels in a request header to api.weatherlink.com; the output holds readings only.

WeatherLink reports in US units (°F, mph, inHg); this converts to °C, km/h and hPa. Rain comes in mm from the *_mm fields.
Each run appends the rain that fell since the previous run (from the station's year or day rain counter) to a 7-day
history, so the page and the alert job can sum any window (24 h, 72 h) without the paid historic endpoint."""
import json, os, sys, time, pathlib, urllib.request, urllib.error

API = "https://api.weatherlink.com/v2/"
KEEP = 7 * 86400  # seconds of rain history kept per station


def get(path, key, secret):
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(API + path + sep + "api-key=" + key,
                                 headers={"X-Api-Secret": secret, "Accept": "application/json", "User-Agent": "sat-tolima-dashboard"})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                sys.exit(f"WeatherLink rechazó la llave ({e.code}): revise los secretos WEATHERLINK_API_KEY y WEATHERLINK_API_SECRET.")
            if i == 2 or e.code < 500 and e.code != 429: raise
        except (urllib.error.URLError, TimeoutError):
            if i == 2: raise
        time.sleep(5 * (i + 1))


def first(rows, *keys):
    """First non-null value of any of `keys` across the sensor data rows (WeatherLink names fields differently per device)."""
    for k in keys:
        for d in rows:
            v = d.get(k)
            if v is not None and v != "": return v
    return None


f2c = lambda f: None if f is None else round((f - 32) * 5 / 9, 1)
mph = lambda v: None if v is None else round(v * 1.609344, 1)
inhg = lambda v: None if v is None else round(v * 33.8639, 1)
rnd = lambda v, d=1: None if v is None else round(float(v), d)


def reading(cur):
    """Flatten /current sensors into one reading. Outdoor fields first; indoor console values (temp_in, hum_in) are ignored."""
    rows = [d for s in cur.get("sensors") or [] for d in (s.get("data") or []) if isinstance(d, dict)]
    ts = max([d["ts"] for d in rows if isinstance(d.get("ts"), (int, float))] or [None]) if rows else None
    return {
        "ts": ts,
        "t": f2c(first(rows, "temp", "temp_out", "temp_last")),
        "hr": rnd(first(rows, "hum", "hum_out", "hum_last"), 0),
        "v": mph(first(rows, "wind_speed_last", "wind_speed", "wind_speed_avg_last_1_min", "wind_speed_avg_last_10_min")),
        "dir": rnd(first(rows, "wind_dir_last", "wind_dir", "wind_dir_scalar_avg_last_1_min", "wind_dir_scalar_avg_last_10_min"), 0),
        "raf": mph(first(rows, "wind_speed_hi_last_10_min", "wind_gust_10_min", "wind_speed_hi_last_2_min")),
        "p": inhg(first(rows, "bar_sea_level", "bar", "bar_absolute")),
        "int": rnd(first(rows, "rain_rate_last_mm", "rain_rate_mm", "rain_rate_hi_mm")),
        "hoy": rnd(first(rows, "rainfall_daily_mm", "rain_day_mm", "rainfall_day_mm")),
        "r24": rnd(first(rows, "rainfall_last_24_hr_mm", "rain_24_hr_mm")),
        "r1": rnd(first(rows, "rainfall_last_60_min_mm", "rain_60_min_mm")),
        "_year": first(rows, "rainfall_year_mm", "rain_year_mm"),
        "_day": first(rows, "rainfall_daily_mm", "rain_day_mm", "rainfall_day_mm"),
    }


def increment(prev_c, r):
    """Rain (mm) since the previous run, from the year counter if the station gives one, else the day counter.
    A counter that went down was reset (new year / new day), so all of its value is new rain."""
    for k in ("_year", "_day"):
        cur, old = r.get(k), (prev_c or {}).get(k[1:])
        if cur is None: continue
        if old is None: return None  # first sample: nothing to compare with yet
        return round(cur - old if cur >= old - 0.05 else cur, 2)
    return None


def main(prev_path, out_path):
    key, secret = os.environ.get("WEATHERLINK_API_KEY", "").strip(), os.environ.get("WEATHERLINK_API_SECRET", "").strip()
    if not key or not secret:
        print("Faltan los secretos WEATHERLINK_API_KEY y WEATHERLINK_API_SECRET: no se actualizan las estaciones Davis.")
        return
    try: prev = json.loads(pathlib.Path(prev_path).read_text())
    except Exception: prev = {}
    old = {str(s["id"]): s for s in prev.get("est") or []}
    now = int(time.time())
    stations = get("stations", key, secret).get("stations") or []
    out = []
    for st in stations:
        sid = str(st.get("station_id"))
        o = old.get(sid, {})
        try: r = reading(get(f"current/{sid}", key, secret))
        except Exception as e:
            print("sin datos de", sid, st.get("station_name"), e)
            if o: out.append(o)  # keep the last good copy; the page marks it as old
            continue
        hist = [h for h in o.get("h") or [] if h[0] > now - KEEP]
        same = r["ts"] is not None and r["ts"] == o.get("ts")
        inc = None if same else increment(o.get("c"), r)
        if inc is not None and r["ts"]: hist.append([int(r["ts"]), max(0.0, inc)])
        rec = {"id": sid, "n": (st.get("station_name") or f"Estación {sid}").strip(), "ciudad": (st.get("city") or "").strip(),
               "lat": st.get("latitude"), "lon": st.get("longitude"), "alt": st.get("elevation"),
               **{k: v for k, v in r.items() if not k.startswith("_")},
               "c": {"year": r["_year"], "day": r["_day"]} if not same else o.get("c"), "h": hist}
        if rec["lat"] is None or rec["lon"] is None: print("sin coordenadas:", rec["n"])
        out.append(rec)
        time.sleep(0.2)
    if not out: sys.exit("WeatherLink no devolvió estaciones; se conserva el archivo anterior")
    data = {"updated": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(now)), "source": "Davis Instruments, WeatherLink API v2", "est": out}
    p = pathlib.Path(out_path); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print("wrote", out_path, [(s["n"], s.get("t"), s.get("hoy")) for s in out])


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "davis-anterior.json", sys.argv[2] if len(sys.argv) > 2 else "davis-salida/davis.json")
