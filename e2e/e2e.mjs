// End-to-end check of the web UI behind nginx at /fitness/ (local run).
import { chromium } from 'playwright-core';
import { shot } from './paths.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:8090/fitness/';
const TOKEN = process.env.TOKEN || 'localtest-token';
const API = (p) => fetch(BASE + 'api/' + p, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const today = new Date().toLocaleDateString('sv-SE');

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });

await page.goto(BASE);
ok(await page.isVisible('#login'), 'login screen shown without token');
await page.fill('#loginToken', 'wrong');
await page.click('#loginBtn');
await page.waitForFunction(() => document.querySelector('#loginError').textContent.length > 0);
ok((await page.textContent('#loginError')).includes('Неверный'), 'wrong token rejected');
await page.fill('#loginToken', TOKEN);
await page.click('#loginBtn');
await page.waitForSelector('#app:not(.hidden)');
ok((await page.$$('#checklist .cell.empty')).length === 4 && (await page.$$('#checklist .cell.filled')).length === 0, 'v1.11 board: one empty cell each for pull-ups, push-ups, run, walk');

// tick some boxes and enter km -> synced to server
for (const [id, n] of [['pullups', 3], ['pullups', 4], ['pushups', 15]]) { await page.fill('#' + id + 'New', String(n)); await page.press('#' + id + 'New', 'Enter'); await page.waitForTimeout(150); }
await page.fill('#runKm', '4.2'); await page.press('#runKm', 'Tab');
await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('Синхронизировано') && JSON.parse(localStorage['ft.dirty']).length === 0, null, { timeout: 10000 });
let d = await API('days/' + today);
ok(d.sets.pullups.cells.length === 2 && d.sets.pushups.cells[0].reps === 15 && d.distance.run.km === 4.2 && d.distance.run.done, 'today record synced to server');

// offline edits are kept locally and pushed on reconnect
await ctx.setOffline(true);
await page.fill('#pushupsNew', '12'); await page.press('#pushupsNew', 'Enter');
await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.includes('не отправлено: 1'), null, { timeout: 10000 });
ok(true, 'offline edit kept locally (pending 1)');
d = await API('days/' + today);
ok(d.sets.pushups.cells.length === 1, 'server not yet updated while offline');
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.waitForFunction(() => JSON.parse(localStorage['ft.dirty']).length === 0, null, { timeout: 10000 });
d = await API('days/' + today);
ok(d.sets.pushups.cells.length === 2, 'offline edit pushed after reconnect');

// a change made elsewhere (e.g. phone) shows up after sync
const phone = { sets: { pullups: { cells: [{ reps: 3 }, { reps: 4 }, { reps: 9 }] }, pushups: d.sets.pushups }, distance: d.distance, updated_at: Date.now() + 1000 };
await fetch(BASE + 'api/days/' + today, { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(phone) });
await page.click('#syncNow').catch(() => {}); // hidden on today tab; use API instead
await page.evaluate(() => FT.Sync.run());
await page.waitForFunction(() => document.querySelectorAll('#checklist [data-ex=pullups] .cell.filled').length === 3, null, { timeout: 5000 });
ok(true, 'remote change pulled into the open page');

// reload keeps state (localStorage) and token
await page.reload();
await page.waitForSelector('#app:not(.hidden)');
ok((await page.$$('#checklist [data-ex=pullups] .cell.filled')).length === 3 && (await page.inputValue('#runKm')) === '4.2', 'state persists across reload');

// stats tab
await page.click('.tabs button[data-tab=stats]');
await page.waitForFunction(() => document.querySelectorAll('#heatmap i').length > 150 && document.querySelectorAll('#streakCards .card').length === 7, null, { timeout: 10000 });
await page.waitForTimeout(800);
ok(true, 'stats: heatmap + streak cards rendered');
await page.screenshot({ path: shot('screenshot.png'), fullPage: true });
await page.click('#periodSeg button[data-period=month]');
await page.waitForTimeout(600);
await page.screenshot({ path: shot('screenshot-months.png'), fullPage: false });

// settings: exercise editor round-trip
await page.click('.tabs button[data-tab=settings]');
ok((await page.$$('#exEditor .ex-row')).length === 4, 'settings: exercise editor lists 4 exercises (with walk)');
ok(!(await page.isVisible('#setUrl')), 'server URL field hidden on web (native only)');

// mobile viewport of today tab
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const mp = await m.newPage();
await mp.goto(BASE); await mp.evaluate((t) => localStorage.setItem('ft.config', JSON.stringify({ token: t })), TOKEN); await mp.reload();
await mp.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('Синхронизировано'));
await mp.screenshot({ path: shot('screenshot-mobile.png') });

// midnight rollover with a fake clock
const c3 = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const p3 = await c3.newPage();
await p3.clock.install({ time: new Date('2027-03-01T23:59:00+03:00') });
await p3.goto(BASE); await p3.evaluate((t) => localStorage.setItem('ft.config', JSON.stringify({ token: t })), TOKEN); await p3.reload();
await p3.waitForSelector('#app:not(.hidden)');
await p3.fill('#pullupsNew', '6'); await p3.press('#pullupsNew', 'Enter');
const before = await p3.textContent('#todayLabel');
await p3.clock.runFor(2 * 60 * 1000);
const after = await p3.textContent('#todayLabel');
ok(before.startsWith('1 марта') && after.startsWith('2 марта') && (await p3.$$('#checklist .cell.filled')).length === 0, `midnight rollover: "${before}" -> "${after}", checklist cleared`);
ok(await p3.evaluate(() => FT.Store.view('2027-03-01').sets.pullups.cells[0].reps === 6), 'previous day kept in history');

await browser.close();
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
