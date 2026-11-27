// v1.17 pull-up counter: set screen driven by a mocked native session (native countdown → reps → auto close on idle),
// sets land on the day board (📲) and on the server with the raw block; site section. Own server on a temp DB, synthetic data only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { SERVER_DIR, WWW, shot } from './paths.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const PORT = 8096, SERVER = `http://127.0.0.1:${PORT}/`, TOKEN = 'pull-test-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const OUT = process.env.SHOT_DIR;
const shotPath = (n) => (OUT ? join(OUT, n) : shot(n));
const tmp = mkdtempSync(join(tmpdir(), 'pull-e2e-'));
const py = process.env.PYTHON || join(SERVER_DIR, '..', '.venv-server', 'bin', 'python');
const srv = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
  cwd: SERVER_DIR, env: { ...process.env, FITNESS_DB: join(tmp, 'f.db'), FITNESS_API_TOKEN: TOKEN }, stdio: 'ignore' });
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const req = (m, u, b) => fetch(`http://127.0.0.1:${PORT}/` + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
try {
  for (let i = 0; i < 50; i++) { try { await req('GET', 'api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
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
    const L = {}; let pending = []; const S = { active: false, reps: 0, countdown: 0, t0: 0, recording: false };
    const emit = (n, e) => (L[n] || []).forEach((cb) => cb(e));
    const st = () => ({ active: S.active, reps: S.reps, countdown: S.countdown, sensorOk: true, id: 'pl-' + S.t0 });
    const mk = (reason) => S.reps ? { id: 'pl-' + S.t0, t: S.t0, reps: S.reps, duration_s: S.reps * 2.1, armed_s: 40, source: 'accel', close: reason, rep_ms: [], params: 'v1', raw_fmt: 'pullraw1', raw_n: 3, raw: 'eJxjYGBgAAAABAAB' } : null;
    window.__pull = {
      S, calls: [],
      tick: () => { if (S.countdown > 0) S.countdown -= 1; emit('pullup', st()); },
      rep: () => { S.reps += 1; emit('pullup', st()); },
      idle: () => { const set = mk('idle'); S.active = false; if (set) pending.push(set); const lite = set && Object.assign({}, set); if (lite) delete lite.raw; emit('pullupFinished', { set: lite, reason: 'idle' }); },
      setRecording: (v) => { S.recording = v; },
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { WorkoutRecorder: {
      addListener(n, cb) { (L[n] = L[n] || []).push(cb); return { remove: async () => {} }; },
      async pullupInfo() { return Object.assign(st(), { present: true, recording: S.recording, pushups: false }); },
      async pullupStart({ countdown }) { window.__pull.calls.push('start:' + countdown); Object.assign(S, { active: true, reps: 0, countdown, t0: Date.now() }); },
      async pullupUndo() { if (S.reps > 0) S.reps -= 1; emit('pullup', st()); },
      async pullupFinish() { const set = mk('app'); S.active = false; if (set) pending.push(set); const lite = set && Object.assign({}, set); if (lite) delete lite.raw; return { set: lite }; },
      async takePullupSets() { const a = pending; pending = []; return { sets: a }; },
      async pushupInfo() { return { present: true, active: false, recording: false }; },
      async takePushupSets() { return { sets: [] }; },
      async getState() { return { running: false }; },
      async scaleConfig() { return { passive: true, permitted: true }; },
      async takeScaleReadings() { return { readings: [] }; },
    } } };
  }, [SERVER, TOKEN]);
  const ap = await ctx.newPage();
  ap.on('pageerror', (e) => { console.error('APP PAGE ERROR', e.message); process.exitCode = 1; });
  await ap.goto('http://localhost/');
  await ap.waitForSelector('#app:not(.hidden)');
  await ap.click('.tabs button[data-tab=pull]');
  await ap.waitForSelector('#pullStart', { state: 'visible' });
  // refused during a workout recording
  await ap.evaluate(() => window.__pull.setRecording(true));
  await ap.click('#pullStart');
  await ap.waitForFunction(() => document.getElementById('pullMsg').textContent.includes('запись тренировки'));
  ok(!(await ap.evaluate(() => window.__pull.calls.length)), 'not started while a workout is recorded');
  await ap.evaluate(() => window.__pull.setRecording(false));
  await ap.click('#pullStart');
  await ap.waitForFunction(() => window.__pull.calls.includes('start:8'));
  ok(await ap.isVisible('#pullOverlay') && (await ap.textContent('#pullCount')) === '8', 'native countdown of 8 s shown');
  for (let i = 0; i < 8; i++) await ap.evaluate(() => window.__pull.tick());
  ok((await ap.textContent('#pullPhase')) === 'Считаю' && (await ap.textContent('#pullCount')) === '0', 'counting after the countdown');
  for (let i = 0; i < 9; i++) await ap.evaluate(() => window.__pull.rep());
  ok((await ap.textContent('#pullCount')) === '9', 'counter shows 9');
  // the app going to the background does not close it
  await ap.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await ap.waitForTimeout(1200);
  ok(await ap.isVisible('#pullOverlay') && (await ap.textContent('#pullCount')) === '9', 'background / return keeps the set');
  const ub = await ap.locator('#pullUndo').boundingBox();
  await ap.mouse.move(ub.x + 10, ub.y + 10); await ap.mouse.down(); await ap.waitForTimeout(800); await ap.mouse.up();
  await ap.waitForFunction(() => document.getElementById('pullCount').textContent === '8');
  ok(true, 'holding −1 drops a rep');
  await ap.screenshot({ path: shotPath('pull-app-counter.png') });
  await ap.evaluate(() => window.__pull.idle());
  await ap.waitForFunction(() => document.querySelector('#pullOverlay').classList.contains('hidden'));
  ok((await ap.textContent('#pullMsg')).includes('8 с без повторов'), 'auto-closed set recorded: ' + (await ap.textContent('#pullMsg')));
  const cells = await ap.evaluate(() => FT.Store.view(FT.localDate()).sets.pullups.cells);
  ok(cells.length >= 1 && cells[0].reps === 8 && cells[0].src === 'auto', 'board pull-up row got an auto cell: ' + JSON.stringify(cells));
  await ap.waitForFunction(async () => (await fetch(JSON.parse(localStorage.getItem('ft.config')).serverUrl + 'api/pullups', { headers: { Authorization: 'Bearer pull-test-token' } }).then((r) => r.json())).items.length === 1, null, { timeout: 10000 });
  const srvSets = (await req('GET', 'api/pullups')).items;
  ok(srvSets.length === 1 && srvSets[0].reps === 8 && srvSets[0].has_raw === true, 'server has the set with its raw block');
  ok((await req('GET', 'api/pullups/' + srvSets[0].id + '/raw')).fmt === 'pullraw1', 'raw readable on the server');
  // second set ended in the app
  await ap.click('#pullStart');
  await ap.waitForFunction(() => window.__pull.calls.filter((c) => c.startsWith('start')).length === 2);
  for (let i = 0; i < 8; i++) await ap.evaluate(() => window.__pull.tick());
  for (let i = 0; i < 5; i++) await ap.evaluate(() => window.__pull.rep());
  const fb = await ap.locator('#pullFinish').boundingBox();
  await ap.mouse.move(fb.x + 10, fb.y + 10); await ap.mouse.down(); await ap.waitForTimeout(1300); await ap.mouse.up();
  await ap.waitForFunction(() => document.querySelector('#pullOverlay').classList.contains('hidden'));
  const cells2 = await ap.evaluate(() => FT.Store.view(FT.localDate()).sets.pullups.cells.filter((c) => c.reps > 0).map((c) => c.reps));
  ok(JSON.stringify(cells2) === '[8,5]', 'second set in the next cell: ' + JSON.stringify(cells2));
  await ap.waitForSelector('#pullData:not(.hidden)');
  await ap.waitForTimeout(500);
  const cards = (await ap.textContent('#pullCards')).replace(/\s+/g, ' ');
  ok(/13.*подтягиваний сегодня/.test(cards) && /2.*подходов сегодня/.test(cards), 'Сегодня from the board: ' + cards);
  await ap.locator('#tab-pull').screenshot({ path: shotPath('pull-app-section.png') });
  await browser.close();
} finally { srv.kill(); }
