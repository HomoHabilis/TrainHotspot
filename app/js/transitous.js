// Train lookup through Transitous (https://transitous.org), a free, community-run
// public transport API that browsers can call directly. Italian rail data includes
// Trenitalia (via BusOne, non-commercial use) and Trenord. Italo is not included.
const API = 'https://api.transitous.org/api';
const RAIL = 'HIGHSPEED_RAIL,LONG_DISTANCE,REGIONAL_RAIL,REGIONAL_FAST_RAIL,NIGHT_RAIL,SUBURBAN,RAIL';

async function get(path, params) {
  const url = API + path + '?' + new URLSearchParams(params).toString();
  let r;
  try { r = await fetch(url); } catch {
    throw new Error('Could not reach the timetable service. Check your connection, or use the Stations tab.');
  }
  if (!r.ok) throw new Error('Timetable service error ' + r.status);
  return r.json();
}

// Find the Transitous stop for one of our stations (by name, nearest to its coordinates)
async function findStop(station) {
  const res = await get('/v1/geocode', { text: station.n, type: 'STOP', place: `${station.la},${station.lo}` });
  const rail = res.filter((s) => s.country === 'IT' && (s.modes || []).some((m) => /RAIL|LONG_DISTANCE|SUBURBAN/.test(m)));
  const dist = (s) => (s.lat - station.la) ** 2 + ((s.lon - station.lo) * Math.cos((station.la * Math.PI) / 180)) ** 2;
  rail.sort((a, b) => dist(a) - dist(b));
  const best = rail[0];
  if (!best || Math.sqrt(dist(best)) * 111 > 3) throw new Error(`No timetable stop found for ${station.n}.`);
  return best.id;
}

const numberOf = (st) => {
  const m = String(st.tripShortName || '').match(/(\d+)\s*$/) || String(st.displayName || '').match(/(\d+)\s*$/);
  return m ? m[1] : '';
};

/**
 * Find train `num` calling at `station` on local date `dateStr` (YYYY-MM-DD).
 * Returns [{ tripId, label, dep }]
 */
export async function findTrain(num, dateStr, station) {
  const stopId = await findStop(station);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dayStart = new Date(y, mo - 1, d).getTime();
  const dayEnd = dayStart + 86400000 + 3 * 3600000;
  const found = new Map();
  let params = { stopId, n: 200, time: new Date(dayStart).toISOString(), mode: RAIL };
  for (let page = 0; page < 6; page++) {
    const res = await get('/v5/stoptimes', params);
    let last = dayStart;
    for (const st of res.stopTimes || []) {
      const t = Date.parse(st.place.scheduledDeparture || st.place.scheduledArrival || st.place.departure || '');
      if (t) last = Math.max(last, t);
      if (numberOf(st) === String(num) && !found.has(st.tripId)) {
        found.set(st.tripId, { tripId: st.tripId, label: `${st.displayName} to ${titleCase(st.headsign || '')}`, dep: t, agency: st.agencyName });
      }
    }
    if (found.size || !res.nextPageCursor || last > dayEnd) break;
    params = { stopId, n: 200, pageCursor: res.nextPageCursor, mode: RAIL };
  }
  return [...found.values()].filter((f) => f.dep >= dayStart - 3600000 && f.dep < dayEnd);
}

/**
 * Full stop list of a trip. Times are scheduled (ms); delayMin from real-time data if present.
 * -> { title, category, delayMin, stops: [{ name, lat, lon, arr, dep }] }
 */
export async function tripDetails(tripId) {
  const it = await get('/v5/trip', { tripId });
  const leg = it.legs?.[0];
  if (!leg) throw new Error('No details for this train.');
  const places = [leg.from, ...(leg.intermediateStops || []), leg.to];
  const ms = (s) => (s ? Date.parse(s) : null);
  const stops = places.map((p, i) => ({
    name: titleCase(p.name),
    lat: p.lat, lon: p.lon,
    arr: i === 0 ? null : ms(p.scheduledArrival),
    dep: i === places.length - 1 ? null : ms(p.scheduledDeparture),
  }));
  // current delay: latest stop with real-time data
  let delayMin = 0;
  for (const p of places) {
    const sch = ms(p.scheduledDeparture || p.scheduledArrival), act = ms(p.departure || p.arrival);
    if (sch && act && (p.departureTimestampReason || p.arrivalTimestampReason || '') !== 'NO_RT_DATA') delayMin = Math.round((act - sch) / 60000);
  }
  return {
    title: leg.displayName || `${leg.routeShortName || ''} ${leg.tripShortName || ''}`.trim(),
    category: (leg.routeShortName || '').toUpperCase(),
    mode: leg.mode,
    delayMin,
    realTime: !!leg.realTime,
    stops,
  };
}

export async function currentDelay(tripId) {
  const d = await tripDetails(tripId);
  return d.realTime ? d.delayMin : null;
}

export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s'.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
}
