// v1.11 day board: free cells instead of fixed sets (no norm). Own server on a temp DB, synthetic data only.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_DIR, shot } from './paths.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const PORT = 8095, SERVER = `http://127.0.0.1:${PORT}/`, TOKEN = 'board-test-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const OUT = process.env.SHOT_DIR;
const shotPath = (n) => (OUT ? join(OUT, n) : shot(n));
const tmp = mkdtempSync(join(tmpdir(), 'board-e2e-'));
const py = process.env.PYTHON || join(SERVER_DIR, '..', '.venv-server', 'bin', 'python');
const srv = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
  cwd: SERVER_DIR, env: { ...process.env, FITNESS_DB: join(tmp, 'f.db'), FITNESS_API_TOKEN: TOKEN }, stdio: 'ignore' });
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const req = (m, u, b) => fetch(SERVER + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const yest = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
try {
  for (let i = 0; i < 50; i++) { try { await req('GET', 'api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
  // yesterday in the OLD format: 3 of 5 pull-up sets of 3, push-ups with a phone-counted set
  await req('POST', 'api/sync', { records: [{ date: yest, updated_at: 1, distance: { run: { done: true, km: 3 } },
    sets: { pullups: { reps: 3, done: [true, true, false, true, false] },
      pushups: { reps: 15, done: [true, true, false, false, false], counted: [{ id: 'pu-old-1', reps: 22 }, null, null, null, null] } } }] });

  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 1100 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  page.on('dialog', (d) => d.accept());
  await page.goto(SERVER);
  await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('Синхронизировано'));

  // empty day: one empty cell for pull-ups and push-ups, km cells for run and walk
  const g = (id) => `#checklist [data-ex=${id}]`;
  ok((await page.$$('#checklist .ex-group')).length === 4, 'four exercise groups');
  for (const id of ['pullups', 'pushups']) ok((await page.$$(g(id) + ' .cell.empty')).length === 1 && (await page.$$(g(id) + ' .cell.filled')).length === 0, id + ': a single empty cell');
  ok((await page.$$('#runKm, #walkKm')).length === 2, 'run and walk: one km cell each');
  ok((await page.textContent('#daySummary')).includes('Пока пусто'), 'summary of an empty day');
  ok(!(await page.$('#checklist input[type=checkbox]')), 'no checkboxes any more');
  await page.screenshot({ path: shotPath('board-empty.png') });

  // fill pull-ups by hand: a new empty cell appears below
  await page.fill('#pullupsNew', '7'); await page.press('#pullupsNew', 'Enter');
  await page.waitForSelector(g('pullups') + ' .cell.filled');
  ok((await page.$$(g('pullups') + ' .cell.filled')).length === 1 && (await page.$$(g('pullups') + ' .cell.empty')).length === 1, 'filled one cell → a new empty one below');
  await page.fill('#pullupsNew', '5'); await page.click(g('pullups') + ' .cell-ok');
  await page.waitForFunction(() => document.querySelectorAll('#checklist [data-ex=pullups] .cell.filled').length === 2);
  ok((await page.textContent('#daySummary')).replace(/\s+/g, ' ').includes('подтягивания 12 (2 подхода)'), 'summary = sum: ' + (await page.textContent('#daySummary')));
  // 0 / empty does not create a cell
  await page.fill('#pullupsNew', '0'); await page.press('#pullupsNew', 'Enter');
  ok((await page.$$(g('pullups') + ' .cell.filled')).length === 2, 'zero does not add a cell');
  // edit and delete
  await page.fill(g('pullups') + ' .cell.filled:nth-of-type(2) input.reps', '8'); await page.press(g('pullups') + ' .cell.filled:nth-of-type(2) input.reps', 'Enter');
  await page.waitForFunction(() => document.querySelector('#daySummary').textContent.includes('13'));
  ok(true, 'editing a cell changes the total (13)');
  await page.click(g('pullups') + ' .cell.filled:nth-of-type(3) .cell-x');
  await page.waitForFunction(() => document.querySelectorAll('#checklist [data-ex=pullups] .cell.filled').length === 1);
  ok((await page.textContent('#daySummary')).includes('подтягивания 8 (1 подход)'), 'removing a cell: ' + (await page.textContent('#daySummary')));
  // many sets: no cap at 5
  for (let k = 0; k < 7; k++) { await page.fill('#pushupsNew', String(10 + k)); await page.press('#pushupsNew', 'Enter'); await page.waitForFunction((n) => document.querySelectorAll('#checklist [data-ex=pushups] .cell.filled').length === n, k + 1); }
  ok(true, '7 push-up sets entered, the board keeps adding empty cells');
  // run km
  await page.fill('#runKm', '4.2'); await page.press('#runKm', 'Tab');
  await page.waitForFunction(() => document.querySelector('#daySummary').textContent.includes('бег 4,2 км'));
  ok(true, 'run km goes into the day result');
  // auto: phone-counted set (idempotent)
  await page.evaluate(() => { const s = { id: 'pu-auto-1', t: Date.now(), reps: 31 }; FTPush._applyToBoard(s); FTPush._applyToBoard(s); });
  await page.evaluate(() => { /* rerender */ document.querySelector('.tabs button[data-tab=settings]').click(); document.querySelector('.tabs button[data-tab=today]').click(); });
  const auto = await page.$$eval(g('pushups') + ' .cell-u', (l) => l.filter((x) => x.textContent.includes('📲')).length);
  ok(auto === 1 && (await page.$$(g('pushups') + ' .cell.empty')).length === 1, 'auto set fills one cell (once) and an empty cell stays below');
  await page.screenshot({ path: shotPath('board-filled.png'), fullPage: true });

  // synced to the server and counted in the stats
  await page.waitForFunction(() => JSON.parse(localStorage['ft.dirty']).length === 0, null, { timeout: 10000 });
  const d = await req('GET', 'api/days/' + today);
  ok(d.sets.pullups.cells.length === 1 && d.sets.pushups.cells.length === 8 && d.distance.run.km === 4.2, 'server holds the cells');
  const daily = await req('GET', 'api/stats/daily?from=' + yest);
  const dT = daily.find((x) => x.date === today), dY = daily.find((x) => x.date === yest);
  ok(dT.reps.pullups === 8 && dT.reps.pushups === 10 + 11 + 12 + 13 + 14 + 15 + 16 + 31 && dT.km.run === 4.2, 'day stats = sum of cells: ' + JSON.stringify(dT.reps));
  ok(dY.reps.pullups === 9 && dY.reps.pushups === 22 + 15 && dY.sets.pullups === 3, 'legacy day unchanged in stats: ' + JSON.stringify(dY.reps));

  // the legacy record is displayed as cells; the stored one stays untouched
  const legacy = await page.evaluate((y) => { const v = FT.Store.view(y); return [v.sets.pullups.cells.length, v.sets.pushups.cells.map((c) => c.reps)]; }, yest);
  ok(legacy[0] === 3 && legacy[1].join() === '22,15', 'legacy view → cells: ' + JSON.stringify(legacy));
  const raw = await req('GET', 'api/days/' + yest);
  ok(raw.sets.pullups.done && !raw.sets.pullups.cells, 'stored legacy record not rewritten');
  ok(await page.evaluate(() => FT.Store.progress(FT.localDate()).complete), 'a day with activity stops the reminders');

  // site stats tab still renders
  await page.click('.tabs button[data-tab=stats]');
  await page.waitForFunction(() => document.querySelectorAll('#streakCards .card').length === 7, null, { timeout: 10000 });
  ok(true, 'stats tab renders (7 cards)');

  // midnight rollover → empty board, the day before is kept
  const c3 = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const p3 = await c3.newPage();
  await p3.clock.install({ time: new Date('2027-03-01T23:59:00+03:00') });
  await p3.goto(SERVER); await p3.evaluate((t) => localStorage.setItem('ft.config', JSON.stringify({ token: t })), TOKEN); await p3.reload();
  await p3.waitForSelector('#app:not(.hidden)');
  await p3.fill('#pullupsNew', '6'); await p3.press('#pullupsNew', 'Enter');
  await p3.waitForSelector('#checklist [data-ex=pullups] .cell.filled');
  await p3.clock.runFor(2 * 60 * 1000);
  ok((await p3.textContent('#todayLabel')).startsWith('2 марта') && (await p3.$$('#checklist .cell.filled')).length === 0 && (await p3.$$('#checklist .cell.empty')).length === 4, 'after midnight: empty board, one empty cell each');
  ok(await p3.evaluate(() => FT.Store.view('2027-03-01').sets.pullups.cells[0].reps === 6), 'previous day kept in history');
  await browser.close();
} finally { srv.kill(); }
console.log(process.exitCode ? 'BOARD E2E FAILED' : 'BOARD E2E PASSED');
