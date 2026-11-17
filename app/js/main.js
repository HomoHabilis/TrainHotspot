import { loadGraph, loadStations } from './graph.js';
import { buildTrip, computeCoverage, timeAtKm } from './trip.js';
import { StationIndex } from './stations.js';
import { searchTrain, trainDetails, currentDelay, isHighSpeedCategory } from './vt.js';
import { Tracker } from './tracker.js';
import { Alerter, alertPlan, requestNotifications, ScreenLock, KeepAlive, scheduleTriggers, predictedTime } from './alerts.js';
import { saveTrip, deleteTrip, getTrip, listTrips, loadSettings, saveSettings, persistStorage } from './store.js';

const $view = document.getElementById('view');
const UI_REFRESH_MS = 60000;   // outline, percentages and times
const ALERT_CHECK_MS = 10000;  // alert checks (browsers throttle this in the background)

let settings = loadSettings();
let stationIndex = null;
let live = null; // running trip session

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const fmtDur = (ms) => { const m = mins(ms); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function todayStr(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function localMidnight(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }

async function stations() {
  if (!stationIndex) stationIndex = new StationIndex(await loadStations());
  return stationIndex;
}

function updateNetState() {
  const el = document.getElementById('netstate');
  el.textContent = navigator.onLine ? 'online' : 'offline';
  el.className = 'netstate ' + (navigator.onLine ? 'on' : 'off');
}
addEventListener('online', updateNetState);
addEventListener('offline', updateNetState);

// ---------- router ----------
async function route() {
  const h = location.hash || '#/';
  if (live && !h.startsWith('#/trip/' + live.trip.id)) stopLive();
  window.scrollTo(0, 0);
  try {
    if (h.startsWith('#/trip/')) return await renderTrip(decodeURIComponent(h.slice(7)));
    if (h === '#/new') return renderNew();
    if (h === '#/settings') return renderSettings();
    return await renderHome();
  } catch (e) {
    console.error(e);
    $view.innerHTML = `<section class="card error"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Back</a></section>`;
  }
}
addEventListener('hashchange', route);

// ---------- home ----------
async function renderHome() {
  const trips = await listTrips().catch(() => []);
  const now = Date.now();
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <section class="hero">
      <h1>Where will your train have network?</h1>
      <p>Load your trip while online. TrainHotspot then works offline: it shows the stretches without long tunnels, the times you'll have coverage, and alerts you before you lose signal.</p>
      <a class="btn primary big" href="#/new">Plan a trip</a>
    </section>
    ${isIOS && !standalone ? `<section class="card hint"><strong>iPhone tip:</strong> tap Share, then <em>Add to Home Screen</em>. Notifications only work from the installed app.</section>` : ''}
    <section>
      <h2 class="section-title">Your trips</h2>
      ${trips.length ? `<ul class="triplist">${trips.map((t) => {
        const cov = computeCoverage(t, settings);
        const past = t.profile.t[t.profile.t.length - 1] < now;
        return `<li class="${past ? 'past' : ''}">
          <a href="#/trip/${encodeURIComponent(t.id)}">
            <span class="tl-title">${esc(t.title)}</span>
            <span class="tl-sub">${dayLabel(t.profile.t[0])} · ${hhmm(t.profile.t[0])} → ${hhmm(t.profile.t[t.profile.t.length - 1])} · ${Math.round(t.lengthKm)} km</span>
            ${miniBar(t, cov)}
            <span class="tl-cov">${Math.round(cov.coveredPct)}% with network</span>
          </a>
          <button class="iconbtn del" data-del="${esc(t.id)}" aria-label="Delete trip">✕</button>
        </li>`;
      }).join('')}</ul>` : '<p class="muted">No trips yet. Plan one while you are online; it stays available offline.</p>'}
    </section>`;
  $view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this trip?')) return;
    await deleteTrip(b.dataset.del); renderHome();
  }));
}

function miniBar(trip, cov) {
  const L = trip.lengthKm || 1;
  return `<svg class="minibar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">${cov.segments.map((s) =>
    `<rect x="${(100 * s.s) / L}" y="0" width="${Math.max(0.15, (100 * (s.e - s.s)) / L)}" height="4" class="seg-${s.kind}"/>`).join('')}</svg>`;
}

// ---------- new trip ----------
function renderNew() {
  $view.innerHTML = `
    <h1 class="page-title">Plan a trip</h1>
    <div class="tabs" role="tablist">
      <button role="tab" class="tab active" data-tab="train" aria-selected="true">Train number</button>
      <button role="tab" class="tab" data-tab="stations" aria-selected="false">Stations</button>
    </div>
    <section class="card tabpanel" id="tab-train">
      <form id="f-train" class="form">
        <label>Train number <input name="num" inputmode="numeric" pattern="[0-9]+" required placeholder="e.g. 9531" autocomplete="off"></label>
        <label>Date <input name="date" type="date" required value="${todayStr()}"></label>
        <button class="btn primary" type="submit">Find train</button>
        <p class="muted small">Looks up the stops and times on ViaggiaTreno (Trenitalia's live service, covers trains on the RFI network). Needs network now, not during the trip.</p>
      </form>
      <div id="train-results"></div>
    </section>
    <section class="card tabpanel" id="tab-stations" hidden>
      <form id="f-st" class="form">
        <label>From <input name="from" list="stlist" required autocomplete="off" placeholder="Departure station"></label>
        <div id="vias"></div>
        <button type="button" class="btn link" id="add-via">+ Add a stop in between</button>
        <label>To <input name="to" list="stlist" required autocomplete="off" placeholder="Arrival station"></label>
        <div class="row">
          <label>Date <input name="date" type="date" required value="${todayStr()}"></label>
          <label>Departs <input name="dep" type="time" required></label>
          <label>Arrives <input name="arr" type="time" placeholder="optional"></label>
        </div>
        <label class="check"><input type="checkbox" name="regional"> Regional train (avoid high-speed lines)</label>
        <button class="btn primary" type="submit">Build trip</button>
        <p class="muted small">Arrival time is optional: without it the app estimates running times from line speeds. Adding the stops your train makes keeps the route on the right line.</p>
      </form>
      <datalist id="stlist"></datalist>
    </section>
    <div id="build-status"></div>`;

  const tabs = $view.querySelectorAll('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
    $view.querySelector('#tab-train').hidden = t.dataset.tab !== 'train';
    $view.querySelector('#tab-stations').hidden = t.dataset.tab !== 'stations';
    if (t.dataset.tab === 'stations') fillStationList();
  }));

  $view.querySelector('#add-via').addEventListener('click', () => {
    const vias = $view.querySelector('#vias');
    if (vias.children.length >= 6) return;
    const l = document.createElement('label');
    l.innerHTML = `Via <input name="via" list="stlist" autocomplete="off" placeholder="Intermediate station">`;
    vias.appendChild(l);
  });

  $view.querySelector('#f-train').addEventListener('submit', onTrainSearch);
  $view.querySelector('#f-st').addEventListener('submit', onStationsBuild);
}

async function fillStationList() {
  const dl = $view.querySelector('#stlist');
  if (!dl || dl.children.length) return;
  try {
    const idx = await stations();
    const names = [...new Set(idx.list.map((s) => s.n))];
    dl.innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  } catch (e) { toast(e.message); }
}

async function onTrainSearch(ev) {
  ev.preventDefault();
  const f = ev.target, out = $view.querySelector('#train-results');
  const num = f.num.value.trim(), date = f.date.value;
  out.innerHTML = '<p class="muted">Searching…</p>';
  try {
    const res = await searchTrain(num);
    if (!res.length) { out.innerHTML = '<p>No train found with that number.</p>'; return; }
    out.innerHTML = `<p class="small muted">Pick your train:</p><ul class="choices">${res.map((r, i) =>
      `<li><button class="btn choice" data-i="${i}">${esc(r.label)}</button></li>`).join('')}</ul>`;
    out.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => onTrainPick(res[b.dataset.i], date)));
    if (res.length === 1) onTrainPick(res[0], date);
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    if (e.blocked) {
      out.innerHTML += '<button class="btn" id="go-st">Use stations instead</button>';
      out.querySelector('#go-st').addEventListener('click', () => $view.querySelector('[data-tab=stations]').click());
    }
  }
}

async function onTrainPick(r, dateStr) {
  const status = $view.querySelector('#build-status');
  status.innerHTML = '<section class="card"><p>Loading train details…</p></section>';
  try {
    const d = await trainDetails(r.origCode, r.num, r.millis);
    // Shift times to the chosen date (same timetable assumed)
    const shift = localMidnight(dateStr) - new Date(new Date(r.millis).toDateString()).getTime();
    const stops = d.stops.map((s) => ({ ...s, arr: s.arr ? s.arr + shift : null, dep: s.dep ? s.dep + shift : null }));
    await buildAndOpen({
      stops, title: `${d.title} ${stops[0].name} → ${stops[stops.length - 1].name}`,
      avoidHighSpeed: !isHighSpeedCategory(d.category) && /^(REG|RV|R|S|IC)/i.test(d.category),
      source: 'viaggiatreno',
      train: { num: r.num, origCode: r.origCode, millis: r.millis + shift, category: d.category, delayMin: shift === 0 ? d.delayMin : 0 },
    });
  } catch (e) {
    status.innerHTML = `<section class="card error"><p>${esc(e.message)}</p></section>`;
  }
}

async function onStationsBuild(ev) {
  ev.preventDefault();
  const f = ev.target;
  const idx = await stations();
  const names = [f.from.value, ...[...f.querySelectorAll('[name=via]')].map((i) => i.value).filter(Boolean), f.to.value];
  const resolved = names.map((n) => idx.byName(n) || idx.match(n));
  const missing = names.filter((_, i) => !resolved[i]);
  if (missing.length) { toast('Unknown station: ' + missing.join(', ')); return; }
  const day = localMidnight(f.date.value);
  const t = (v) => { if (!v) return null; const [h, m] = v.split(':').map(Number); return day + (h * 60 + m) * 60000; };
  const dep = t(f.dep.value);
  let arr = t(f.arr.value);
  if (arr && arr < dep) arr += 86400000;
  const stops = resolved.map((s, i) => ({ name: s.n, station: s, arr: i === resolved.length - 1 ? arr : null, dep: i === 0 ? dep : null }));
  await buildAndOpen({ stops, title: `${resolved[0].n} → ${resolved[resolved.length - 1].n}`, avoidHighSpeed: f.regional.checked, source: 'manual' });
}

async function buildAndOpen({ stops, title, avoidHighSpeed, source, train }) {
  const status = $view.querySelector('#build-status');
  const say = (m) => { status.innerHTML = `<section class="card"><p>${m}</p></section>`; };
  try {
    say('Loading the rail network (first time only, a few MB)…');
    const [graph, idx] = await Promise.all([loadGraph(), stations()]);
    say('Finding your route and tunnels…');
    await new Promise((r) => setTimeout(r, 30));
    let prevSt = null;
    const routeStops = stops.map((s) => {
      const st = s.station || idx.match(s.name, s.code, prevSt);
      if (st) prevSt = st;
      return { ...s, name: st ? st.n : s.name, cands: st ? st.g : [] };
    });
    const res = graph.route(routeStops, { avoidHighSpeed });
    const trip = buildTrip(graph, res, routeStops.map((s) => ({ name: s.name, arr: s.arr, dep: s.dep, code: s.code })),
      { title, source, train, departure: stops[0].dep, stationList: idx.list });
    trip.delayMin = train?.delayMin || 0;
    await saveTrip(trip);
    persistStorage();
    location.hash = '#/trip/' + encodeURIComponent(trip.id);
  } catch (e) {
    console.error(e);
    status.innerHTML = `<section class="card error"><p>${esc(e.message)}</p></section>`;
  }
}

// ---------- trip view ----------
async function renderTrip(id) {
  const trip = await getTrip(id);
  if (!trip) { $view.innerHTML = '<section class="card"><p>Trip not found.</p><a class="btn" href="#/">Back</a></section>'; return; }
  if (!live || live.trip.id !== id) startLive(trip);
  $view.innerHTML = `
    <section class="trip-head">
      <h1 class="page-title">${esc(trip.title)}</h1>
      <p class="muted">${dayLabel(trip.profile.t[0])} · ${hhmm(trip.profile.t[0])} → ${hhmm(trip.profile.t[trip.profile.t.length - 1])} · ${Math.round(trip.lengthKm)} km · ${trip.stops.length} stops</p>
      ${trip.skipped?.length ? `<p class="warn small">Not placed on the map: ${esc(trip.skipped.join(', '))}. The route skips them.</p>` : ''}
    </section>
    <section id="now" class="card now" aria-live="polite"></section>
    <section class="card">
      <div class="cov-head">
        <h2>Trip outline</h2>
        <div id="pct" class="pct"></div>
      </div>
      <div id="outline" class="outline"></div>
      <div class="legend"><span><i class="sw seg-good"></i>Good network ≥ ${settings.minGoodMin} min</span><span><i class="sw seg-short"></i>Short gaps</span><span><i class="sw seg-bad"></i>Probably no network (tunnels)</span></div>
    </section>
    <section class="card">
      <h2>When you'll have coverage</h2>
      <ol id="windows" class="windows"></ol>
    </section>
    <section class="card controls">
      <h2>Tracking and alerts</h2>
      <div class="btnrow">
        <button class="btn primary" id="b-track"></button>
        <button class="btn" id="b-notif">Enable notifications</button>
        <button class="btn" id="b-wake">Keep screen on</button>
      </div>
      <label class="check"><input type="checkbox" id="c-keep"> Keep running in the background (experimental, Android; uses battery)</label>
      <div class="delay">
        <span>Delay: <strong id="delay-v"></strong></span>
        <button class="btn sm" data-d="-1">−1</button><button class="btn sm" data-d="1">+1</button><button class="btn sm" data-d="5">+5</button>
        ${trip.train ? '<button class="btn sm" id="b-vt">Update online</button>' : ''}
      </div>
      <p id="track-info" class="small muted"></p>
      <details class="small"><summary>What works when the phone is locked?</summary>
        <p>Web apps can't run freely in the background. <strong>Most reliable:</strong> keep this screen open with "Keep screen on" (phone on the tray table, plugged in if you can).</p>
        <p><strong>Android (Chrome):</strong> notifications still appear while the page is in the background, as long as Chrome keeps it alive; GPS pauses, so position is estimated from the timetable and the last speed. The experimental option above helps Chrome keep the page alive.</p>
        <p><strong>iPhone:</strong> install the app on the Home Screen. Alerts work while it is open; when locked, iOS pauses it and alerts resume when you come back.</p>
      </details>
    </section>
    <section class="card">
      <details><summary><h2 class="inline">Stops</h2></summary><ol id="stops" class="stops"></ol></details>
      <details><summary><h2 class="inline">Tunnels (${trip.tunnels.length})</h2></summary><ol id="tunnels" class="stops"></ol></details>
      <details><summary><h2 class="inline">Demo</h2></summary>
        <p class="small muted">Replay this trip quickly to see the outline, the countdown and the alerts in action.</p>
        <div class="btnrow"><button class="btn" id="b-sim">Replay at 60× speed</button></div>
      </details>
    </section>
    <p class="small muted attribution">Track and tunnel data © OpenStreetMap contributors (ODbL). Coverage is estimated from tunnels only: valleys and rural gaps are not yet included.</p>`;

  const L = live;
  $view.querySelector('#b-track').addEventListener('click', () => { L.tracking ? L.stopTracking() : L.startTracking(); paintControls(); });
  $view.querySelector('#b-notif').addEventListener('click', async () => {
    const p = await requestNotifications();
    toast(p === 'granted' ? 'Notifications on' : p === 'unsupported' ? 'Notifications are not supported here. On iPhone, install the app first.' : 'Notifications blocked in browser settings');
    if (p === 'granted') scheduleTriggers(trip, L.plan, L.tracker.delayMs);
    paintControls();
  });
  $view.querySelector('#b-wake').addEventListener('click', async () => {
    if (L.wake.wanted) await L.wake.off(); else if (!(await L.wake.on())) toast('Keep-screen-on is not supported in this browser');
    paintControls();
  });
  $view.querySelector('#c-keep').addEventListener('change', (e) => { if (e.target.checked) L.keep.start(); else L.keep.stop(); });
  $view.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    L.tracker.delayMs += Number(b.dataset.d) * 60000; L.refresh(true);
  }));
  $view.querySelector('#b-vt')?.addEventListener('click', async () => {
    try {
      const d = await currentDelay(trip.train.origCode, trip.train.num, trip.train.millis);
      if (d == null) throw new Error('No delay data yet');
      L.tracker.setDelayMin(d); L.refresh(true); toast(`Delay updated: ${d} min`);
    } catch (e) { toast(e.message); }
  });
  $view.querySelector('#b-sim').addEventListener('click', () => { L.toggleSim(); paintControls(); });

  $view.querySelector('#stops').innerHTML = trip.stops.map((s, i) => `<li><span class="t">${s.arr && i ? hhmm(s.arr) : ''}${s.dep && i < trip.stops.length - 1 ? (i ? ' – ' : '') + hhmm(s.dep) : ''}</span> ${esc(s.name)} <span class="muted">km ${Math.round(s.km)}</span></li>`).join('');
  $view.querySelector('#tunnels').innerHTML = trip.tunnels.map((t) => `<li><span class="t">${hhmm(timeAtKm(trip.profile, t.s))}</span> ${esc(t.name || 'Tunnel')} <span class="muted">${((t.e - t.s) * 1000) >= 1000 ? (t.e - t.s).toFixed(1) + ' km' : Math.round((t.e - t.s) * 1000) + ' m'} · km ${t.s.toFixed(1)}</span></li>`).join('') || '<li class="muted">No tunnels on this route.</li>';
  paintControls();
  L.refresh(true);
}

function paintControls() {
  if (!live) return;
  const q = (s) => $view.querySelector(s);
  if (!q('#b-track')) return;
  q('#b-track').textContent = live.tracking ? 'Stop tracking' : 'Start trip tracking';
  q('#b-track').classList.toggle('active', live.tracking);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  q('#b-notif').textContent = perm === 'granted' ? 'Notifications on' : perm === 'denied' ? 'Notifications blocked' : 'Enable notifications';
  q('#b-notif').disabled = perm === 'granted' || perm === 'denied';
  q('#b-wake').textContent = live.wake.wanted ? 'Screen stays on' : 'Keep screen on';
  q('#b-wake').classList.toggle('active', live.wake.wanted);
  q('#c-keep').checked = live.keep.active;
  q('#b-sim').textContent = live.sim ? 'Stop replay' : 'Replay at 60× speed';
}

// ---------- live session ----------
function startLive(trip) {
  stopLive();
  const s = {
    trip, tracking: false, sim: null, lastUi: 0,
    tracker: new Tracker(trip, () => s.refresh(false)),
    alerter: new Alerter(trip.id),
    wake: new ScreenLock(), keep: new KeepAlive(),
    coverage: computeCoverage(trip, settings),
    timers: [],
  };
  s.plan = alertPlan(trip, s.coverage, settings);
  s.tracker.delayMs = (trip.delayMin || 0) * 60000;
  s.now = () => (s.sim ? s.sim.t0 + (Date.now() - s.sim.real0) * s.sim.factor : Date.now());
  s.startTracking = () => { s.tracking = true; s.tracker.start(); s.alerter.check(trip, s.plan, s.estimate(), s.now(), settings, onAlerts); s.refresh(true); };
  s.stopTracking = () => { s.tracking = false; s.tracker.stop(); s.refresh(true); };
  s.estimate = () => {
    if (s.sim) {
      const km = Math.min(trip.lengthKm, Math.max(0, kmAt(trip, s.now())));
      return { km, source: 'replay', speed: null, delayMs: 0 };
    }
    return s.tracker.estimate(s.now());
  };
  s.toggleSim = () => {
    if (s.sim) { s.sim = null; s.alerter.reset(); s.refresh(true); return; }
    s.alerter.reset();
    s.sim = { t0: trip.profile.t[0] - 60000, real0: Date.now(), factor: 60 };
    s.tracking = true;
    s.refresh(true);
  };
  // Refresh: alerts every check, UI about once a minute (or forced)
  s.refresh = (force) => {
    const now = s.now();
    const est = s.estimate();
    if (s.tracking) s.alerter.check(trip, s.plan, est, now, settings, onAlerts);
    const uiEvery = s.sim ? 1000 : UI_REFRESH_MS;
    if (force || Date.now() - s.lastUi >= uiEvery) { s.lastUi = Date.now(); paintLive(s, est, now); }
  };
  s.timers.push(setInterval(() => s.refresh(false), ALERT_CHECK_MS));
  s.timers.push(setInterval(() => { if (s.sim) s.refresh(false); }, 1000));
  s.onVis = () => { if (document.visibilityState === 'visible') s.refresh(true); };
  document.addEventListener('visibilitychange', s.onVis);
  live = s;
}

function kmAt(trip, t) {
  // replay: schedule position
  const p = trip.profile;
  if (t <= p.t[0]) return 0;
  for (let i = 1; i < p.t.length; i++) if (p.t[i] >= t) {
    const f = (t - p.t[i - 1]) / ((p.t[i] - p.t[i - 1]) || 1);
    return p.km[i - 1] + f * (p.km[i] - p.km[i - 1]);
  }
  return trip.lengthKm;
}

function stopLive() {
  if (!live) return;
  live.timers.forEach(clearInterval);
  live.tracker.stop(); live.wake.off(); live.keep.stop();
  document.removeEventListener('visibilitychange', live.onVis);
  live = null;
}

function onAlerts(events) {
  const e = events[events.length - 1];
  const now = $view.querySelector('#now');
  if (now) { now.classList.remove('flash'); void now.offsetWidth; now.classList.add('flash'); }
  toast(`${e.title}. ${e.body}`, 8000);
}

function paintLive(s, est, now) {
  const { trip, coverage } = s;
  const el = (id) => $view.querySelector(id);
  if (!el('#now')) return;
  const delay = est.delayMs || 0;
  const pt = (km) => predictedTime(trip, km, delay);
  const started = now >= pt(0) - 60000 || s.tracking;
  const segs = coverage.segments;
  const cur = segs.find((g) => est.km >= g.s && est.km < g.e) || segs[segs.length - 1];
  const ended = est.km >= trip.lengthKm - 0.05 && now > pt(trip.lengthKm);

  // Now card
  let html;
  if (!started && !s.sim) {
    const firstGood = segs.find((g) => g.kind === 'good');
    html = `<div class="now-main"><span class="dot dot-idle"></span><div><strong>Departs ${hhmm(pt(0))}</strong><span>${firstGood ? `First good window at ${hhmm(pt(firstGood.s))}` : 'No long coverage window on this trip'}</span></div></div>`;
  } else if (ended) {
    html = `<div class="now-main"><span class="dot dot-idle"></span><div><strong>Trip finished</strong><span>Arrived around ${hhmm(pt(trip.lengthKm))}</span></div></div>`;
  } else {
    const nextBad = segs.find((g) => g.kind === 'bad' && g.e > est.km && g !== cur);
    if (cur.kind === 'bad') {
      const after = segs[segs.indexOf(cur) + 1];
      html = `<div class="now-main"><span class="dot dot-bad"></span><div><strong>No network zone</strong><span>Signal back around ${hhmm(pt(cur.e))} (in ${fmtDur(pt(cur.e) - now)})${after?.kind === 'good' ? `, then good for ${fmtDur(after.te - after.ts)}` : ''}</span></div></div>`;
    } else {
      const until = nextBad ? pt(nextBad.s) : pt(trip.lengthKm);
      const kind = cur.kind === 'good' ? 'Good network now' : 'Network now, but short';
      html = `<div class="now-main"><span class="dot dot-${cur.kind}"></span><div><strong>${kind}</strong><span>${nextBad ? `For about ${fmtDur(until - now)}, until ${hhmm(until)}` : `Until arrival at ${hhmm(until)}`}</span></div></div>`;
    }
  }
  const src = { gps: 'GPS', 'dead-reckoning': 'estimated (no GPS fix)', schedule: 'timetable', replay: 'replay' }[est.source] || est.source;
  html += `<p class="small muted">Position: ${src}${est.speed ? ` · ${Math.round(est.speed)} km/h` : ''} · km ${est.km.toFixed(0)} of ${Math.round(trip.lengthKm)} · updated ${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: s.sim ? undefined : '2-digit' })}</p>`;
  el('#now').innerHTML = html;

  // Percentages (whole trip + remaining)
  const remaining = segs.filter((g) => g.e > est.km);
  let remAll = 0, remOk = 0;
  for (const g of remaining) {
    const d = pt(g.e) - pt(Math.max(g.s, est.km));
    remAll += d; if (g.kind !== 'bad') remOk += d;
  }
  const remPct = remAll > 0 ? Math.round((100 * remOk) / remAll) : 0;
  el('#pct').innerHTML = `<strong>${Math.round(coverage.coveredPct)}%</strong> of the trip with network<br><span class="small muted">${Math.round(coverage.goodPct)}% in windows ≥ ${settings.minGoodMin} min${started && !ended ? ` · ${remPct}% of what's left` : ''}</span>`;

  // Outline
  el('#outline').innerHTML = outlineSvg(trip, coverage, est.km, pt, started && !ended);

  // Windows list
  const goods = segs.filter((g) => g.kind === 'good');
  el('#windows').innerHTML = goods.length ? goods.map((g) => {
    const a = pt(g.s), b = pt(g.e);
    const past = est.km >= g.e && started;
    const nowIn = est.km >= g.s && est.km < g.e && started;
    return `<li class="${past ? 'past' : ''} ${nowIn ? 'current' : ''}">
      <span class="w-time">${hhmm(a)} – ${hhmm(b)}</span>
      <span class="w-dur">${fmtDur(b - a)}</span>
      <span class="w-where">${esc(nearStop(trip, g.s))} → ${esc(nearStop(trip, g.e))}${nowIn ? ' · <strong>now</strong>' : ''}</span>
    </li>`;
  }).join('') : `<li class="muted">No stretch of ${settings.minGoodMin} min or more without long tunnels. Try a shorter minimum in Settings.</li>`;

  // Controls info
  const tr = s.tracker;
  const gps = { off: 'GPS off', waiting: 'Waiting for GPS…', ok: 'GPS OK', lost: 'GPS signal lost, estimating', denied: 'Location permission denied: using timetable only', far: 'You seem to be away from this route', unavailable: 'No GPS on this device' }[tr.gpsState];
  if (el('#track-info')) el('#track-info').textContent = s.sim ? 'Replaying the trip at 60× speed. Alerts fire as they would on the train.' : s.tracking ? `${gps}. Alerts ${settings.leadMin} min before no-network zones and when network comes back.` : 'Start tracking on board to get live position and alerts.';
  if (el('#delay-v')) el('#delay-v').textContent = `${Math.round(delay / 60000)} min`;
}

function nearStop(trip, km) {
  let best = trip.stops[0];
  for (const s of trip.stops) if (Math.abs(s.km - km) < Math.abs(best.km - km)) best = s;
  if (Math.abs(best.km - km) < 3) return best.name;
  // otherwise the nearest station passed (major stations preferred)
  let lm = null, ld = Infinity;
  for (const l of trip.landmarks || []) {
    const d = Math.abs(l.km - km) * (l.major ? 0.5 : 1);
    if (d < ld) { ld = d; lm = l; }
  }
  const sd = Math.abs(best.km - km);
  if (lm && ld < sd && ld < 15) return lm.on && Math.abs(lm.km - km) < 2 ? lm.name : `near ${lm.name}`;
  return sd < 15 ? `near ${best.name}` : `km ${Math.round(km)}`;
}

// Linear trip outline: time axis, colored segments, stops, current position
function outlineSvg(trip, cov, km, pt, showPos) {
  const W = 600, H = 116, X0 = 8, X1 = W - 8, Y = 30, BH = 30;
  const t0 = pt(0), t1 = pt(trip.lengthKm), span = (t1 - t0) || 1;
  const x = (k) => X0 + ((pt(k) - t0) / span) * (X1 - X0);
  const rects = cov.segments.map((s) => `<rect class="seg-${s.kind}" x="${x(s.s).toFixed(1)}" y="${Y}" width="${Math.max(1.2, x(s.e) - x(s.s)).toFixed(1)}" height="${BH}"><title>${s.kind === 'bad' ? 'No network' : s.kind === 'good' ? 'Good network' : 'Short gap'}: ${hhmm(pt(s.s))}–${hhmm(pt(s.e))}</title></rect>`).join('');
  // ticks for stops; labels for stops then major stations passed, wherever they fit
  const n = trip.stops.length;
  const ticks = trip.stops.map((s) => { const sx = x(s.km); return `<line x1="${sx.toFixed(1)}" x2="${sx.toFixed(1)}" y1="${Y - 4}" y2="${Y + BH + 6}" class="st-tick"/>`; }).join('');
  const stopNames = new Set(trip.stops.map((s) => s.name));
  const cands = [
    ...trip.stops.map((s, i) => ({ name: s.name, km: s.km, pri: i === 0 || i === n - 1 ? 0 : 1, cls: '' })),
    ...(trip.landmarks || []).filter((l) => l.major && !stopNames.has(l.name)).map((l) => ({ name: l.name, km: l.km, pri: 2 - (l.rank || 0) / 1000, cls: ' lm' })),
  ].sort((a, b) => a.pri - b.pri);
  const used = [];
  const labels = [];
  for (const c of cands) {
    const label = short(c.name), wdt = label.length * 12.5 + 10;
    const cx = x(c.km);
    let x0 = cx - wdt / 2, anchor = 'middle';
    if (c.km <= 0.01) { x0 = cx; anchor = 'start'; } else if (c.km >= trip.lengthKm - 0.01) { x0 = cx - wdt; anchor = 'end'; }
    if (x0 < X0 - 2 || x0 + wdt > X1 + 2) continue;
    if (used.some(([a0, b0]) => x0 < b0 && x0 + wdt > a0)) continue;
    used.push([x0, x0 + wdt]);
    labels.push(`${c.cls ? `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${Y + BH}" y2="${Y + BH + 8}" class="lm-tick"/>` : ''}<text x="${cx.toFixed(1)}" y="${Y + BH + 26}" text-anchor="${anchor}" class="st-name${c.cls}">${esc(label)}</text><text x="${cx.toFixed(1)}" y="${Y + BH + 48}" text-anchor="${anchor}" class="st-time">${hhmm(pt(c.km))}</text>`);
  }
  const stops = ticks + labels.join('');
  const px = x(Math.min(km, trip.lengthKm));
  const pos = showPos ? `<g class="pos"><line x1="${px}" x2="${px}" y1="${Y - 14}" y2="${Y + BH + 2}"/><path d="M${px - 11},${Y - 28} L${px + 11},${Y - 28} L${px},${Y - 12} Z"/></g>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trip outline with network coverage">${rects}${stops}${pos}</svg>`;
}
const short = (n) => (n.length > 16 ? n.slice(0, 15) + '…' : n);

// ---------- settings ----------
function renderSettings() {
  const f = (k, label, unit, min, max, step = 1, help = '') => `
    <label class="setting"><span>${label}<small>${help}</small></span>
      <span class="inp"><input type="number" name="${k}" value="${settings[k]}" min="${min}" max="${max}" step="${step}"> ${unit}</span></label>`;
  $view.innerHTML = `
    <h1 class="page-title">Settings</h1>
    <form id="f-set" class="card form">
      ${f('minGoodMin', 'Good window length', 'min', 1, 60, 1, 'A stretch counts as good coverage only if it lasts this long')}
      ${f('minTunnelM', 'Ignore tunnels shorter than', 'm', 0, 5000, 50, 'Short tunnels rarely drop the connection')}
      ${f('leadMin', 'Alert before losing network', 'min', 0, 10, 0.5, '')}
      ${f('marginBeforeS', 'Signal fades before a tunnel', 's', 0, 120, 5, '')}
      ${f('marginAfterS', 'Reconnect time after a tunnel', 's', 0, 180, 5, '')}
      ${f('mergeGapM', 'Join tunnels closer than', 'm', 0, 3000, 50, 'Short gaps between tunnels rarely give usable signal')}
      <label class="check"><input type="checkbox" name="notify" ${settings.notify ? 'checked' : ''}> Show system notifications</label>
      <div class="btnrow"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="reset">Defaults</button></div>
    </form>
    <section class="card small">
      <h2>About the data</h2>
      <p>Tracks and tunnels come from OpenStreetMap (© OpenStreetMap contributors, ODbL), refreshed monthly. Train stops and times come live from ViaggiaTreno when you look up a train number. Nothing is sent to any TrainHotspot server: there is none.</p>
      <p>"No network" zones are estimated from tunnels. Some tunnels have repeaters, and some open stretches (deep valleys, rural areas) have poor signal; those are not yet taken into account.</p>
    </section>`;
  const form = $view.querySelector('#f-set');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const k of ['minGoodMin', 'minTunnelM', 'leadMin', 'marginBeforeS', 'marginAfterS', 'mergeGapM']) {
      const v = Number(form[k].value); if (Number.isFinite(v)) settings[k] = v;
    }
    settings.notify = form.notify.checked;
    saveSettings(settings); toast('Saved'); history.back();
  });
  $view.querySelector('#reset').addEventListener('click', () => { localStorage.removeItem('th-settings'); settings = loadSettings(); renderSettings(); });
}

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
updateNetState();
route();
