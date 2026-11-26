// v1.10 push-up counter: set screen with a mocked native plugin (countdown → counter → hold to finish), sets land on the day board
// with their real reps and on the server, site section (today / trend / delete). Own server on a temp DB, synthetic data only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { SERVER_DIR, WWW, shot } from './paths.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const PORT = 8094, SERVER = `http://127.0.0.1:${PORT}/`, TOKEN = 'push-test-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const OUT = process.env.SHOT_DIR;
const shotPath = (n) => (OUT ? join(OUT, n) : shot(n));
const tmp = mkdtempSync(join(tmpdir(), 'push-e2e-'));
const py = process.env.PYTHON || join(SERVER_DIR, '..', '.venv-server', 'bin', 'python');
const srv = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
  cwd: SERVER_DIR, env: { ...process.env, FITNESS_DB: join(tmp, 'f.db'), FITNESS_API_TOKEN: TOKEN }, stdio: 'ignore' });
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const req = (m, u, b) => fetch(`http://127.0.0.1:${PORT}/` + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
try {
  for (let i = 0; i < 50; i++) { try { await req('GET', 'api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
  // yesterday and the day before: two synthetic sets each, so the trend has something to show
  const now = Date.now(), DAY = 86400000;
  const old = [];
  for (let k = 1; k <= 9; k++) for (let j = 0; j < 2; j++) old.push({ id: `pu-old-${k}-${j}`, t: now - k * DAY - j * 600000, reps: 14 + k + j * 3, duration_s: 25 + k });
  ok((await req('POST', 'api/pushups', { items: old })).added === 18, '18 synthetic old sets stored');

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
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
    const L = {}; let pending = []; let reps = 0, t0 = 0, recording = false;
    window.__push = {
      rep: () => { reps += 1; (L.pushup || []).forEach((cb) => cb({ reps, undo: false })); },
      setRecording: (v) => { recording = v; },
      unlock: () => { (L.pushupUnlocked || []).forEach((cb) => cb({})); },
      calls: [],
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { WorkoutRecorder: {
      async addListener(n, cb) { (L[n] = L[n] || []).push(cb); return { remove: async () => { L[n] = (L[n] || []).filter((x) => x !== cb); } }; },
      async setPushupGuard({ on }) { window.__push.calls.push(on ? 'guard-on' : 'guard-off'); },
      async pushupInfo() { return { present: true, maxRange: 5, binary: true, sensor: 'mock', voice: true, active: false, recording }; },
      async pushupStart() { window.__push.calls.push('start'); reps = 0; t0 = Date.now(); },
      async pushupUndo() { if (reps > 0) { reps -= 1; (L.pushup || []).forEach((cb) => cb({ reps, undo: true })); } window.__push.calls.push('undo'); },
      async pushupFinish() { window.__push.calls.push('finish'); const set = reps ? { id: 'pu-' + t0 + '-' + (reps + 100), t: t0, reps, duration_s: reps * 1.4, armed_s: 30, source: 'proximity' } : null; if (set) pending.push(set); return { set }; },
      async takePushupSets() { const a = pending; pending = []; return { sets: a }; },
      async getState() { return { running: false }; },
      async scaleConfig() { return { passive: true, permitted: true }; },
      async takeScaleReadings() { return { readings: [] }; },
    } } };
  }, [SERVER, TOKEN]);
  const ap = await ctx.newPage();
  ap.on('pageerror', (e) => { console.error('APP PAGE ERROR', e.message); process.exitCode = 1; });
  await ap.goto('http://localhost/');
  await ap.waitForSelector('#app:not(.hidden)');
  await ap.click('.tabs button[data-tab=push]');
  await ap.waitForSelector('#pushData:not(.hidden)');
  await ap.click('#pushStart');
  ok(await ap.isVisible('#pushOverlay') && (await ap.textContent('#pushCount')) === '5', 'countdown overlay starts at 5');
  ok(await ap.evaluate(() => document.getElementById('pushOverlay').classList.contains('locked')), 'locked during countdown');
  ok((await ap.textContent('#pushHint')).includes('Экран заблокирован'), 'lock hint shown');
  await ap.waitForFunction(() => window.__push.calls.includes('start'), null, { timeout: 9000 });
  ok(true, 'counting started after the countdown');
  ok(await ap.evaluate(() => document.getElementById('pushOverlay').classList.contains('locked')), 'still locked after counting starts');
  ok((await ap.locator('#pushUndo').boundingBox()) == null, 'buttons hidden while locked');
  // a click where the finish button will be must not end the set
  await ap.mouse.click(195, 760);
  ok(await ap.isVisible('#pushOverlay') && await ap.evaluate(() => document.getElementById('pushOverlay').classList.contains('locked')), 'touch is ignored while locked');
  await ap.evaluate(() => window.__push.unlock());
  ok(!(await ap.evaluate(() => document.getElementById('pushOverlay').classList.contains('locked'))), 'volume unlocks the screen');
  ok((await ap.textContent('#pushHint')).includes('Закончить'), 'hint after unlock mentions Закончить');
  for (let i = 0; i < 21; i++) { await ap.evaluate(() => window.__push.rep()); }
  ok((await ap.textContent('#pushCount')) === '21', 'counter shows 21');
  await ap.evaluate(() => { document.querySelector('#pushUndo'); });
  // hold-to-undo: a short tap does nothing, a hold drops a rep
  const ub = await ap.locator('#pushUndo').boundingBox();
  await ap.mouse.move(ub.x + 10, ub.y + 10); await ap.mouse.down(); await ap.waitForTimeout(200); await ap.mouse.up();
  ok((await ap.textContent('#pushCount')) === '21', 'a short tap on −1 does nothing');
  await ap.mouse.move(ub.x + 10, ub.y + 10); await ap.mouse.down(); await ap.waitForTimeout(800); await ap.mouse.up();
  ok((await ap.textContent('#pushCount')) === '20', 'holding −1 drops the last rep');
  await ap.screenshot({ path: shotPath('push-app-counter.png') });
  const fb = await ap.locator('#pushFinish').boundingBox();
  await ap.mouse.move(fb.x + 10, fb.y + 10); await ap.mouse.down(); await ap.waitForTimeout(400); await ap.mouse.up();
  ok(await ap.isVisible('#pushOverlay'), 'a short tap on «Закончить» does not end the set');
  await ap.mouse.move(fb.x + 10, fb.y + 10); await ap.mouse.down(); await ap.waitForTimeout(1500); await ap.mouse.up();
  await ap.waitForFunction(() => document.querySelector('#pushOverlay').classList.contains('hidden'));
  ok((await ap.textContent('#pushMsg')).includes('20'), 'set of 20 recorded: ' + (await ap.textContent('#pushMsg')));
  // second set of 12
  await ap.click('#pushStart'); await ap.waitForFunction(() => window.__push.calls.filter((c) => c === 'start').length === 2, null, { timeout: 9000 });
  ok(await ap.evaluate(() => document.getElementById('pushOverlay').classList.contains('locked')), 'next set starts locked');
  await ap.evaluate(() => window.__push.unlock());
  for (let i = 0; i < 12; i++) await ap.evaluate(() => window.__push.rep());
  const fb2 = await ap.locator('#pushFinish').boundingBox();
  await ap.mouse.move(fb2.x + 10, fb2.y + 10); await ap.mouse.down(); await ap.waitForTimeout(1500); await ap.mouse.up();
  await ap.waitForFunction(() => document.querySelector('#pushOverlay').classList.contains('hidden'));
  // server has both, day board shows them as ticked with the real reps
  await ap.waitForTimeout(800);
  const items = (await req('GET', 'api/pushups?days=2')).items.filter((x) => !x.id.startsWith('pu-old'));
  ok(items.length === 2 && items.map((x) => x.reps).sort().join() === '12,20', 'both sets reached the server: ' + items.map((x) => x.reps));
  const day = await req('GET', 'api/days/' + await ap.evaluate(() => FT.localDate()));
  const s = day.sets.pushups;
  ok(s.cells.length === 2 && s.cells[0].reps === 20 && s.cells[1].reps === 12 && s.cells[0].src === 'auto', 'board: two cells with real reps ' + JSON.stringify(s.cells));
  const todayM = (await req('GET', 'api/stats/daily')).find((d) => d.date === day.date);
  ok(todayM.reps.pushups === 32, 'day stats: 32 reps counted (' + todayM.reps.pushups + ')');
  // more sets than the board plans (5): the board grows
  for (let k = 0; k < 4; k++) await ap.evaluate((k) => FTPush._applyToBoard({ id: 'pu-extra-' + k, t: Date.now(), reps: 10 + k }), k);
  const r2 = await ap.evaluate(() => FT.Store.view(FT.localDate()).sets.pushups.cells.length);
  ok(r2 === 6, 'board has no fixed number of sets: ' + r2);
  // not while recording
  await ap.evaluate(() => window.__push.setRecording(true));
  await ap.click('#pushStart');
  ok(!(await ap.isVisible('#pushOverlay')) && /запись тренировки/.test(await ap.textContent('#pushMsg')), 'refused while a workout is recorded');
  await ap.evaluate(() => window.__push.setRecording(false));
  await ap.click('.tabs button[data-tab=push]');
  await ap.waitForTimeout(600);
  await ap.screenshot({ path: shotPath('push-app-tab.png'), fullPage: true });
  await ap.click('.tabs button[data-tab=today]'); await ap.waitForTimeout(400);
  await ap.screenshot({ path: shotPath('push-app-board.png'), fullPage: true });
  const vals = await ap.$$eval('#checklist [data-ex=pushups] .cell.filled input.reps', (l) => l.map((x) => x.value));
  ok(vals[0] === '20' && vals[1] === '12' && vals.length === 6, 'board cells show real reps: ' + vals.join(','));
  ok((await ap.$$('#checklist [data-ex=pushups] .cell.empty')).length === 1, 'one empty push-up cell below the filled ones');

  // ---- site (plain browser) ----
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1300 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  page.on('dialog', (d) => d.accept());
  await page.goto(SERVER);
  await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tabs button[data-tab=push]');
  await page.waitForSelector('#pushData:not(.hidden)');
  ok(!(await page.isVisible('#pushStart')), 'no counter button on the website');
  await page.waitForTimeout(500);
  const cards = (await page.textContent('#pushCards')).replace(/\s+/g, ' ');
  ok(/32.*отжиманий сегодня/.test(cards) && /2.*подходов сегодня/.test(cards) && /20.*лучший подход/.test(cards), 'site cards: ' + cards);
  await page.locator('#tab-push').screenshot({ path: shotPath('push-web.png') });
  const rows = await page.$$eval('#pushToday tr', (r) => r.length);
  await page.click('#pushToday tr:nth-child(2) .push-del');
  await page.waitForFunction((n) => document.querySelectorAll('#pushToday tr').length === n - 1, rows);
  ok((await req('GET', 'api/pushups?days=2')).items.filter((x) => !x.id.startsWith('pu-old')).length === 1, 'set deleted from the site');
  await browser.close();
} finally { srv.kill(); }
