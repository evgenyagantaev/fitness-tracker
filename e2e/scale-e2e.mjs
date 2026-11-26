// v1.9 smart scale: web «Вес» tab (cards, chart, table, delete), profile in Settings, and the app weigh screen
// with a mocked WorkoutRecorder that emits Mi Scale frames. Starts its own server on a temp DB (synthetic data only).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { SERVER_DIR, WWW, shot } from './paths.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const PORT = 8093, SERVER = `http://127.0.0.1:${PORT}/`, TOKEN = 'scale-test-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const OUT = process.env.SHOT_DIR;
const shotPath = (n) => (OUT ? join(OUT, n) : shot(n));

const tmp = mkdtempSync(join(tmpdir(), 'scale-e2e-'));
const py = process.env.PYTHON || join(SERVER_DIR, '..', '.venv-server', 'bin', 'python');
const srv = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
  cwd: SERVER_DIR, env: { ...process.env, FITNESS_DB: join(tmp, 'f.db'), FITNESS_API_TOKEN: TOKEN }, stdio: 'ignore' });
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const req = (m, u, b) => fetch(`http://127.0.0.1:${PORT}/` + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
try {
  for (let i = 0; i < 50; i++) { try { await req('GET', 'api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
  // synthetic weighings over 3 weeks (no profile yet)
  const day = 86400000, t0 = Date.UTC(2026, 10, 5, 5, 0, 0);
  const items = [];
  for (let k = 0; k < 12; k++) {
    const w = Math.round((82.4 - k * 0.18 + (k % 3) * 0.15) * 200) / 200;
    items.push({ id: `mi-test-${k}`, t: t0 + k * 2 * day, weight_kg: w, impedance: k === 4 ? null : 505 - k * 2, scale_time: 'x', source: 'mi-scale-2' });
  }
  items.push({ id: 'mi-test-wrong', t: t0 + 23 * day, weight_kg: 23.5, impedance: null, source: 'mi-scale-2' });   // the dog stepped on it
  ok((await req('POST', 'api/weighings', { items })).added === 13, '13 synthetic weighings stored');

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
  // ---- web ----
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1500 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  page.on('dialog', (d) => d.accept());
  await page.goto(SERVER);
  await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tabs button[data-tab=weight]');
  await page.waitForSelector('#scaleData:not(.hidden)');
  ok(await page.isVisible('#scaleProfileHint'), 'profile hint shown while the profile is empty');
  ok(!(await page.isVisible('#scaleWeigh')), 'no «Взвеситься» button on the website');
  // profile
  await page.click('.tabs button[data-tab=settings]'); await page.waitForLoadState('networkidle');
  await page.fill('#profHeight', '178'); await page.fill('#profBirth', '1980'); await page.selectOption('#profSex', 'm');
  await page.click('#profSave');
  await page.waitForFunction(() => /Сохранено/.test(document.querySelector('#profMsg').textContent));
  await page.click('.tabs button[data-tab=weight]');
  await page.waitForFunction(() => document.querySelectorAll('#scaleTable tr').length === 14);
  await page.waitForFunction(() => document.querySelector('#scaleProfileHint').classList.contains('hidden'), null, { timeout: 8000 }).catch(async (e) => { console.error('DBG', await page.evaluate(() => [localStorage.getItem('ft.scaleCache')?.slice(0, 300), document.querySelector('#profMsg').textContent])); throw e; });
  // delete the wrong one (newest, first row)
  const before = await page.$$eval('#scaleTable tr', (r) => r.length);
  await page.click('#scaleTable tr:nth-child(2) .scale-del');
  await page.waitForFunction((n) => document.querySelectorAll('#scaleTable tr').length === n - 1, before);
  ok(!(await page.textContent('#scaleTable')).includes('23,50'), 'wrong weighing deleted');
  const c = await page.evaluate(() => { const ch = Chart.getChart('scaleChart'); return ch.data.datasets.map((d) => [d.label, d.data.length]); });
  ok(c[0][1] === 12 && c[1][1] === 11 && c[2][1] === 11, 'chart: weight 12 points, fat & muscle 11 (one weighing had no impedance) ' + JSON.stringify(c));
  const cards = await page.textContent('#scaleCards');
  ok(/жир, %/.test(cards) && /ИМТ/.test(cards) && !/—\s*жир/.test(cards), 'cards with composition');
  await page.waitForTimeout(300);
  await page.locator('#tab-weight').screenshot({ path: shotPath('scale-web.png') });
  await page.click('.tabs button[data-tab=settings]');
  await page.locator('#profHeight').scrollIntoViewIfNeeded();
  await page.locator('#profSave').locator('xpath=..').screenshot({ path: shotPath('scale-profile.png') });

  // ---- app weigh screen with a mocked native scanner ----
  if (existsSync(WWW)) {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    await ctx.route('http://localhost/**', (route) => {
      let p = new URL(route.request().url()).pathname; if (p.endsWith('/')) p += 'index.html';
      if (p === '/vendor/capacitor.js' || p === '/vendor/bluetooth-le.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      const f = join(WWW, p);
      if (!existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
      route.fulfill({ status: 200, contentType: types[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
    });
    await ctx.addInitScript(([srv, tok]) => {
      localStorage.setItem('ft.config', JSON.stringify({ serverUrl: srv, token: tok }));
      const L = {}; let store = [];
      window.__scale = { emit: (f) => (L.scale || []).forEach((cb) => cb(f)), store: (w) => store.push(w) };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { WorkoutRecorder: {
        async addListener(n, cb) { (L[n] = L[n] || []).push(cb); return { remove: async () => { L[n] = (L[n] || []).filter((x) => x !== cb); } }; },
        async scaleStart() { window.__scale.started = true; },
        async scaleStop() { window.__scale.stopped = true; },
        async scaleConfig() { return { passive: true, permitted: true }; },
        async takeScaleReadings() { const a = store; store = []; return { readings: a }; },
        async getState() { return { running: false }; },
      } } };
    }, [SERVER, TOKEN]);
    const ap = await ctx.newPage();
    ap.on('pageerror', (e) => { console.error('APP PAGE ERROR', e.message); process.exitCode = 1; });
    await ap.goto('http://localhost/');
    await ap.waitForSelector('#app:not(.hidden)');
    await ap.click('.tabs button[data-tab=weight]');
    await ap.click('#scaleWeigh');
    await ap.waitForFunction(() => window.__scale.started);
    await ap.evaluate(() => window.__scale.emit({ weight_kg: 79.85, impedance: 0, stable: false, removed: false, final: false, saved: false, unit: 'kg', id: 'mi-x', scale_time: '2026-11-26T08:00:00' }));
    ok((await ap.textContent('#scaleLive')).includes('79,85'), 'live weight shown while settling');
    await ap.evaluate(() => window.__scale.emit({ weight_kg: 80.1, impedance: 0, stable: true, removed: false, final: true, saved: true, unit: 'kg', id: 'mi-20261126T080000-16020-kg', scale_time: '2026-11-26T08:00:00' }));
    await ap.evaluate(() => window.__scale.emit({ weight_kg: 80.1, impedance: 498, stable: true, removed: false, final: true, saved: true, unit: 'kg', id: 'mi-20261126T080000-16020-kg', scale_time: '2026-11-26T08:00:00' }));
    ok(/498 Ом/.test(await ap.textContent('#scaleLive')), 'final weight with impedance');
    await ap.waitForFunction(() => document.querySelectorAll('#scaleTable tr').length === 14, null, { timeout: 10000 });
    const srvItems = (await req('GET', 'api/weighings')).items;
    const mine = srvItems.find((w) => w.id === 'mi-20261126T080000-16020-kg');
    ok(mine && mine.impedance === 498 && mine.comp.fat_pct > 5, 'weighing from the app reached the server with composition: ' + JSON.stringify(mine && mine.comp));
    await ap.screenshot({ path: shotPath('scale-app.png') });
    await ap.waitForFunction(() => window.__scale.stopped, null, { timeout: 8000 });
    ok(true, 'scan stops by itself after the composition arrived');
  }
  await browser.close();
} finally { srv.kill(); }
