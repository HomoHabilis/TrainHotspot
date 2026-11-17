// Synthetic straight line along latitude 44.0 from lon 11.0 to 12.0 (about 80 km),
// with three stations and three tunnels. Same format as tools/build_rail_data.py output.
export function syntheticGraph() {
  const nodes = [];
  const edges = [];
  const node = (lat, lon) => { nodes.push(Math.round(lat * 1e5), Math.round(lon * 1e5)); return nodes.length / 2 - 1; };
  const pt = (i) => [44.0, 11.0 + i * 0.01];
  const cuts = [0, 10, 14, 30, 33, 34, 50, 60, 75, 77, 100];
  const tunnels = new Set(['10-14', '30-33', '75-77']);
  let prev = node(...pt(0));
  const stationNode = {};
  stationNode[0] = prev;
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k], b = cuts[k + 1];
    const inner = [];
    let [pl, po] = pt(a).map((v) => Math.round(v * 1e5));
    for (let j = a + 1; j < b; j++) {
      const [l, o] = pt(j).map((v) => Math.round(v * 1e5));
      inner.push(l - pl, o - po); pl = l; po = o;
    }
    const nb = node(...pt(b));
    stationNode[b] = nb;
    const len = Math.round((b - a) * 0.01 * 111320 * Math.cos((44 * Math.PI) / 180));
    edges.push([prev, nb, len, tunnels.has(`${a}-${b}`) ? 1 : 0, 160, 0, a === 30 ? 1 : 0, inner]);
    prev = nb;
  }
  const graph = { v: 1, nodes, edges, names: ['', 'Galleria Test'] };
  const stations = [
    { n: 'Alpha Centrale', la: 44.0, lo: 11.0, g: [stationNode[0]] },
    { n: 'Beta', la: 44.0, lo: 11.5, g: [stationNode[50]] },
    { n: 'Gamma', la: 44.0, lo: 12.0, g: [stationNode[100]] },
  ];
  return { graph, stations };
}
