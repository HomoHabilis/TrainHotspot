// Rail graph: loading, decoding and multi-stop routing.
// Data format produced by tools/build_rail_data.py.
import { t } from './i18n.js';

export class RailGraph {
  constructor(raw) {
    const n = raw.nodes.length / 2;
    this.nodeCount = n;
    this.nlat = new Float64Array(n);
    this.nlon = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.nlat[i] = raw.nodes[2 * i] / 1e5;
      this.nlon[i] = raw.nodes[2 * i + 1] / 1e5;
    }
    const m = raw.edges.length;
    this.edges = raw.edges;
    this.names = raw.names || [''];
    this.ea = new Int32Array(m);
    this.eb = new Int32Array(m);
    this.elen = new Float64Array(m);
    this.etun = new Uint8Array(m);
    this.espd = new Uint16Array(m);
    this.ehs = new Uint8Array(m);
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      const r = raw.edges[e];
      this.ea[e] = r[0]; this.eb[e] = r[1]; this.elen[e] = Math.max(1, r[2]);
      this.etun[e] = r[3]; this.espd[e] = r[4]; this.ehs[e] = r[5];
      deg[r[0] + 1]++; deg[r[1] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjEdge = new Int32Array(2 * m);
    this.adjTo = new Int32Array(2 * m);
    const fill = deg.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = this.ea[e], b = this.eb[e];
      this.adjEdge[fill[a]] = e; this.adjTo[fill[a]++] = b;
      this.adjEdge[fill[b]] = e; this.adjTo[fill[b]++] = a;
    }
  }

  // Edge geometry from node a to node b as [[lat, lon], ...]
  edgeCoords(e, reverse = false) {
    const r = this.edges[e];
    const a = r[0], b = r[1], inner = r[7];
    const pts = [[this.nlat[a], this.nlon[a]]];
    let la = Math.round(this.nlat[a] * 1e5), lo = Math.round(this.nlon[a] * 1e5);
    for (let i = 0; i < inner.length; i += 2) {
      la += inner[i]; lo += inner[i + 1];
      pts.push([la / 1e5, lo / 1e5]);
    }
    pts.push([this.nlat[b], this.nlon[b]]);
    return reverse ? pts.reverse() : pts;
  }

  edgeCost(e, opts) {
    let c = this.elen[e];
    if (opts.avoidHighSpeed && this.ehs[e]) c *= 4;
    return c;
  }

  // Multi-source Dijkstra. init: Map(node -> cost). Stops when all targets settled
  // or when the frontier exceeds the best target cost by a margin.
  dijkstra(init, targets, opts) {
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1); // edge used to reach node
    const heap = new MinHeap();
    for (const [node, c] of init) {
      if (c < dist[node]) { dist[node] = c; heap.push(c, node); }
    }
    const remaining = new Set(targets);
    let best = Infinity;
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      if (d > best * 1.25 + 30000) break;
      if (remaining.has(u)) {
        remaining.delete(u);
        if (d < best) best = d;
        if (!remaining.size) break;
      }
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const e = this.adjEdge[k], v = this.adjTo[k];
        const nd = d + this.edgeCost(e, opts);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = e; heap.push(nd, v); }
      }
    }
    return { dist, prev };
  }

  // stops: array of { name, cands: [graph node ids] }.
  // Returns { path: [{edge, reverse}], stopNodes: [node|null per stop], skipped: [stop idx] }
  route(stops, opts = {}) {
    const valid = stops.map((s) => s.cands && s.cands.length > 0);
    let first = valid.indexOf(true);
    if (first < 0) throw new Error(t('e.noplace'));
    let init = new Map(stops[first].cands.map((c) => [c, 0]));
    const legs = []; // { from: stopIdx, to: stopIdx, prev, dist }
    const skipped = stops.map((_, i) => (i < first ? i : -1)).filter((i) => i >= 0);
    let lastStop = first;
    for (let i = first + 1; i < stops.length; i++) {
      if (!valid[i]) { skipped.push(i); continue; }
      const { dist, prev } = this.dijkstra(init, stops[i].cands, opts);
      const reached = stops[i].cands.filter((c) => dist[c] < Infinity);
      if (!reached.length) { skipped.push(i); continue; }
      legs.push({ from: lastStop, to: i, prev, init });
      init = new Map(reached.map((c) => [c, dist[c]]));
      lastStop = i;
    }
    if (!legs.length) throw new Error(t('e.noroute'));
    // best end node
    let endNode = -1, endCost = Infinity;
    for (const [node, c] of init) if (c < endCost) { endCost = c; endNode = node; }
    // backtrack leg by leg
    const stopNodes = new Array(stops.length).fill(null);
    const legPaths = [];
    let node = endNode;
    for (let li = legs.length - 1; li >= 0; li--) {
      const leg = legs[li];
      stopNodes[leg.to] = node;
      const edges = [];
      while (!(leg.init.has(node) && leg.prev[node] === -1) && leg.prev[node] !== -1) {
        const e = leg.prev[node];
        const reverse = this.eb[e] !== node; // traversed b->a means we arrived at a
        edges.push({ edge: e, reverse });
        node = reverse ? this.eb[e] : this.ea[e];
        if (leg.init.has(node) && leg.prev[node] === -1) break;
      }
      edges.reverse();
      legPaths.unshift(edges);
      stopNodes[leg.from] = node;
    }
    skipped.sort((a, b) => a - b);
    return { legPaths, stopNodes, skipped };
  }
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, topV];
  }
}

let graphPromise = null;
export function loadGraph(base = './data/') {
  if (!graphPromise) {
    graphPromise = fetch(base + 'graph.json')
      .then((r) => { if (!r.ok) throw new Error(t('e.nodata', { s: r.status })); return r.json(); })
      .then((raw) => new RailGraph(raw))
      .catch((e) => { graphPromise = null; throw e; });
  }
  return graphPromise;
}

let stationsPromise = null;
export function loadStations(base = './data/') {
  if (!stationsPromise) {
    stationsPromise = fetch(base + 'stations.json')
      .then((r) => { if (!r.ok) throw new Error(t('e.nostations')); return r.json(); })
      .then((d) => d.stations)
      .catch((e) => { stationsPromise = null; throw e; });
  }
  return stationsPromise;
}
