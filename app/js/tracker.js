// Position along the trip: GPS snapping to the track polyline + dead reckoning.
import { timeAtKm, kmAtTime, speedAtKm } from './trip.js';

const MAX_SNAP_M = 400;

export class Tracker {
  constructor(trip, onUpdate) {
    this.trip = trip;
    this.onUpdate = onUpdate;
    this.fixes = [];            // { t, km, acc }
    this.lastIdx = -1;
    this.delayMs = 0;           // delay vs. schedule
    this.watchId = null;
    this.gpsState = 'off';      // off | waiting | ok | lost | denied | far
    this.lastFix = null;
    // local projection
    const lat0 = trip.lat[Math.floor(trip.lat.length / 2)] * Math.PI / 180;
    this.kx = 111320 * Math.cos(lat0);
    this.ky = 110540;
  }

  setDelayMin(min) { this.delayMs = min * 60000; }

  start() {
    if (!('geolocation' in navigator)) { this.gpsState = 'unavailable'; return; }
    this.gpsState = 'waiting';
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onFix(p),
      (e) => { this.gpsState = e.code === 1 ? 'denied' : 'lost'; this.onUpdate?.(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.gpsState = 'off';
  }

  // Project a point on the polyline. Searches near the last match first.
  snap(lat, lon) {
    const { lat: L, lon: O, cum } = this.trip;
    const x = lon * this.kx, y = lat * this.ky;
    const scan = (a, b) => {
      let best = { d: Infinity };
      for (let i = Math.max(0, a); i < Math.min(L.length - 1, b); i++) {
        const ax = O[i] * this.kx, ay = L[i] * this.ky, bx = O[i + 1] * this.kx, by = L[i + 1] * this.ky;
        const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
        const u = dd ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / dd)) : 0;
        const d = Math.hypot(x - (ax + u * dx), y - (ay + u * dy));
        if (d < best.d) best = { d, i, km: cum[i] + u * (cum[i + 1] - cum[i]) };
      }
      return best;
    };
    let best = this.lastIdx >= 0 ? scan(this.lastIdx - 300, this.lastIdx + 1500) : { d: Infinity };
    if (best.d > MAX_SNAP_M) best = scan(0, L.length);
    return best;
  }

  onFix(p) {
    const { latitude, longitude, accuracy } = p.coords;
    const t = p.timestamp || Date.now();
    const s = this.snap(latitude, longitude);
    this.lastFix = { t, lat: latitude, lon: longitude, acc: accuracy, dist: s.d };
    if (s.d > MAX_SNAP_M + (accuracy || 0)) { this.gpsState = 'far'; this.onUpdate?.(); return; }
    if (accuracy > 1000) { this.gpsState = 'lost'; this.onUpdate?.(); return; }
    // reject impossible jumps backwards (> 2 km behind)
    const prev = this.fixes[this.fixes.length - 1];
    if (prev && s.km < prev.km - 2 && t - prev.t < 600000) return;
    this.lastIdx = s.i;
    this.fixes.push({ t, km: s.km, acc: accuracy });
    while (this.fixes.length > 2 && t - this.fixes[0].t > 90000) this.fixes.shift();
    this.gpsState = 'ok';
    // delay vs. schedule (near = actual time to resolve dwell at stations)
    const sched = timeAtKm(this.trip.profile, s.km, t);
    this.delayMs = t - sched;
    this.onUpdate?.();
  }

  // Speed in km/h from recent fixes (null if unknown)
  speedKmh() {
    const f = this.fixes;
    if (f.length < 2) return null;
    const a = f[0], b = f[f.length - 1];
    const dt = (b.t - a.t) / 3600000;
    if (dt < 10 / 3600) return null;
    return Math.max(0, (b.km - a.km) / dt);
  }

  // Estimated position (km) at time `now`, with source + uncertainty
  estimate(now = Date.now()) {
    const p = this.trip.profile;
    const schedKm = kmAtTime(p, now - this.delayMs);
    const last = this.fixes[this.fixes.length - 1];
    if (!last) return { km: schedKm, source: 'schedule', speed: null, delayMs: this.delayMs };
    const dt = (now - last.t) / 1000;
    if (dt < 15) return { km: last.km, source: 'gps', speed: this.speedKmh(), delayMs: this.delayMs };
    // dead reckoning with measured speed, capped by line speed, blended into schedule over 2 min
    let v = this.speedKmh();
    if (v == null) v = 0;
    v = Math.min(v, speedAtKm(this.trip, last.km) * 1.05);
    const drKm = Math.min(this.trip.lengthKm, last.km + (v * dt) / 3600);
    const w = Math.max(0, Math.min(1, (dt - 15) / 120));
    const km = (1 - w) * drKm + w * Math.max(schedKm, last.km);
    return { km, source: 'dead-reckoning', speed: v, delayMs: this.delayMs, sinceFixS: dt };
  }
}
