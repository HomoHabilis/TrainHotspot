// Unit tests for the app logic. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RailGraph } from '../app/js/graph.js';
import { buildTrip, computeCoverage, timeAtKm, kmAtTime, DEFAULT_SETTINGS } from '../app/js/trip.js';
import { StationIndex, norm } from '../app/js/stations.js';
import { Tracker } from '../app/js/tracker.js';
import { syntheticGraph } from './fixture.mjs';

// alerts.js uses localStorage; give it an in-memory one
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { alertPlan, Alerter } = await import('../app/js/alerts.js');

const T0 = Date.UTC(2026, 10, 17, 8, 0);
const MIN = 60000;

function syntheticTrip(opts = {}) {
  const { graph: raw, stations } = syntheticGraph();
  const g = new RailGraph(raw);
  const idx = new StationIndex(stations);
  const stops = [
    { name: 'Alpha Centrale', dep: T0, arr: null, cands: idx.byName('Alpha Centrale').g },
    ...(opts.via ? [{ name: 'Beta', arr: null, dep: null, cands: idx.byName('Beta').g }] : []),
    { name: 'Gamma', arr: T0 + 40 * MIN, dep: null, cands: idx.byName('Gamma').g },
  ];
  const res = g.route(stops, {});
  const trip = buildTrip(g, res, stops, { departure: T0, stationList: idx.list, id: 'test' });
  return { g, idx, trip };
}

test('graph decodes nodes and edges', () => {
  const { graph } = syntheticGraph();
  const g = new RailGraph(graph);
  assert.equal(g.nodeCount, 11);
  assert.equal(g.edges.length, 10);
  const pts = g.edgeCoords(0, false);
  assert.ok(pts.length >= 2);
  assert.deepEqual(pts[0].map((v) => +v.toFixed(5)), [44, 11]);
});

test('route and trip geometry on the synthetic line', () => {
  const { trip } = syntheticTrip({ via: true });
  assert.ok(Math.abs(trip.lengthKm - 80.1) < 1, `length ${trip.lengthKm}`);
  assert.equal(trip.stops.length, 3);
  assert.equal(trip.stops[0].km, 0);
  assert.ok(Math.abs(trip.stops[1].km - trip.lengthKm / 2) < 0.5);
  assert.equal(trip.tunnels.length, 3);
  assert.ok(trip.tunnels.some((t) => t.name === 'Galleria Test'));
  assert.deepEqual(trip.skipped, []);
});

test('time profile maps km and time both ways', () => {
  const { trip } = syntheticTrip();
  const p = trip.profile;
  assert.equal(timeAtKm(p, 0), T0);
  assert.equal(timeAtKm(p, trip.lengthKm), T0 + 40 * MIN);
  let last = -1;
  for (let k = 0; k <= trip.lengthKm; k += 5) {
    const t = timeAtKm(p, k);
    assert.ok(t >= last, 'time grows with km');
    last = t;
    assert.ok(Math.abs(kmAtTime(p, t) - k) < 0.01, `round trip at km ${k}`);
  }
});

test('coverage splits the trip into bad, short and good zones', () => {
  const { trip } = syntheticTrip();
  const cov = computeCoverage(trip, DEFAULT_SETTINGS);
  const kinds = cov.segments.map((s) => s.kind);
  assert.equal(kinds.filter((k) => k === 'bad').length, 3);
  for (let i = 1; i < cov.segments.length; i++) {
    assert.ok(Math.abs(cov.segments[i].s - cov.segments[i - 1].e) < 1e-9, 'segments are contiguous');
  }
  assert.equal(cov.segments[0].s, 0);
  assert.ok(Math.abs(cov.segments.at(-1).e - trip.lengthKm) < 1e-9);
  assert.ok(cov.goodPct > 50 && cov.goodPct < 100, `goodPct ${cov.goodPct}`);
  assert.ok(cov.coveredPct >= cov.goodPct);
  // a longer minimum window can only reduce the good share
  const strict = computeCoverage(trip, { ...DEFAULT_SETTINGS, minGoodMin: 15 });
  assert.ok(strict.goodPct <= cov.goodPct);
  // ignoring tunnels shorter than 5 km leaves everything covered
  const lax = computeCoverage(trip, { ...DEFAULT_SETTINGS, minTunnelM: 5000 });
  assert.equal(lax.segments.filter((s) => s.kind === 'bad').length, 0);
  assert.ok(Math.abs(lax.goodPct - 100) < 1e-6);
});

test('alert plan warns before each zone and fires once', () => {
  const { trip } = syntheticTrip();
  const cov = computeCoverage(trip, DEFAULT_SETTINGS);
  const plan = alertPlan(trip, cov, DEFAULT_SETTINGS);
  assert.equal(plan.filter((e) => e.kind === 'pre').length, 3);
  assert.ok(plan.some((e) => e.kind === 'exit'));
  const al = new Alerter('t-' + Math.random());
  al.notify = () => {};
  const first = plan[0];
  const at = timeAtKm(trip.profile, first.km);
  const settings = { ...DEFAULT_SETTINGS, notify: false };
  const est = (now) => ({ km: kmAtTime(trip.profile, now), delayMs: 0 });
  assert.equal(al.check(trip, plan, est(T0), T0, settings).length, 0, 'nothing at departure');
  const now = at - 30000;
  const fired = al.check(trip, plan, est(now), now, settings);
  assert.ok(fired.some((e) => e.id === first.id), 'pre alert fires within the lead time');
  assert.equal(al.check(trip, plan, est(now), now, settings).length, 0, 'no repeat');
});

test('tracker snaps GPS fixes and dead-reckons between them', () => {
  const { trip } = syntheticTrip();
  const tr = new Tracker(trip);
  const fix = (lon, t) => tr.onFix({ coords: { latitude: 44.0, longitude: lon, accuracy: 20 }, timestamp: t });
  fix(11.2, T0 + 10 * MIN);
  fix(11.25, T0 + 10 * MIN + 30000);
  assert.equal(tr.gpsState, 'ok');
  const e = tr.estimate(T0 + 10 * MIN + 30000);
  assert.equal(e.source, 'gps');
  assert.ok(Math.abs(e.km - 0.25 * trip.lengthKm) < 0.5, `km ${e.km}`);
  assert.ok(tr.speedKmh() > 300 && tr.speedKmh() < 600);
  const later = tr.estimate(T0 + 10 * MIN + 60000);
  assert.equal(later.source, 'dead-reckoning');
  assert.ok(later.km > e.km);
  // a fix far from the track is not snapped
  tr.onFix({ coords: { latitude: 45.0, longitude: 11.3, accuracy: 20 }, timestamp: T0 + 11 * MIN });
  assert.equal(tr.gpsState, 'far');
});

test('station index search and matching', () => {
  const { stations } = syntheticGraph();
  const idx = new StationIndex(stations);
  assert.equal(norm('FIRENZE S. M. NOVELLA'), norm('Firenze Santa Maria Novella'));
  assert.equal(idx.search('alp')[0].n, 'Alpha Centrale');
  assert.equal(idx.byName('gamma').n, 'Gamma');
  assert.equal(idx.match('ALPHA C.LE')?.n, 'Alpha Centrale');
  assert.equal(idx.nearest(44.0, 11.501).n, 'Beta');
  assert.equal(idx.nearest(44.5, 11.5), null);
});

// Smoke test on the real OpenStreetMap data shipped with the app
const realGraph = new RailGraph(JSON.parse(readFileSync(new URL('../app/data/graph.json', import.meta.url))));
const realIdx = new StationIndex(JSON.parse(readFileSync(new URL('../app/data/stations.json', import.meta.url))).stations);

function realTrip(names, opts = {}) {
  const st = names.map((n) => realIdx.byName(n));
  st.forEach((s, i) => assert.ok(s, `station ${names[i]} exists in the data`));
  const stops = st.map((s, i) => ({ name: s.n, cands: s.g, dep: i === 0 ? T0 : null, arr: i === st.length - 1 ? T0 + 60 * MIN : null }));
  const res = realGraph.route(stops, opts);
  return buildTrip(realGraph, res, stops, { departure: T0, stationList: realIdx.list });
}

test('real data: Firenze to Bologna takes the high-speed tunnels', () => {
  const trip = realTrip(['Firenze Santa Maria Novella', 'Bologna Centrale']);
  assert.ok(trip.lengthKm > 80 && trip.lengthKm < 110, `length ${trip.lengthKm}`);
  const tunnelKm = trip.tunnels.reduce((a, t) => a + t.e - t.s, 0);
  assert.ok(tunnelKm > 40, `tunnel km ${tunnelKm}`);
  const cov = computeCoverage(trip, DEFAULT_SETTINGS);
  assert.ok(cov.goodPct < 50, `goodPct ${cov.goodPct}`);
});

test('real data: Milano to Roma routes in one piece', () => {
  const trip = realTrip(['Milano Centrale', 'Roma Termini']);
  assert.ok(trip.lengthKm > 520 && trip.lengthKm < 640, `length ${trip.lengthKm}`);
  assert.deepEqual(trip.skipped, []);
});
