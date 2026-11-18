// Alerts: in-page banner + sound/vibration in the foreground, system notifications
// through the service worker (shown in the background while the browser keeps the page alive).
import { timeAtKm } from './trip.js';
import { t } from './i18n.js';

export function predictedTime(trip, km, delayMs) {
  return timeAtKm(trip.profile, km) + delayMs;
}

// Build the alert plan from coverage segments.
export function alertPlan(trip, coverage, settings) {
  const ev = [];
  const segs = coverage.segments;
  segs.forEach((sg, i) => {
    if (sg.kind !== 'bad') return;
    const durMin = Math.max(1, Math.round((sg.te - sg.ts) / 60000));
    const what = sg.count > 1 ? t('a.tunnels', { n: sg.count }) : (sg.names[0] ? t('a.tunnel.named', { s: sg.names[0] }) : t('a.tunnel'));
    ev.push({ id: `pre-${sg.s.toFixed(3)}`, km: sg.s, leadMs: settings.leadMin * 60000, kind: 'pre',
      title: t('a.pre.title', { n: settings.leadMin }), body: t('a.pre.body', { d: durMin, what }) });
    const next = segs[i + 1];
    if (next && next.kind === 'good') {
      const g = Math.round((next.te - next.ts) / 60000);
      ev.push({ id: `exit-${sg.e.toFixed(3)}`, km: sg.e, leadMs: 0, kind: 'exit',
        title: t('a.exit.title'), body: t('a.exit.body', { n: g }) });
    }
  });
  return ev;
}

export class Alerter {
  constructor(tripId) {
    this.key = 'th-fired-' + tripId;
    try { this.fired = new Set(JSON.parse(localStorage.getItem(this.key) || '[]')); } catch { this.fired = new Set(); }
    this.audioCtx = null;
  }

  save() { try { localStorage.setItem(this.key, JSON.stringify([...this.fired])); } catch { /* ignore */ } }

  reset() { this.fired.clear(); this.save(); }

  // Returns the events fired in this check
  check(trip, plan, estimate, now, settings, onFire) {
    const out = [];
    for (const e of plan) {
      if (this.fired.has(e.id)) continue;
      const at = predictedTime(trip, e.km, estimate.delayMs);
      const due = at - e.leadMs;
      // also fire when the estimated position has passed the point (GPS ahead of schedule)
      const passed = estimate.km >= e.km - (e.kind === 'pre' ? 0.5 : 0);
      if ((now >= due || passed) && now <= at + 180000 && estimate.km <= e.km + 1) {
        this.fired.add(e.id);
        out.push(e);
      } else if (now > at + 180000 || estimate.km > e.km + 1) {
        this.fired.add(e.id); // stale, skip silently
      }
    }
    if (out.length) {
      this.save();
      if (settings.notify) for (const e of out) this.notify(e);
      onFire?.(out);
    }
    return out;
  }

  async notify(e) {
    try { navigator.vibrate?.(e.kind === 'pre' ? [300, 150, 300] : [150]); } catch { /* ignore */ }
    if (document.visibilityState === 'visible') this.beep(e.kind === 'pre' ? 440 : 880);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const opts = { body: e.body, tag: 'trainhotspot', renotify: true, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', vibrate: [300, 150, 300] };
      if (reg) await reg.showNotification(e.title, opts);
      else new Notification(e.title, opts);
    } catch { /* ignore */ }
  }

  beep(freq) {
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.audioCtx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.55);
    } catch { /* ignore */ }
  }
}

// Chrome-only experiment (Notification Triggers). Schedules notifications that fire even
// if the page is closed. Silently does nothing where unsupported (almost everywhere).
export async function scheduleTriggers(trip, plan, delayMs) {
  if (!('TimestampTrigger' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const now = Date.now();
    for (const e of plan) {
      const at = predictedTime(trip, e.km, delayMs) - e.leadMs;
      if (at <= now) continue;
      // eslint-disable-next-line no-undef
      await reg.showNotification(e.title, { body: e.body, tag: 'th-' + e.id, showTrigger: new TimestampTrigger(at) });
    }
    return true;
  } catch { return false; }
}

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

// Keep the screen on (best way to keep tracking + alerts running on every platform)
export class ScreenLock {
  constructor() { this.lock = null; this.wanted = false; document.addEventListener('visibilitychange', () => this.reacquire()); }
  get supported() { return 'wakeLock' in navigator; }
  async on() { this.wanted = true; return this.reacquire(); }
  async off() { this.wanted = false; try { await this.lock?.release(); } catch { /* ignore */ } this.lock = null; }
  async reacquire() {
    if (!this.wanted || document.visibilityState !== 'visible' || !this.supported) return false;
    try { this.lock = await navigator.wakeLock.request('screen'); return true; } catch { return false; }
  }
}

// Experimental: a near-inaudible low tone keeps the page "playing audio", which stops some
// browsers (mostly Chrome on Android) from freezing it in the background. Costs battery.
export class KeepAlive {
  constructor() { this.ctx = null; }
  get active() { return !!this.ctx; }
  start() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 25; g.gain.value = 0.015;
    o.connect(g).connect(ctx.destination); o.start();
    this.ctx = ctx;
    if ('mediaSession' in navigator) {
      try {
        // eslint-disable-next-line no-undef
        navigator.mediaSession.metadata = new MediaMetadata({ title: t('ka.title'), artist: t('ka.artist') });
      } catch { /* ignore */ }
    }
  }
  stop() { try { this.ctx?.close(); } catch { /* ignore */ } this.ctx = null; }
}
