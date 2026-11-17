// Unit tests for the app logic. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RailGraph } from '../app/js/graph.js';
import { buildTrip, computeCoverage, computeGrade, timeAtKm, kmAtTime, DEFAULT_SETTINGS } from '../app/js/trip.js';
import { t, setLang, lang, LANGS } from '../app/js/i18n.js';
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

// Coverage made of alternating windows (minutes): [kind, minutes] pairs
function fakeCoverage(parts) {
  let x = 0;
  const segments = parts.map(([kind, m]) => { const sg = { kind, ts: x, te: x + m * MIN }; x += m * MIN; return sg; });
  const ok = segments.filter((g) => g.kind !== 'bad').reduce((a, g) => a + g.te - g.ts, 0);
  return { segments, coveredPct: (100 * ok) / x };
}

test('grade: frequent short drops rate worse than one long gap', () => {
  // 2 h, 90% covered, a 1-minute drop every 10 minutes
  const choppy = fakeCoverage(Array.from({ length: 12 }, () => [['good', 9], ['bad', 1]]).flat());
  // 2 h, 80% covered, one 24-minute gap in the middle
  const oneGap = fakeCoverage([['good', 48], ['bad', 24], ['good', 48]]);
  const a = computeGrade(choppy), b = computeGrade(oneGap);
  assert.ok(Math.abs(choppy.coveredPct - 90) < 1e-9 && Math.abs(oneGap.coveredPct - 80) < 1e-9);
  assert.ok(b.score > a.score, `one gap ${b.score} vs choppy ${a.score}`);
  assert.ok(b.grade < a.grade, `${b.grade} better than ${a.grade}`);
  assert.equal(a.interruptions, 12);
  assert.equal(b.interruptions, 1);
});

test('grade: full coverage is A, no coverage is F', () => {
  assert.equal(computeGrade(fakeCoverage([['good', 120]])).grade, 'A');
  assert.equal(computeGrade(fakeCoverage([['good', 15]])).grade, 'A', 'short trip without tunnels');
  assert.equal(computeGrade(fakeCoverage([['bad', 60]])).grade, 'F');
  assert.equal(computeGrade({ segments: [], coveredPct: 0 }).grade, 'F');
});

test('translations: every language has every string with the same placeholders', () => {
  const keys = [];
  const enTable = JSON.parse(readFileSync(new URL('../app/js/i18n.js', import.meta.url), 'utf8')
    .match(/const STRINGS = (\{[\s\S]*?\n\});/)[1]);
  for (const k of Object.keys(enTable.en)) keys.push(k);
  assert.ok(keys.length > 100);
  for (const l of Object.keys(LANGS)) {
    for (const k of keys) {
      const v = enTable[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} missing`);
      const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(ph(v), ph(enTable.en[k]), `${l}.${k} placeholders`);
    }
  }
  // the strings used in the code all exist
  const code = ['main.js', 'alerts.js', 'graph.js', 'transitous.js'].map((f) => readFileSync(new URL('../app/js/' + f, import.meta.url), 'utf8')).join('\n');
  for (const [, k] of code.matchAll(/\bt\('([\w.]*\w)'/g)) assert.ok(k in enTable.en, `missing key ${k}`);
  for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(('grade.' + g) in enTable.en);
  for (const g of ['off', 'waiting', 'ok', 'lost', 'denied', 'far', 'unavailable']) assert.ok(('gps.' + g) in enTable.en);
});

test('translations: language choice and placeholders', () => {
  setLang('it');
  assert.equal(t('a.pre.title', { n: 2 }), 'Niente rete tra 2 min');
  setLang('de');
  assert.equal(t('intr.n', { n: 3 }), '3 Unterbrechungen');
  setLang('xx');
  assert.ok(lang() in LANGS, 'unknown choice falls back to a supported language');
  setLang('en');
  assert.equal(t('no.such.key'), 'no.such.key');
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
