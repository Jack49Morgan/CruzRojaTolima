#!/usr/bin/env python3
"""Emergencies reported to the UNGRD (Unidad Nacional para la Gestión del Riesgo de Desastres) in Tolima, by municipio,
from its open datasets on datos.gov.co, into data/historico-eventos.json for the "Histórico climático" panel.

datos.gov.co has the UNGRD consolidated emergencies from 2019: wwkg-r6te (2019-2022), rgre-6ak4 (2023-2024) and
2343-nuqp (2025, "Emergencias UNGRD V2"). Add a new id to SETS when the UNGRD publishes the next year.
Usage: python3 tools/ungrd_eventos.py [data/historico-eventos.json]"""
import datetime as dt, json, pathlib, sys, time, unicodedata, urllib.parse, urllib.request

SETS = ["wwkg-r6te", "rgre-6ak4", "2343-nuqp"]
API = "https://www.datos.gov.co/resource/{id}.json"
# event type groups shown in the panel, in this order; anything else is "Otros"
TIPOS = [
    ("Inundación", ["INUNDACION"]),
    ("Creciente súbita / avenida torrencial", ["CRECIENTE SUBITA", "AVENIDA TORRENCIAL"]),
    ("Movimiento en masa", ["MOVIMIENTO EN MASA", "EROSION", "DESLIZAMIENTO"]),
    ("Vendaval / tormenta", ["VENDAVAL", "TEMPORAL", "LLUVIAS", "TORMENTA ELECTRICA", "GRANIZADA"]),
    ("Incendio forestal", ["INCENDIO DE COBERTURA VEGETAL", "INCENDIO FORESTAL", "QUEMA"]),
    ("Sequía / desabastecimiento", ["SEQUIA", "DESABASTECIMIENTO DE AGUA"]),
    ("Otros", []),
]
NAMES = ["Alpujarra", "Alvarado", "Ambalema", "Anzoátegui", "Armero (Guayabal)", "Ataco", "Cajamarca", "Carmen de Apicalá",
         "Casabianca", "Chaparral", "Coello", "Coyaima", "Cunday", "Dolores", "Espinal", "Falan", "Flandes", "Fresno", "Guamo",
         "Herveo", "Honda", "Ibagué", "Icononzo", "Lérida", "Líbano", "Mariquita", "Melgar", "Murillo", "Natagaima", "Ortega",
         "Palocabildo", "Piedras", "Planadas", "Prado", "Purificación", "Rioblanco", "Roncesvalles", "Rovira", "Saldaña",
         "San Antonio", "San Luis", "Santa Isabel", "Suárez", "Valle de San Juan", "Venadillo", "Villahermosa", "Villarrica"]


def key(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().upper()
    return " ".join(s.replace(".", " ").replace("(", " ").replace(")", " ").split())


ALIAS = {key(n): n for n in NAMES}
ALIAS.update({"ARMERO": "Armero (Guayabal)", "ARMERO GUAYABAL": "Armero (Guayabal)", "GUAYABAL": "Armero (Guayabal)",
              "SAN SEBASTIAN DE MARIQUITA": "Mariquita", "EL ESPINAL": "Espinal", "EL GUAMO": "Guamo",
              "CARMEN DE APICALA": "Carmen de Apicalá", "SAN JOSE DE LAS LAJAS": "Lérida", "FALAN": "Falan"})
TIPO_OF = {key(e): i for i, (_, evs) in enumerate(TIPOS) for e in evs}


def num(r, *names):
    for n in names:
        v = r.get(n)
        if v not in (None, ""):
            try: return int(float(str(v).replace(",", "").replace("$", "").strip() or 0))
            except ValueError: pass
    return 0


def rows(ds):
    out, off = [], 0
    while True:
        q = urllib.parse.urlencode({"$where": "departamento='TOLIMA'", "$limit": 5000, "$offset": off, "$order": "fecha"})
        for i in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(API.format(id=ds) + "?" + q, headers={"User-Agent": "sat-tolima-dashboard"}), timeout=120) as r:
                    page = json.load(r); break
            except Exception as e:  # noqa: BLE001
                if i == 3: raise
                print(f"retry {ds}: {e}", file=sys.stderr); time.sleep(5 * (i + 1))
        out += page; off += len(page)
        if len(page) < 5000: return out


def main():
    dst = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/historico-eventos.json")
    mun, seen, unknown = {}, set(), {}
    for ds in SETS:
        for r in rows(ds):
            name = ALIAS.get(key(r.get("municipio")))
            if not name: unknown[r.get("municipio")] = unknown.get(r.get("municipio"), 0) + 1; continue
            fecha = (r.get("fecha") or "")[:10]
            if len(fecha) != 10: continue
            tipo = TIPO_OF.get(key(r.get("evento")), len(TIPOS) - 1)
            ev = [fecha, tipo, num(r, "personas"), num(r, "viviendas_destruidas", "viv_destru") + num(r, "viviendas_averiadas", "viv_aver"),
                  num(r, "fallecidos", "muertos")]
            k = (name, *ev)
            if k in seen: continue                       # the yearly sets overlap at the edges
            seen.add(k); mun.setdefault(name, []).append(ev)
    if unknown: print("municipios sin emparejar:", unknown, file=sys.stderr)
    for v in mun.values(): v.sort()
    n = sum(len(v) for v in mun.values())
    if n < 500: raise SystemExit(f"only {n} events, keeping the previous file")
    fechas = [e[0] for v in mun.values() for e in v]
    res = {"fuente": "UNGRD, consolidado de emergencias en datos.gov.co (" + ", ".join(SETS) + ")",
           "actualizado": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "desde": min(fechas), "hasta": max(fechas),
           "campos": ["fecha", "tipo", "personas afectadas", "viviendas destruidas o averiadas", "fallecidos"],
           "tipos": [t for t, _ in TIPOS], "mun": dict(sorted(mun.items()))}
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"{dst}: {n} eventos {res['desde']}..{res['hasta']}, {dst.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
