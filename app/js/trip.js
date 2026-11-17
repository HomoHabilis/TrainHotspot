// Trip building (route -> polyline, tunnels, time profile) and coverage windows.

const R = 6371008.8;
export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Default speed (km/h) for edges with no maxspeed tag
function effSpeed(spd, hs) {
  if (spd > 0) return spd;
  return hs ? 250 : 110;
}

/**
 * Build a trip package from a routing result.
 * stops: [{ name, arr (ms|null), dep (ms|null) }]   (times may be null for intermediate stops)
 */
export function buildTrip(graph, routeRes, stops, meta = {}) {
  const lat = [], lon = [], cum = [];
  const segs = []; // per graph edge: { s, e, tunnel, speed, name }
  const stopKm = new Array(stops.length).fill(null);
  let km = 0;
  const pushPt = (la, lo) => {
    if (lat.length) {
      const d = haversine(lat[lat.length - 1], lon[lon.length - 1], la, lo) / 1000;
      if (d < 1e-6) return;
      km += d;
    }
    lat.push(la); lon.push(lo); cum.push(km);
  };
  routeRes.legPaths.forEach((edges, li) => {
    for (const { edge, reverse } of edges) {
      const pts = graph.edgeCoords(edge, reverse);
      const s = km;
      for (const [la, lo] of pts) pushPt(la, lo);
      segs.push({ s, e: km, tunnel: graph.etun[edge], speed: effSpeed(graph.espd[edge], graph.ehs[edge]), name: graph.names[graph.edges[edge][6]] || '' });
    }
  });
  // km of each stop: walk path nodes
  {
    let k = 0;
    const nodeKm = new Map();
    const firstNode = routeRes.stopNodes.find((n) => n !== null);
    nodeKm.set(firstNode, 0);
    let si = 0;
    routeRes.legPaths.forEach((edges) => {
      for (const { edge, reverse } of edges) {
        k = segs[si].e; si++;
        nodeKm.set(reverse ? graph.ea[edge] : graph.eb[edge], k);
      }
    });
    // stops in order: take km of their node, searching forward
    routeRes.stopNodes.forEach((n, i) => { if (n !== null && nodeKm.has(n)) stopKm[i] = nodeKm.get(n); });
    stopKm[routeRes.stopNodes.findIndex((n) => n !== null)] = 0;
    const lastIdx = routeRes.stopNodes.length - 1 - [...routeRes.stopNodes].reverse().findIndex((n) => n !== null);
    stopKm[lastIdx] = km;
  }

  // tunnels: merge consecutive tunnel segments
  const tunnels = [];
  for (const sg of segs) {
    if (!sg.tunnel) continue;
    const last = tunnels[tunnels.length - 1];
    if (last && sg.s - last.e < 0.002) { last.e = sg.e; if (!last.name && sg.name) last.name = sg.name; }
    else tunnels.push({ s: sg.s, e: sg.e, name: sg.name });
  }

  // speed profile (merged) for time model and dead reckoning caps
  const speeds = [];
  for (const sg of segs) {
    const last = speeds[speeds.length - 1];
    if (last && last.v === sg.speed) last.e = sg.e; else speeds.push({ s: sg.s, e: sg.e, v: sg.speed });
  }

  const tripStops = stops.map((s, i) => ({ name: s.name, arr: s.arr ?? null, dep: s.dep ?? null, km: stopKm[i], code: s.code || null }))
    .filter((s) => s.km !== null);
  const profile = buildProfile(tripStops, speeds, km, meta.departure);

  return {
    id: meta.id || String(Date.now()),
    title: meta.title || `${tripStops[0].name} → ${tripStops[tripStops.length - 1].name}`,
    created: Date.now(),
    source: meta.source || 'manual',
    train: meta.train || null,
    lengthKm: km,
    lat, lon, cum,
    tunnels, speeds,
    stops: tripStops,
    profile,
    skipped: routeRes.skipped.map((i) => stops[i].name),
  };
}

// Running-time weight of [a,b] km, accounting for line speed and slow zones near stops
function weight(speeds, a, b, stopKms) {
  let w = 0;
  for (const sp of speeds) {
    const s = Math.max(a, sp.s), e = Math.min(b, sp.e);
    if (e <= s) continue;
    // split around stops: within 2 km of a stop cap at 80 km/h
    let x = s;
    while (x < e) {
      let near = false, nextX = e;
      for (const k of stopKms) {
        const lo = k - 2, hi = k + 2;
        if (x >= lo && x < hi) { near = true; nextX = Math.min(nextX, hi); }
        else if (x < lo) nextX = Math.min(nextX, lo);
      }
      const v = near ? Math.min(sp.v, 80) : sp.v;
      w += (nextX - x) / v; // hours
      x = nextX;
    }
  }
  return w;
}

/**
 * Time profile: piecewise-linear km <-> scheduled time (ms).
 * Uses scheduled arr/dep where known and distributes running time by line speed.
 */
function buildProfile(stops, speeds, totalKm, departure) {
  const stopKms = stops.map((s) => s.km);
  // anchor times: dep at stop i, arr at stop j
  const st = stops.map((s) => ({ ...s }));
  if (st[0].dep == null) st[0].dep = st[0].arr ?? departure ?? Date.now();
  // fill unknown times by line-speed estimate (85% of max speed)
  for (let i = 1; i < st.length; i++) {
    if (st[i].arr == null) {
      // find next stop with a known time to interpolate, else estimate
      let j = i; while (j < st.length && st[j].arr == null && st[j].dep == null) j++;
      const prevDep = st[i - 1].dep ?? st[i - 1].arr;
      if (j < st.length) {
        const tj = st[j].arr ?? st[j].dep;
        const wTot = weight(speeds, st[i - 1].km, st[j].km, stopKms);
        const wi = weight(speeds, st[i - 1].km, st[i].km, stopKms);
        const dwellCount = j - i;
        const run = Math.max(0, tj - prevDep - dwellCount * 60000);
        st[i].arr = prevDep + (wTot > 0 ? (run * wi) / wTot : 0);
      } else {
        st[i].arr = prevDep + (weight(speeds, st[i - 1].km, st[i].km, stopKms) / 0.85) * 3600000;
      }
    }
    if (st[i].dep == null && i < st.length - 1) st[i].dep = st[i].arr + 60000;
  }
  const km = [], t = [];
  for (let i = 0; i < st.length; i++) {
    if (i > 0) {
      // breakpoints along the leg, every speed change
      const a = st[i - 1].km, b = st[i].km, t0 = st[i - 1].dep, t1 = st[i].arr;
      const wTot = weight(speeds, a, b, stopKms) || 1e-9;
      const bps = new Set([a, b]);
      for (const sp of speeds) { if (sp.s > a && sp.s < b) bps.add(sp.s); }
      for (const k of stopKms) { for (const d of [-2, 2]) if (k + d > a && k + d < b) bps.add(k + d); }
      const sorted = [...bps].sort((x, y) => x - y);
      for (const k of sorted) {
        if (k === a) continue;
        km.push(k); t.push(t0 + ((t1 - t0) * weight(speeds, a, k, stopKms)) / wTot);
      }
    } else { km.push(st[0].km); t.push(st[0].dep); }
    if (i > 0 && i < st.length - 1) { km.push(st[i].km); t.push(st[i].dep); }
  }
  stops.forEach((s, i) => { s.arr = st[i].arr; s.dep = st[i].dep ?? null; });
  return { km, t };
}

// --- profile lookups ---
export function timeAtKm(p, k, near = null) {
  const { km, t } = p;
  if (k <= km[0]) return t[0];
  if (k >= km[km.length - 1]) return t[t.length - 1];
  let lo = 0, hi = km.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (km[m] <= k) lo = m; else hi = m; }
  // lo: last index with km <= k. Dwell (same km) spans several indices.
  if (km[lo] === k && near != null) {
    let a = lo; while (a > 0 && km[a - 1] === k) a--;
    return Math.min(Math.max(near, t[a]), t[lo]);
  }
  const f = (k - km[lo]) / (km[hi] - km[lo] || 1);
  return t[lo] + f * (t[hi] - t[lo]);
}

export function kmAtTime(p, time) {
  const { km, t } = p;
  if (time <= t[0]) return km[0];
  if (time >= t[t.length - 1]) return km[km.length - 1];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= time) lo = m; else hi = m; }
  const f = (time - t[lo]) / (t[hi] - t[lo] || 1);
  return km[lo] + f * (km[hi] - km[lo]);
}

export function speedAtKm(trip, k) {
  for (const s of trip.speeds) if (k >= s.s && k <= s.e) return s.v;
  return 110;
}

/**
 * Coverage model in the km domain, then mapped to times.
 * Bad zones: tunnels >= minTunnelM, padded by margins (in seconds, converted with line speed).
 * Returns { segments: [{s,e,kind:'bad'|'short'|'good', names}], good: [...], coveragePct }
 */
export function computeCoverage(trip, settings) {
  const minT = settings.minTunnelM / 1000;
  const bad = [];
  for (const tu of trip.tunnels) {
    if (tu.e - tu.s < minT) continue;
    const vBefore = speedAtKm(trip, tu.s) / 3600, vAfter = speedAtKm(trip, tu.e) / 3600; // km/s
    const s = Math.max(0, tu.s - settings.marginBeforeS * vBefore);
    const e = Math.min(trip.lengthKm, tu.e + settings.marginAfterS * vAfter);
    const last = bad[bad.length - 1];
    if (last && s <= last.e + settings.mergeGapM / 1000) { last.e = Math.max(last.e, e); last.count++; last.tunnelKm += tu.e - tu.s; if (tu.name) last.names.add(tu.name); }
    else bad.push({ s, e, count: 1, tunnelKm: tu.e - tu.s, names: new Set(tu.name ? [tu.name] : []) });
  }
  const segments = [];
  let x = 0;
  const minGoodMs = settings.minGoodMin * 60000;
  const p = trip.profile;
  const pushGap = (s, e) => {
    if (e - s <= 1e-6) return;
    const dur = timeAtKm(p, e) - timeAtKm(p, s);
    segments.push({ s, e, kind: dur >= minGoodMs ? 'good' : 'short' });
  };
  for (const b of bad) {
    pushGap(x, b.s);
    segments.push({ s: b.s, e: b.e, kind: 'bad', count: b.count, tunnelKm: b.tunnelKm, names: [...b.names] });
    x = b.e;
  }
  pushGap(x, trip.lengthKm);
  const total = timeAtKm(p, trip.lengthKm) - timeAtKm(p, 0) || 1;
  let goodMs = 0, okMs = 0;
  for (const sg of segments) {
    const d = timeAtKm(p, sg.e) - timeAtKm(p, sg.s);
    sg.ts = timeAtKm(p, sg.s); sg.te = timeAtKm(p, sg.e);
    if (sg.kind === 'good') goodMs += d;
    if (sg.kind !== 'bad') okMs += d;
  }
  return { segments, goodPct: (100 * goodMs) / total, coveredPct: (100 * okMs) / total };
}

export const DEFAULT_SETTINGS = {
  minGoodMin: 5,      // a "good" window lasts at least this long
  minTunnelM: 200,    // tunnels shorter than this are ignored
  marginBeforeS: 10,  // signal fades before the portal
  marginAfterS: 25,   // time to reconnect after the portal
  mergeGapM: 300,     // tunnels closer than this are one zone
  leadMin: 1,         // alert this long before a no-network zone
  notify: true,
};
