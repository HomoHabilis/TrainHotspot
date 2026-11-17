// Browser smoke test: serves app/ locally, builds a trip both ways (stations, and
// train number with the timetable service mocked) and fails on any page error.
// Run with: node tests/e2e.mjs   (needs the playwright package and Chromium)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// require() so a globally installed playwright (NODE_PATH) also works
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const errors = [];
const browser = await chromium.launch();
let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log('ok -', name); } catch (e) { failed = true; console.log('not ok -', name, '\n  ', e.message); }
};

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // Mocked Transitous answers for train 9603 Milano Centrale -> Napoli
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const T = (h, m) => new Date(day.getTime() + (h * 60 + m) * 60000).toISOString();
  await page.route('https://api.transitous.org/**', (r) => {
    const u = r.request().url();
    const H = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    const json = (b) => r.fulfill({ headers: H, body: JSON.stringify(b) });
    if (u.includes('/geocode')) return json([{ type: 'STOP', name: 'Milano Centrale', id: 'mi', lat: 45.48634, lon: 9.20454, country: 'IT', modes: ['HIGHSPEED_RAIL'] }]);
    if (u.includes('/stoptimes')) return json({ stopTimes: [
      { place: { scheduledDeparture: T(6, 0) }, tripId: 'T1', tripShortName: '9603', displayName: 'FR 9603', headsign: 'NAPOLI CENTRALE', agencyName: 'TRENITALIA' },
    ], nextPageCursor: null });
    if (u.includes('/trip')) return json({ legs: [{ mode: 'HIGHSPEED_RAIL', displayName: 'FR 9603', routeShortName: 'FR', tripShortName: '9603', realTime: false,
      from: { name: 'MILANO CENTRALE', lat: 45.48634, lon: 9.20454, scheduledDeparture: T(6, 0) },
      intermediateStops: [
        { name: 'Bologna C.le/AV', lat: 44.506234, lon: 11.342267, scheduledArrival: T(7, 4), scheduledDeparture: T(7, 7) },
        { name: 'FIRENZE S. M. NOVELLA', lat: 43.7765, lon: 11.248, scheduledArrival: T(7, 42), scheduledDeparture: T(7, 50) },
        { name: 'ROMA TERMINI', lat: 41.901, lon: 12.5016, scheduledArrival: T(9, 10), scheduledDeparture: T(9, 20) },
      ],
      to: { name: 'NAPOLI CENTRALE', lat: 40.852232, lon: 14.27291, scheduledArrival: T(10, 33) } }] });
    return r.fulfill({ status: 404 });
  });

  await step('home page loads', async () => {
    await page.goto(BASE);
    await page.waitForSelector('a[href="#/new"]', { timeout: 10000 });
  });

  await step('trip from stations shows outline, coverage and windows', async () => {
    await page.goto(BASE + '#/new');
    await page.click('[data-tab=stations]');
    await page.fill('[name=from]', 'Firenze Santa Maria Novella');
    await page.fill('[name=to]', 'Bologna Centrale');
    await page.fill('[name=dep]', '10:00');
    await page.fill('[name=arr]', '10:40');
    await page.click('#f-st button[type=submit]');
    await page.waitForSelector('#outline svg', { timeout: 30000 });
    const pct = await page.textContent('.pct');
    if (!/\d+\s*%/.test(pct)) throw new Error('no coverage percentage: ' + pct);
    await page.waitForSelector('#windows');
  });

  await step('trip from train number (mocked timetable) and Update now', async () => {
    await page.goto(BASE + '#/new');
    await page.fill('[name=num]', '9603');
    await page.fill('[name=board]', 'Milano Centrale');
    await page.fill('[name=alight]', 'Roma Termini');
    await page.click('#f-train button[type=submit]');
    await page.waitForSelector('#outline svg', { timeout: 30000 });
    const stops = await page.textContent('#stops');
    if (!/Roma Termini/i.test(stops) || /Napoli/i.test(stops)) throw new Error('unexpected stops: ' + stops.replace(/\s+/g, ' '));
    await page.click('#b-now');
    await page.waitForFunction(() => /Updated/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 });
  });

  await step('settings page renders', async () => {
    await page.goto(BASE + '#/settings');
    await page.waitForSelector('input', { timeout: 10000 });
  });

  await step('trip list shows both trips with a grade', async () => {
    await page.goto(BASE + '#/');
    await page.waitForFunction(() => document.querySelectorAll('.triplist li .grade').length >= 2, null, { timeout: 10000 });
  });

  await step('Italian phone gets the Italian interface, and the language can be changed', async () => {
    const it = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', locale: 'it-IT' });
    const p2 = await it.newPage();
    p2.on('pageerror', (e) => errors.push('pageerror (it): ' + e.message));
    await p2.goto(BASE);
    await p2.waitForSelector('.hero h1');
    const h = await p2.textContent('.hero h1');
    if (!/rete/.test(h)) throw new Error('hero not in Italian: ' + h);
    if (await p2.getAttribute('html', 'lang') !== 'it') throw new Error('html lang not it');
    await p2.goto(BASE + '#/new');
    await p2.click('[data-tab=stations]');
    await p2.fill('[name=from]', 'Firenze Santa Maria Novella');
    await p2.fill('[name=to]', 'Bologna Centrale');
    await p2.fill('[name=dep]', '10:00');
    await p2.click('#f-st button[type=submit]');
    await p2.waitForSelector('#grade-badge .grade', { timeout: 30000 });
    const g = await p2.textContent('#grade');
    if (!/interruzion/.test(g)) throw new Error('grade line not in Italian: ' + g);
    await p2.goto(BASE + '#/settings');
    await p2.selectOption('select[name=lang]', 'de');
    await p2.click('#f-set button[type=submit]');
    await p2.goto(BASE + '#/');
    await p2.waitForFunction(() => /Netz/.test(document.querySelector('.hero h1')?.textContent || ''), null, { timeout: 10000 });
    await it.close();
  });
} finally {
  await browser.close();
  server.close();
}

if (errors.length) { failed = true; console.log('not ok - page errors:\n  ' + errors.join('\n  ')); }
process.exit(failed ? 1 : 0);
