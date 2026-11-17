// Trips in IndexedDB, settings in localStorage.
import { DEFAULT_SETTINGS } from './trip.js';

const DB = 'trainhotspot', STORE = 'trips';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}

export const saveTrip = (trip) => tx('readwrite', (s) => s.put(trip));
export const deleteTrip = (id) => tx('readwrite', (s) => s.delete(id));
export const getTrip = (id) => tx('readonly', (s) => s.get(id));
export async function listTrips() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => (b.profile.t[0] || 0) - (a.profile.t[0] || 0));
}

export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('th-settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { try { localStorage.setItem('th-settings', JSON.stringify(s)); } catch { /* ignore */ } }

export async function persistStorage() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
