import { findTrain, tripDetails } from '../app/js/transitous.js';
const tomorrow = new Date(Date.now() + 86400000);
const z = (n) => String(n).padStart(2, '0');
const date = `${tomorrow.getFullYear()}-${z(tomorrow.getMonth() + 1)}-${z(tomorrow.getDate())}`;
const cases = [
  ['9603', { n: 'Milano Centrale', la: 45.48588, lo: 9.20426 }],
  ['2213', { n: 'Milano Centrale', la: 45.48588, lo: 9.20426 }],
  ['597', { n: 'Firenze Santa Maria Novella', la: 43.77757, lo: 11.24742 }],
  ['9531', { n: 'Roma Termini', la: 41.90058, lo: 12.50253 }],
];
for (const [num, st] of cases) {
  try {
    const t0 = Date.now();
    const res = await findTrain(num, date, st);
    console.log(num, st.n, date, JSON.stringify(res), `${Date.now() - t0} ms`);
    if (res[0]) {
      const d = await tripDetails(res[0].tripId);
      console.log('  ', d.title, d.category, d.mode, 'delay', d.delayMin, 'rt', d.realTime, d.stops.map((s) => `${s.name}@${s.dep ? new Date(s.dep).toISOString().slice(11, 16) : '-'}`).join(' > '));
    }
  } catch (e) { console.log(num, 'ERR', e.message); }
}
