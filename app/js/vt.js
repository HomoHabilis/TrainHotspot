// ViaggiaTreno (Trenitalia infomobility) client, called directly from the user's browser.
// Unofficial API: used only live, for the user's own train, never stored server-side.
const BASE = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/';

async function get(path, asText = false) {
  let r;
  try {
    r = await fetch(BASE + path, { mode: 'cors' });
  } catch (e) {
    const err = new Error('Train lookup is not reachable from this browser (offline, or blocked by ViaggiaTreno). Use the Stations tab instead.');
    err.blocked = true;
    throw err;
  }
  if (!r.ok) throw new Error('ViaggiaTreno error ' + r.status);
  return asText ? r.text() : r.json();
}

// -> [{ label, num, origCode, millis }]
export async function searchTrain(num) {
  const txt = await get('cercaNumeroTrenoTrenoAutocomplete/' + encodeURIComponent(num), true);
  return txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [label, key] = l.split('|');
    const [n, code, millis] = (key || '').split('-');
    return { label: label.trim(), num: n, origCode: code, millis: Number(millis) };
  }).filter((x) => x.origCode);
}

// -> { title, category, delayMin, stops: [{ name, code, arr, dep }] }
export async function trainDetails(origCode, num, millis) {
  const d = await get(`andamentoTreno/${origCode}/${num}/${millis}`);
  if (!d || !d.fermate) throw new Error('No details for this train.');
  const stops = d.fermate.map((f) => ({
    name: titleCase(f.stazione),
    code: f.id,
    arr: f.arrivo_teorico || (f.tipoFermata === 'A' ? f.programmata : null) || null,
    dep: f.partenza_teorica || (f.tipoFermata === 'P' ? f.programmata : null) || null,
  }));
  const cat = (d.compNumeroTreno || d.categoria || '').trim();
  return {
    title: (cat.includes(String(num)) ? cat : `${cat || 'Train'} ${num}`).replace(/\s+/g, ' '),
    category: (d.categoria || cat.split(' ')[0] || '').toUpperCase(),
    delayMin: typeof d.ritardo === 'number' ? d.ritardo : 0,
    stops,
  };
}

// Current delay only (for refresh while online)
export async function currentDelay(origCode, num, millis) {
  const d = await get(`andamentoTreno/${origCode}/${num}/${millis}`);
  return typeof d.ritardo === 'number' ? d.ritardo : null;
}

export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s'.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
}

// High-speed categories run on AV lines; regional trains should avoid them.
export function isHighSpeedCategory(cat) {
  return /^(FR|FA|FB|ES|ITA|IT|AV|EC|EN)/i.test(cat || '') && !/^(REG|RV|IC)/i.test(cat || '');
}
