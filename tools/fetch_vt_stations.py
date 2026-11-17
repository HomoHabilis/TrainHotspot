#!/usr/bin/env python3
"""Fetch ViaggiaTreno station codes + coordinates (factual reference data) for matching.
Best effort: writes [] on failure. Usage: fetch_vt_stations.py out.json"""
import json, sys, urllib.request

BASE = "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/elencoStazioni/"
out = {}
for region in range(0, 23):
    try:
        with urllib.request.urlopen(BASE + str(region), timeout=30) as r:
            for s in json.load(r):
                code, lat, lon = s.get("codiceStazione"), s.get("lat"), s.get("lon")
                if code and lat and lon:
                    out[code] = {"code": code, "lat": float(lat), "lon": float(lon),
                                 "name": (s.get("localita") or {}).get("nomeLungo", "")}
    except Exception as e:  # noqa: BLE001
        print(f"region {region}: {e}")
json.dump(list(out.values()), open(sys.argv[1], "w"))
print(f"{len(out)} ViaggiaTreno stations")
