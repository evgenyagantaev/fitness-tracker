// Runs the Android bundle (android/www) in Chrome with a mocked Capacitor bridge,
// served at http://localhost/ (a Capacitor-like origin) to exercise the native code path + CORS.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WWW, shot } from './paths.mjs';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8090/fitness/';
const TOKEN = 'localtest-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.md': 'text/plain' };

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
await ctx.route('http://localhost/**', (route) => {
  let p = new URL(route.request().url()).pathname; if (p.endsWith('/')) p += 'index.html';
  if (p === '/vendor/capacitor.js' || p === '/vendor/bluetooth-le.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  const f = join(WWW, p);
  if (!existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, contentType: types[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
await ctx.addInitScript(() => {
  const calls = (window.__ln = { scheduled: [], cancelled: 0, channel: null });
  let pending = [];
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { LocalNotifications: {
    async createChannel(c) { calls.channel = c; },
    async checkPermissions() { return { display: 'granted' }; },
    async requestPermissions() { return { display: 'granted' }; },
    async getPending() { return { notifications: pending.map((n) => ({ id: n.id })) }; },
    async cancel({ notifications }) { calls.cancelled += notifications.length; const ids = new Set(notifications.map((n) => n.id)); pending = pending.filter((n) => !ids.has(n.id)); },
    async schedule({ notifications }) { pending = pending.concat(notifications); calls.scheduled = pending.slice(); return { notifications: notifications.map((n) => ({ id: n.id })) }; },
  } } };
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure() && r.failure().errorText));
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto('http://localhost/');
await page.waitForSelector('#app:not(.hidden)');
ok(await page.evaluate(() => document.body.classList.contains('native')), 'native mode detected, no login screen');
await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.includes('без сервера'));
ok(true, 'works offline without server: "' + await page.textContent('#syncStatus') + '"');
await page.click('label[for=pullups1]');
await page.waitForTimeout(1500);
const n = await page.evaluate(() => window.__ln);
ok(n.channel && n.channel.id === 'reminders', 'notification channel created');
const hours = n.scheduled.map((x) => new Date(x.schedule.at).getHours());
ok(n.scheduled.length > 100 && hours.every((h) => h >= 9 && h <= 21), `${n.scheduled.length} reminders scheduled for 14 days, hours 9–21`);
ok(new Set(n.scheduled.map((x) => x.id)).size === n.scheduled.length, 'reminder ids unique');
ok(n.scheduled.every((x) => x.body === 'Помни о фитнесе' && x.isExactNotification === false && x.smallIcon === 'ic_stat_notify'), 'reminder payload ok (inexact, custom icon)');

// connect to server in settings
await page.click('.tabs button[data-tab=settings]');
ok(await page.isVisible('#setUrl'), 'server URL + token fields visible in native settings');
await page.fill('#setUrl', SERVER); await page.fill('#setToken', TOKEN);
await page.click('#saveServer');
await page.waitForFunction(() => document.querySelector('#serverMsg').textContent.includes('Подключено'), null, { timeout: 10000 });
await page.waitForFunction(() => JSON.parse(localStorage['ft.dirty'] || '[]').length === 0 && Object.keys(JSON.parse(localStorage['ft.days'])).length > 100, null, { timeout: 10000 });
ok(true, 'connected via CORS from http://localhost, history pulled from server');
const today = new Date().toLocaleDateString('sv-SE');
const srv = await fetch(SERVER + 'api/days/' + today, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
ok(srv.sets.pullups.done[0] === true, 'offline tick from the phone reached the server');

// change reminder settings: every 3h from 10 to 19
await page.fill('#notifStart', '10'); await page.fill('#notifEnd', '19'); await page.fill('#notifEvery', '3');
await page.click('#saveNotif'); await page.waitForTimeout(1200);
const hrs = [...new Set((await page.evaluate(() => window.__ln.scheduled)).map((x) => new Date(x.schedule.at).getHours()))].sort((a, b) => a - b);
ok(JSON.stringify(hrs) === JSON.stringify([10, 13, 16, 19]), 'configurable schedule -> hours ' + hrs.join(','));
await page.screenshot({ path: shot('screenshot-android-settings.png'), fullPage: true });

// complete the whole day -> no reminders left for today
await page.click('.tabs button[data-tab=today]');
for (const id of ['pullups', 'pushups']) for (let i = 1; i <= 5; i++) if (!(await page.isChecked(`#${id}${i}`))) await page.click(`label[for=${id}${i}]`);
if (!(await page.isChecked('#runCheck'))) await page.click('label[for=runCheck]');
if ((await page.$('#walkCheck')) && !(await page.isChecked('#walkCheck'))) await page.click('label[for=walkCheck]');   // v1.5: «Ходьба» on the board
await page.waitForTimeout(1500);
const left = (await page.evaluate(() => window.__ln.scheduled)).filter((x) => new Date(x.schedule.at).toLocaleDateString('sv-SE') === today);
ok(left.length === 0 && (await page.textContent('#progressLabel')).includes('всё выполнено'), 'day complete -> no more reminders today');
await page.screenshot({ path: shot('screenshot-android-today.png') });
await browser.close();
console.log(process.exitCode ? 'NATIVE MOCK FAILED' : 'NATIVE MOCK PASSED');
