// Station lookup and matching (OSM station names <-> ViaggiaTreno names/codes).

const ABBR = [
  [/\bs\.\s*m\.\s*/g, 'santa maria '], [/\bs\.\s*/g, 'san '], [/\bc\.le\b/g, 'centrale'],
  [/\bp\.\s*/g, 'porta '], [/\bstaz\.?\b/g, ''], [/\bv\.\s*/g, 'via '],
];

export function norm(s) {
  let x = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, rep] of ABBR) x = x.replace(re, rep);
  return x.replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(stazione|di|del|della|fs)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

export class StationIndex {
  constructor(list) {
    this.list = list;
    this.byVt = new Map();
    for (const s of list) {
      s._n = norm(s.n);
      if (s.vt) this.byVt.set(s.vt, s);
    }
  }

  search(q, limit = 12) {
    const nq = norm(q);
    if (!nq) return [];
    const words = nq.split(' ');
    const scored = [];
    for (const s of this.list) {
      if (!words.every((w) => s._n.includes(w))) continue;
      const score = (s._n.startsWith(nq) ? 0 : 1) + s._n.length / 100;
      scored.push([score, s]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const out = [], seen = new Set();
    for (const [, s] of scored) { if (!seen.has(s.n)) { seen.add(s.n); out.push(s); } if (out.length >= limit) break; }
    return out;
  }

  // Nearest station to a point, within maxM metres
  nearest(lat, lon, maxM = 600) {
    let best = null, bd = Infinity;
    const k = Math.cos((lat * Math.PI) / 180);
    for (const s of this.list) {
      const dy = (s.la - lat) * 111320, dx = (s.lo - lon) * 111320 * k;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    return best && Math.sqrt(bd) <= maxM ? best : null;
  }

  byName(name) {
    const n = norm(name);
    return this.list.find((s) => s._n === n) || null;
  }

  // Best match for a ViaggiaTreno stop; `near` (station) helps break ties
  match(name, code, near = null) {
    if (code && this.byVt.has(code)) return this.byVt.get(code);
    const nq = norm(name);
    let exact = this.list.filter((s) => s._n === nq);
    if (!exact.length) {
      const words = nq.split(' ').filter((w) => w.length > 1);
      let best = null, bestScore = 0;
      for (const s of this.list) {
        const sw = s._n.split(' ');
        const common = words.filter((w) => sw.includes(w)).length;
        if (!common) continue;
        const score = common / Math.max(words.length, sw.length) + (sw[0] === words[0] ? 0.3 : 0);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      exact = best && bestScore >= 0.5 ? [best] : [];
    }
    if (exact.length > 1 && near) {
      exact.sort((a, b) => dist2(a, near) - dist2(b, near));
    }
    return exact[0] || null;
  }
}

function dist2(a, b) { return (a.la - b.la) ** 2 + (a.lo - b.lo) ** 2; }
