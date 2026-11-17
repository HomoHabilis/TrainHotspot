#!/usr/bin/env python3
"""Build TrainHotspot's static rail data from an OpenStreetMap extract.

Input : a .osm.pbf already filtered to railway ways and station nodes
        (see .github/workflows/build-data.yml), or the full Italy extract.
Output: app/data/graph.json    rail graph (nodes, edges with geometry, tunnel flag, maxspeed)
        app/data/stations.json stations with the graph nodes they snap to

Data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json
import math
import sys
import time
from collections import defaultdict

import osmium

EXCLUDED_SERVICE = {"yard", "siding", "spur"}
EXCLUDED_USAGE = {"industrial", "military", "test"}
TUNNEL_VALUES = {"yes", "building_passage", "avalanche_protector", "culvert"}
SIMPLIFY_M = 8.0          # Douglas-Peucker tolerance
SNAP_RADIUS_M = 180.0     # station -> track nodes
SNAP_MAX = 8              # candidate graph nodes per station


def parse_speed(v):
    if not v:
        return 0
    v = v.split(";")[0].strip().lower()
    try:
        if v.endswith("mph"):
            return int(float(v[:-3]) * 1.609)
        return int(float(v.replace("km/h", "").strip()))
    except ValueError:
        return 0


def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []          # (nodes[(id,lat,lon)], tags)
        self.stations = []      # (name, lat, lon, tags)
        self.node_use = defaultdict(int)
        self.node_ways = defaultdict(list)

    def node(self, n):
        t = n.tags
        rw = t.get("railway")
        if rw in ("station", "halt") and "name" in t and n.location.valid():
            if t.get("station") in ("subway", "light_rail", "funicular", "monorail"):
                return
            self.stations.append((t["name"], n.location.lat, n.location.lon,
                                  {"uic": t.get("uic_ref", ""), "kind": rw}))

    def way(self, w):
        t = w.tags
        if t.get("railway") != "rail":
            return
        if t.get("service") in EXCLUDED_SERVICE or t.get("usage") in EXCLUDED_USAGE:
            return
        try:
            nodes = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2:
            return
        tunnel = t.get("tunnel") in TUNNEL_VALUES
        info = {
            "tunnel": 1 if tunnel else 0,
            "speed": parse_speed(t.get("maxspeed")),
            "hs": 1 if t.get("highspeed") == "yes" else 0,
            "name": (t.get("tunnel:name") or t.get("name") or "") if tunnel else "",
        }
        self.ways.append((nodes, info))
        widx = len(self.ways) - 1
        for i, (nid, _, _) in enumerate(nodes):
            self.node_ways[nid].append(widx)
            # endpoints count double so they always become graph nodes
            self.node_use[nid] += 2 if i in (0, len(nodes) - 1) else 1


def dp_simplify(pts, tol):
    """Douglas-Peucker on (lat, lon) using a local equirectangular projection."""
    if len(pts) <= 2:
        return pts
    lat0 = math.radians(pts[0][0])
    kx = 111320.0 * math.cos(lat0)
    ky = 110540.0
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        dd = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if dd == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / dd))
                d = math.hypot(px - (ax + u * dx), py - (ay + u * dy))
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def main(pbf, outdir, vt_stations_path=None):
    t0 = time.time()
    h = Collector()
    h.apply_file(pbf, locations=True, idx="flex_mem")
    print(f"read {len(h.ways)} rail ways, {len(h.stations)} stations in {time.time()-t0:.0f}s")

    # node coordinates of all rail nodes (for station snapping)
    coord = {}
    for nodes, _ in h.ways:
        for nid, lat, lon in nodes:
            coord[nid] = (lat, lon)

    # spatial grid of rail nodes, ~0.005 deg cells
    G = 0.005
    grid = defaultdict(list)
    for nid, (lat, lon) in coord.items():
        grid[(int(lat / G), int(lon / G))].append(nid)

    forced = set()
    station_cands = []
    for name, lat, lon, extra in h.stations:
        ci, cj = int(lat / G), int(lon / G)
        found = []
        for di in (-2, -1, 0, 1, 2):
            for dj in (-3, -2, -1, 0, 1, 2, 3):
                for nid in grid.get((ci + di, cj + dj), ()):
                    nl, no = coord[nid]
                    d = haversine(lat, lon, nl, no)
                    if d <= SNAP_RADIUS_M:
                        found.append((d, nid))
        found.sort()
        # nearest node on each distinct way (track), up to SNAP_MAX tracks
        cands, used_ways = [], set()
        for _, nid in found:
            ws = h.node_ways[nid]
            if all(w in used_ways for w in ws):
                continue
            used_ways.update(ws)
            cands.append(nid)
            if len(cands) >= SNAP_MAX:
                break
        station_cands.append(cands)
        forced.update(cands)

    # graph nodes = junctions, way endpoints, station snap nodes
    is_gnode = lambda nid: h.node_use[nid] >= 2 or nid in forced
    gindex = {}
    gnodes = []

    def gid(nid):
        if nid not in gindex:
            gindex[nid] = len(gnodes)
            lat, lon = coord[nid]
            gnodes.append((round(lat, 6), round(lon, 6)))
        return gindex[nid]

    edges = []
    for nodes, info in h.ways:
        start = 0
        for i in range(1, len(nodes)):
            if is_gnode(nodes[i][0]) or i == len(nodes) - 1:
                seg = nodes[start:i + 1]
                pts = [(lat, lon) for _, lat, lon in seg]
                length = sum(haversine(*pts[k], *pts[k + 1]) for k in range(len(pts) - 1))
                simp = dp_simplify(pts, SIMPLIFY_M)
                edges.append((gid(seg[0][0]), gid(seg[-1][0]), length, info, simp))
                start = i

    # encode edges: [a, b, length_m, tunnel, speed, hs, name_idx, delta-encoded inner coords (1e5)]
    names = [""]
    name_idx = {"": 0}
    out_edges = []
    for a, b, length, info, simp in edges:
        n = info["name"]
        if n not in name_idx:
            name_idx[n] = len(names)
            names.append(n)
        inner = []
        plat, plon = int(round(simp[0][0] * 1e5)), int(round(simp[0][1] * 1e5))
        for lat, lon in simp[1:-1]:
            ilat, ilon = int(round(lat * 1e5)), int(round(lon * 1e5))
            inner += [ilat - plat, ilon - plon]
            plat, plon = ilat, ilon
        out_edges.append([a, b, int(round(length)), info["tunnel"], info["speed"], info["hs"], name_idx[n], inner])

    graph = {
        "v": 1,
        "built": time.strftime("%Y-%m-%d"),
        "attribution": "Rail data (c) OpenStreetMap contributors, ODbL 1.0",
        "nodes": [c for pair in gnodes for c in (int(round(pair[0] * 1e5)), int(round(pair[1] * 1e5)))],
        "edges": out_edges,
        "names": names,
    }

    # optional ViaggiaTreno station codes, matched by distance
    vt = []
    if vt_stations_path:
        try:
            with open(vt_stations_path) as f:
                vt = json.load(f)
        except (OSError, ValueError):
            vt = []

    out_st = []
    seen = set()
    for (name, lat, lon, extra), cands in zip(h.stations, station_cands):
        if not cands:
            continue
        key = (name, round(lat, 3), round(lon, 3))
        if key in seen:
            continue
        seen.add(key)
        st = {"n": name, "la": round(lat, 5), "lo": round(lon, 5), "g": [gindex[c] for c in cands if c in gindex]}
        if not st["g"]:
            continue
        best = None
        for v in vt:
            d = haversine(lat, lon, v["lat"], v["lon"])
            if d < 600 and (best is None or d < best[0]):
                best = (d, v["code"])
        if best:
            st["vt"] = best[1]
        out_st.append(st)
    out_st.sort(key=lambda s: s["n"])

    with open(f"{outdir}/graph.json", "w") as f:
        json.dump(graph, f, separators=(",", ":"))
    with open(f"{outdir}/stations.json", "w") as f:
        json.dump({"v": 1, "built": graph["built"], "attribution": graph["attribution"], "stations": out_st},
                  f, separators=(",", ":"), ensure_ascii=False)
    print(f"graph: {len(gnodes)} nodes, {len(out_edges)} edges, {sum(e[3] for e in out_edges)} tunnel edges; "
          f"{len(out_st)} stations ({sum(1 for s in out_st if 'vt' in s)} with ViaggiaTreno code); {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
