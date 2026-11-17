import { loadGraph, loadStations } from './graph.js';
import { buildTrip, computeCoverage, computeGrade, timeAtKm } from './trip.js';
import { StationIndex } from './stations.js';
import { findTrain, tripDetails, currentDelay } from './transitous.js';
import { Tracker } from './tracker.js';
import { Alerter, alertPlan, requestNotifications, ScreenLock, KeepAlive, scheduleTriggers, predictedTime } from './alerts.js';
import { saveTrip, deleteTrip, getTrip, listTrips, loadSettings, saveSettings, persistStorage } from './store.js';
import { t, setLang, lang, locale, LANGS } from './i18n.js';

const $view = document.getElementById('view');
const UI_REFRESH_MS = 60000;   // outline, percentages and times
const ALERT_CHECK_MS = 10000;  // alert checks (browsers throttle this in the background)

let settings = loadSettings();
setLang(settings.lang);
let stationIndex = null;
let live = null; // running trip session

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const dayLabel = (ms) => new Date(ms).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const fmtDur = (ms) => { const m = mins(ms); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
function toast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
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
  el.textContent = navigator.onLine ? t('online') : t('offline');
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
    $view.innerHTML = `<section class="card error"><h2>${t('wrong')}</h2><p>${esc(e.message)}</p><a class="btn" href="#/">${t('back')}</a></section>`;
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
      <h1>${t('hero.title')}</h1>
      <p>${t('hero.text')}</p>
      <a class="btn primary big" href="#/new">${t('plan')}</a>
    </section>
    ${isIOS && !standalone ? `<section class="card hint">${t('ios.tip')}</section>` : ''}
    <section>
      <h2 class="section-title">${t('trips')}</h2>
      ${trips.length ? `<ul class="triplist">${trips.map((tr) => {
        const cov = computeCoverage(tr, settings);
        const gr = computeGrade(cov);
        const past = tr.profile.t[tr.profile.t.length - 1] < now;
        return `<li class="${past ? 'past' : ''}">
          <a href="#/trip/${encodeURIComponent(tr.id)}">
            <span class="tl-title">${esc(tr.title)}</span>
            <span class="tl-sub">${dayLabel(tr.profile.t[0])} · ${hhmm(tr.profile.t[0])} → ${hhmm(tr.profile.t[tr.profile.t.length - 1])} · ${Math.round(tr.lengthKm)} km</span>
            ${miniBar(tr, cov)}
            <span class="tl-cov"><b class="grade grade-${gr.grade} sm">${gr.grade}</b> ${t('pct.with', { p: Math.round(cov.coveredPct) })} · ${interruptionsText(gr.interruptions)}</span>
          </a>
          <button class="iconbtn del" data-del="${esc(tr.id)}" aria-label="${t('del')}">✕</button>
        </li>`;
      }).join('')}</ul>` : `<p class="muted">${t('notrips')}</p>`}
    </section>`;
  $view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('del.confirm'))) return;
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
    <h1 class="page-title">${t('plan')}</h1>
    <div class="tabs" role="tablist">
      <button role="tab" class="tab active" data-tab="train" aria-selected="true">${t('tab.train')}</button>
      <button role="tab" class="tab" data-tab="stations" aria-selected="false">${t('tab.stations')}</button>
    </div>
    <section class="card tabpanel" id="tab-train">
      <form id="f-train" class="form">
        <div class="row two">
          <label>${t('f.num')} <input name="num" inputmode="numeric" pattern="[0-9]+" required placeholder="${t('f.num.ph')}" autocomplete="off"></label>
          <label>${t('f.date')} <input name="date" type="date" required value="${todayStr()}"></label>
        </div>
        <label>${t('f.board')} <input name="board" list="stlist" required autocomplete="off" placeholder="${t('f.board.ph')}"></label>
        <label>${t('f.alight')} <input name="alight" list="stlist" autocomplete="off" placeholder="${t('f.alight.ph')}"></label>
        <button class="btn primary" type="submit">${t('f.find')}</button>
        <p class="muted small">${t('f.train.note')}</p>
      </form>
      <div id="train-results"></div>
    </section>
    <section class="card tabpanel" id="tab-stations" hidden>
      <form id="f-st" class="form">
        <label>${t('f.from')} <input name="from" list="stlist" required autocomplete="off" placeholder="${t('f.from.ph')}"></label>
        <div id="vias"></div>
        <button type="button" class="btn link" id="add-via">${t('f.addvia')}</button>
        <label>${t('f.to')} <input name="to" list="stlist" required autocomplete="off" placeholder="${t('f.to.ph')}"></label>
        <div class="row">
          <label>${t('f.date')} <input name="date" type="date" required value="${todayStr()}"></label>
          <label>${t('f.dep')} <input name="dep" type="time" required></label>
          <label>${t('f.arr')} <input name="arr" type="time"></label>
        </div>
        <label class="check"><input type="checkbox" name="regional"> ${t('f.regional')}</label>
        <button class="btn primary" type="submit">${t('f.build')}</button>
        <p class="muted small">${t('f.st.note')}</p>
      </form>
    </section>
    <datalist id="stlist"></datalist>
    <div id="build-status"></div>`;

  const tabs = $view.querySelectorAll('.tab');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((x) => { x.classList.toggle('active', x === tab); x.setAttribute('aria-selected', x === tab); });
    $view.querySelector('#tab-train').hidden = tab.dataset.tab !== 'train';
    $view.querySelector('#tab-stations').hidden = tab.dataset.tab !== 'stations';
    fillStationList();
  }));
  fillStationList();

  $view.querySelector('#add-via').addEventListener('click', () => {
    const vias = $view.querySelector('#vias');
    if (vias.children.length >= 6) return;
    const l = document.createElement('label');
    l.innerHTML = `${t('f.via')} <input name="via" list="stlist" autocomplete="off" placeholder="${t('f.via.ph')}">`;
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
  const idx = await stations();
  const board = idx.byName(f.board.value) || idx.match(f.board.value);
  const alight = f.alight.value.trim() ? (idx.byName(f.alight.value) || idx.match(f.alight.value)) : null;
  if (!board) { out.innerHTML = `<p class="error">${t('e.board')}</p>`; return; }
  if (f.alight.value.trim() && !alight) { out.innerHTML = `<p class="error">${t('e.alight')}</p>`; return; }
  out.innerHTML = `<p class="muted">${t('searching')}</p>`;
  try {
    const res = await findTrain(num, date, board);
    if (!res.length) {
      out.innerHTML = `<p>${t('e.notrain', { num: esc(num), st: esc(board.n) })}</p>`;
      return;
    }
    if (res.length === 1) { out.innerHTML = ''; return onTrainPick(res[0], board, alight); }
    out.innerHTML = `<p class="small muted">${t('pick')}</p><ul class="choices">${res.map((r, i) =>
      `<li><button class="btn choice" data-i="${i}">${hhmm(r.dep)} · ${esc(r.label)}</button></li>`).join('')}</ul>`;
    out.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => onTrainPick(res[b.dataset.i], board, alight)));
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p><button class="btn" id="go-st">${t('use.st')}</button>`;
    out.querySelector('#go-st').addEventListener('click', () => $view.querySelector('[data-tab=stations]').click());
  }
}

async function onTrainPick(r, board, alight) {
  const status = $view.querySelector('#build-status');
  status.innerHTML = `<section class="card"><p>${t('loading.train')}</p></section>`;
  try {
    const d = await tripDetails(r.tripId);
    // keep only the part of the run the user travels on
    const near = (st) => {
      let bi = -1, bd = Infinity;
      d.stops.forEach((s, i) => { const x = (s.lat - st.la) ** 2 + (s.lon - st.lo) ** 2; if (x < bd) { bd = x; bi = i; } });
      return bi;
    };
    let i0 = near(board), i1 = alight ? near(alight) : d.stops.length - 1;
    if (i1 <= i0) i1 = d.stops.length - 1;
    const stops = d.stops.slice(i0, i1 + 1).map((s, i, arr) => ({ ...s, arr: i === 0 ? null : s.arr, dep: i === arr.length - 1 ? null : s.dep }));
    await buildAndOpen({
      stops, title: `${d.title} ${stops[0].name} → ${stops[stops.length - 1].name}`,
      avoidHighSpeed: d.mode !== 'HIGHSPEED_RAIL' && !/^(FR|FA|FB|EC|ES)/.test(d.category),
      source: 'transitous',
      train: { tripId: r.tripId, title: d.title, category: d.category, delayMin: d.realTime ? d.delayMin : 0 },
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
  if (missing.length) { toast(t('e.unknown', { s: missing.join(', ') })); return; }
  const day = localMidnight(f.date.value);
  const at = (v) => { if (!v) return null; const [h, m] = v.split(':').map(Number); return day + (h * 60 + m) * 60000; };
  const dep = at(f.dep.value);
  let arr = at(f.arr.value);
  if (arr && arr < dep) arr += 86400000;
  const stops = resolved.map((s, i) => ({ name: s.n, station: s, arr: i === resolved.length - 1 ? arr : null, dep: i === 0 ? dep : null }));
  await buildAndOpen({ stops, title: `${resolved[0].n} → ${resolved[resolved.length - 1].n}`, avoidHighSpeed: f.regional.checked, source: 'manual' });
}

async function buildAndOpen({ stops, title, avoidHighSpeed, source, train }) {
  const status = $view.querySelector('#build-status');
  const say = (m) => { status.innerHTML = `<section class="card"><p>${m}</p></section>`; };
  try {
    say(t('loading.net'));
    const [graph, idx] = await Promise.all([loadGraph(), stations()]);
    say(t('routing'));
    await new Promise((r) => setTimeout(r, 30));
    let prevSt = null;
    const routeStops = stops.map((s) => {
      const st = s.station || (s.lat != null ? idx.nearest(s.lat, s.lon, 800) : null) || idx.match(s.name, s.code, prevSt);
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
  if (!trip) { $view.innerHTML = `<section class="card"><p>${t('notfound')}</p><a class="btn" href="#/">${t('back')}</a></section>`; return; }
  if (!live || live.trip.id !== id) startLive(trip);
  $view.innerHTML = `
    <section class="trip-head">
      <h1 class="page-title">${esc(trip.title)}</h1>
      <p class="muted">${dayLabel(trip.profile.t[0])} · ${hhmm(trip.profile.t[0])} → ${hhmm(trip.profile.t[trip.profile.t.length - 1])} · ${Math.round(trip.lengthKm)} km · ${t('n.stops', { n: trip.stops.length })}</p>
      ${trip.skipped?.length ? `<p class="warn small">${t('skipped', { s: esc(trip.skipped.join(', ')) })}</p>` : ''}
    </section>
    <section id="now" class="card now" aria-live="polite"></section>
    <section class="card">
      <div class="cov-head">
        <h2>${t('outline')}</h2>
        <span id="grade-badge"></span>
      </div>
      <div id="pct" class="pct"></div>
      <p id="grade" class="grade-line small"></p>
      <div id="outline" class="outline"></div>
      <div class="legend"><span><i class="sw seg-good"></i>${t('lg.good', { n: settings.minGoodMin })}</span><span><i class="sw seg-short"></i>${t('lg.short')}</span><span><i class="sw seg-bad"></i>${t('lg.bad')}</span></div>
    </section>
    <section class="card">
      <h2>${t('windows')}</h2>
      <ol id="windows" class="windows"></ol>
    </section>
    <section class="card controls">
      <h2>${t('tracking')}</h2>
      <div class="btnrow">
        <button class="btn primary" id="b-track"></button>
        <button class="btn" id="b-notif"></button>
        <button class="btn" id="b-wake"></button>
      </div>
      <label class="check"><input type="checkbox" id="c-keep"> ${t('keep')}</label>
      <div class="delay">
        <span>${t('delay')} <strong id="delay-v"></strong></span>
        <button class="btn sm" data-d="-1">−1</button><button class="btn sm" data-d="1">+1</button><button class="btn sm" data-d="5">+5</button>
      </div>
      <p id="track-info" class="small muted"></p>
      <details class="small"><summary>${t('bg.q')}</summary>
        <p>${t('bg.1')}</p>
        <p>${t('bg.2')}</p>
        <p>${t('bg.3')}</p>
      </details>
    </section>
    <section class="card">
      <details><summary><h2 class="inline">${t('stops')}</h2></summary><ol id="stops" class="stops"></ol></details>
      <details><summary><h2 class="inline">${t('tunnels')} (${trip.tunnels.length})</h2></summary><ol id="tunnels" class="stops"></ol></details>
      <details><summary><h2 class="inline">${t('demo')}</h2></summary>
        <p class="small muted">${t('demo.text')}</p>
        <div class="btnrow"><button class="btn" id="b-sim"></button></div>
      </details>
    </section>
    <p class="small muted attribution">${t('attrib')}</p>`;

  const L = live;
  $view.querySelector('#b-track').addEventListener('click', () => { L.tracking ? L.stopTracking() : L.startTracking(); paintControls(); });
  $view.querySelector('#b-notif').addEventListener('click', async () => {
    const p = await requestNotifications();
    toast(p === 'granted' ? t('n.on') : p === 'unsupported' ? t('n.unsup') : t('n.blocked.long'));
    if (p === 'granted') scheduleTriggers(trip, L.plan, L.tracker.delayMs);
    paintControls();
  });
  $view.querySelector('#b-wake').addEventListener('click', async () => {
    if (L.wake.wanted) await L.wake.off(); else if (!(await L.wake.on())) toast(t('wake.unsup'));
    paintControls();
  });
  $view.querySelector('#c-keep').addEventListener('change', (e) => { if (e.target.checked) L.keep.start(); else L.keep.stop(); });
  $view.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    L.tracker.delayMs += Number(b.dataset.d) * 60000; L.refresh(true);
  }));
  // "Update now" lives in the status card, which is redrawn: delegate the click
  $view.querySelector('#now').addEventListener('click', (e) => { if (e.target.closest('#b-now')) L.updateNow(); });
  $view.querySelector('#b-sim').addEventListener('click', () => { L.toggleSim(); paintControls(); });

  $view.querySelector('#stops').innerHTML = trip.stops.map((s, i) => `<li><span class="t">${s.arr && i ? hhmm(s.arr) : ''}${s.dep && i < trip.stops.length - 1 ? (i ? ' – ' : '') + hhmm(s.dep) : ''}</span> ${esc(s.name)} <span class="muted">km ${Math.round(s.km)}</span></li>`).join('');
  $view.querySelector('#tunnels').innerHTML = trip.tunnels.map((tu) => `<li><span class="t">${hhmm(timeAtKm(trip.profile, tu.s))}</span> ${esc(tu.name || t('tunnel'))} <span class="muted">${((tu.e - tu.s) * 1000) >= 1000 ? (tu.e - tu.s).toFixed(1) + ' km' : Math.round((tu.e - tu.s) * 1000) + ' m'} · km ${tu.s.toFixed(1)}</span></li>`).join('') || `<li class="muted">${t('notunnels')}</li>`;
  paintControls();
  L.refresh(true);
}

function paintControls() {
  if (!live) return;
  const q = (s) => $view.querySelector(s);
  if (!q('#b-track')) return;
  q('#b-track').textContent = live.tracking ? t('track.stop') : t('track.start');
  q('#b-track').classList.toggle('active', live.tracking);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  q('#b-notif').textContent = perm === 'granted' ? t('n.on') : perm === 'denied' ? t('n.blocked') : t('n.enable');
  q('#b-notif').disabled = perm === 'granted' || perm === 'denied';
  q('#b-wake').textContent = live.wake.wanted ? t('wake.on') : t('wake.off');
  q('#b-wake').classList.toggle('active', live.wake.wanted);
  q('#c-keep').checked = live.keep.active;
  q('#b-sim').textContent = live.sim ? t('sim.stop') : t('sim.start');
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
  s.grade = computeGrade(s.coverage);
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
  // Manual refresh: fresh GPS fix (if tracking), live delay (if online and looked up by
  // train number, used only when GPS hasn't fixed the delay recently), then redraw.
  s.updateNow = async () => {
    if (s.updating) return;
    s.updating = true; s.refresh(true);
    const notes = [];
    const jobs = [];
    if (s.tracking && !s.sim && 'geolocation' in navigator) {
      jobs.push(new Promise((res) => navigator.geolocation.getCurrentPosition(
        (p) => { s.tracker.onFix(p); notes.push('GPS'); res(); },
        () => res(), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })));
    }
    if (trip.train?.tripId && navigator.onLine && !s.sim) {
      jobs.push(currentDelay(trip.train.tripId).then((d) => {
        const last = s.tracker.fixes[s.tracker.fixes.length - 1];
        if (d != null && !(last && Date.now() - last.t < 120000)) { s.tracker.setDelayMin(d); notes.push(t('upd.delay', { n: d })); }
      }).catch(() => {}));
    }
    await Promise.all(jobs);
    s.updating = false;
    s.refresh(true);
    toast(notes.length ? t('upd.with', { s: notes.join(', ') }) : t('upd'));
  };
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
    html = `<div class="now-main"><span class="dot dot-idle"></span><div><strong>${t('departs', { t: hhmm(pt(0)) })}</strong><span>${firstGood ? t('firstgood', { t: hhmm(pt(firstGood.s)) }) : t('nolong')}</span></div></div>`;
  } else if (ended) {
    html = `<div class="now-main"><span class="dot dot-idle"></span><div><strong>${t('finished')}</strong><span>${t('arrived', { t: hhmm(pt(trip.lengthKm)) })}</span></div></div>`;
  } else {
    const nextBad = segs.find((g) => g.kind === 'bad' && g.e > est.km && g !== cur);
    if (cur.kind === 'bad') {
      const after = segs[segs.indexOf(cur) + 1];
      html = `<div class="now-main"><span class="dot dot-bad"></span><div><strong>${t('nonet')}</strong><span>${t('back.at', { t: hhmm(pt(cur.e)), d: fmtDur(pt(cur.e) - now) })}${after?.kind === 'good' ? t('then.good', { d: fmtDur(after.te - after.ts) }) : ''}</span></div></div>`;
    } else {
      const until = nextBad ? pt(nextBad.s) : pt(trip.lengthKm);
      const kind = cur.kind === 'good' ? t('good.now') : t('short.now');
      html = `<div class="now-main"><span class="dot dot-${cur.kind}"></span><div><strong>${kind}</strong><span>${nextBad ? t('for.until', { d: fmtDur(until - now), t: hhmm(until) }) : t('until.arr', { t: hhmm(until) })}</span></div></div>`;
    }
  }
  const src = { gps: 'GPS', 'dead-reckoning': t('src.dr'), schedule: t('src.sched'), replay: t('src.replay') }[est.source] || est.source;
  html += `<div class="now-foot"><p class="small muted">${t('pos', { s: src })}${est.speed ? ` · ${Math.round(est.speed)} km/h` : ''} · ${t('km.of', { a: est.km.toFixed(0), b: Math.round(trip.lengthKm) })} · ${t('updated.at', { t: new Date(now).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: s.sim ? undefined : '2-digit' }) })}</p><button class="btn sm" id="b-now"${s.updating ? ' disabled' : ''}>${s.updating ? t('updating') : t('update.now')}</button></div>`;
  el('#now').innerHTML = html;

  // Percentages (whole trip + remaining)
  const remaining = segs.filter((g) => g.e > est.km);
  let remAll = 0, remOk = 0;
  for (const g of remaining) {
    const d = pt(g.e) - pt(Math.max(g.s, est.km));
    remAll += d; if (g.kind !== 'bad') remOk += d;
  }
  const remPct = remAll > 0 ? Math.round((100 * remOk) / remAll) : 0;
  el('#pct').innerHTML = `${t('pct.trip', { p: `<strong>${Math.round(coverage.coveredPct)}%</strong>` })}<br><span class="small muted">${t('pct.windows', { p: Math.round(coverage.goodPct), n: settings.minGoodMin })}${started && !ended ? ` · ${t('pct.left', { p: remPct })}` : ''}</span>`;
  const gr = s.grade;
  el('#grade-badge').innerHTML = `<b class="grade grade-${gr.grade}" title="${esc(t('grade.title'))}" aria-label="${esc(t('grade.title'))}: ${gr.grade}">${gr.grade}</b>`;
  el('#grade').innerHTML = `<strong>${t('grade.' + gr.grade)}</strong> · <span class="muted">${interruptionsText(gr.interruptions)} · ${t('typical', { d: fmtDur(gr.typicalMs) })}</span> <a href="#/settings" class="muted">(?)</a>`;

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
      <span class="w-where">${esc(nearStop(trip, g.s))} → ${esc(nearStop(trip, g.e))}${nowIn ? ` · <strong>${t('now')}</strong>` : ''}</span>
    </li>`;
  }).join('') : `<li class="muted">${t('nowindows', { n: settings.minGoodMin })}</li>`;

  // Controls info
  const tr = s.tracker;
  const gps = t('gps.' + tr.gpsState);
  if (el('#track-info')) el('#track-info').textContent = s.sim ? t('info.sim') : s.tracking ? t('info.track', { g: gps, n: settings.leadMin }) : t('info.idle');
  if (el('#delay-v')) el('#delay-v').textContent = `${Math.round(delay / 60000)} min`;
}

function interruptionsText(n) {
  return n === 0 ? t('intr.0') : n === 1 ? t('intr.1') : t('intr.n', { n });
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
  if (lm && ld < sd && ld < 15) return lm.on && Math.abs(lm.km - km) < 2 ? lm.name : t('near', { s: lm.name });
  return sd < 15 ? t('near', { s: best.name }) : `km ${Math.round(km)}`;
}

// Linear trip outline: time axis, colored segments, stops, current position
function outlineSvg(trip, cov, km, pt, showPos) {
  const W = 600, H = 116, X0 = 8, X1 = W - 8, Y = 30, BH = 30;
  const t0 = pt(0), t1 = pt(trip.lengthKm), span = (t1 - t0) || 1;
  const x = (k) => X0 + ((pt(k) - t0) / span) * (X1 - X0);
  const rects = cov.segments.map((s) => `<rect class="seg-${s.kind}" x="${x(s.s).toFixed(1)}" y="${Y}" width="${Math.max(1.2, x(s.e) - x(s.s)).toFixed(1)}" height="${BH}"><title>${t('seg.' + s.kind)}: ${hhmm(pt(s.s))}–${hhmm(pt(s.e))}</title></rect>`).join('');
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
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('outline.aria'))}">${rects}${stops}${pos}</svg>`;
}
const short = (n) => (n.length > 16 ? n.slice(0, 15) + '…' : n);

// ---------- settings ----------
function renderSettings() {
  const f = (k, label, unit, min, max, step = 1, help = '') => `
    <label class="setting"><span>${label}<small>${help}</small></span>
      <span class="inp"><input type="number" name="${k}" value="${settings[k]}" min="${min}" max="${max}" step="${step}"> ${unit}</span></label>`;
  $view.innerHTML = `
    <h1 class="page-title">${t('settings')}</h1>
    <form id="f-set" class="card form">
      <label class="setting"><span>${t('s.lang')}</span>
        <span class="inp"><select name="lang">
          <option value="auto"${settings.lang === 'auto' ? ' selected' : ''}>${t('s.lang.auto')}</option>
          ${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${settings.lang === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select></span></label>
      ${f('minGoodMin', t('s.minGood'), 'min', 1, 60, 1, t('s.minGood.h'))}
      ${f('minTunnelM', t('s.minTunnel'), 'm', 0, 5000, 50, t('s.minTunnel.h'))}
      ${f('leadMin', t('s.lead'), 'min', 0, 10, 0.5, '')}
      ${f('marginBeforeS', t('s.before'), 's', 0, 120, 5, '')}
      ${f('marginAfterS', t('s.after'), 's', 0, 180, 5, '')}
      ${f('mergeGapM', t('s.merge'), 'm', 0, 3000, 50, t('s.merge.h'))}
      <label class="check"><input type="checkbox" name="notify" ${settings.notify ? 'checked' : ''}> ${t('s.notify')}</label>
      <div class="btnrow"><button class="btn primary" type="submit">${t('save')}</button><button class="btn" type="button" id="reset">${t('defaults')}</button></div>
    </form>
    <section class="card small">
      <h2>${t('grade.how')}</h2>
      <p>${t('grade.explain')}</p>
    </section>
    <section class="card small">
      <h2>${t('about')}</h2>
      <p>${t('about.1')}</p>
      <p>${t('about.2')}</p>
      <p>${t('about.3')}</p>
    </section>`;
  const form = $view.querySelector('#f-set');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const k of ['minGoodMin', 'minTunnelM', 'leadMin', 'marginBeforeS', 'marginAfterS', 'mergeGapM']) {
      const v = Number(form[k].value); if (Number.isFinite(v)) settings[k] = v;
    }
    settings.notify = form.notify.checked;
    settings.lang = form.lang.value;
    setLang(settings.lang); translateChrome();
    saveSettings(settings); toast(t('saved')); history.back();
  });
  $view.querySelector('#reset').addEventListener('click', () => { localStorage.removeItem('th-settings'); settings = loadSettings(); setLang(settings.lang); translateChrome(); renderSettings(); });
}

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
// Static parts of index.html
function translateChrome() {
  document.documentElement.lang = lang();
  document.querySelector('.brand').setAttribute('aria-label', t('home.aria'));
  document.querySelector('a[href="#/settings"]').setAttribute('aria-label', t('settings'));
  document.getElementById('netstate').title = t('net.title');
  updateNetState();
}
translateChrome();
route();
