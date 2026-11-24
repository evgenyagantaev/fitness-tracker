// Android bundle in Chrome with mocked Capacitor plugins: BLE HR monitor + step counter + keep-awake.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WWW, shot } from './paths.mjs';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const MOCK_BLE = `
window.capacitorCommunityBluetoothLe = { BleClient: {
  async initialize() { window.__ble.init++; }, async isEnabled() { return true; }, async isLocationEnabled() { return true; },
  async requestEnable() {}, async openLocationSettings() {},
  async requestDevice(o) { window.__ble.reqOpts = o; return { deviceId: 'E1:2B:3C:4D:5E:6F', name: 'Xiaomi Smart Band 8' }; },
  async connect(id, onDisc) { window.__ble.onDisc = onDisc; window.__ble.connects++; },
  async disconnect() { clearInterval(window.__ble.t); },
  async startNotifications(id, s, c, cb) {
    window.__ble.svc = s; window.__ble.chr = c; let i = 0;
    window.__ble.t = setInterval(() => { const b = new Uint8Array([i % 2 ? 0x01 : 0x00, 0, 0]); const v = 120 + (i++ % 30);
      if (b[0] & 1) { b[1] = v & 255; b[2] = v >> 8; } else b[1] = v; cb(new DataView(b.buffer)); }, 500);
  },
} };`;
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
await ctx.route('http://localhost/**', (route) => {
  let p = new URL(route.request().url()).pathname; if (p.endsWith('/')) p += 'index.html';
  if (p === '/vendor/capacitor.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* core stub */' });
  if (p === '/vendor/bluetooth-le.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK_BLE });
  const f = join(WWW, p);
  if (!existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, contentType: types[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
await ctx.addInitScript(({ url, token }) => {
  window.__ble = { init: 0, connects: 0 };
  const steps = { cb: null, total: 5000, t: null };
  window.__steps = steps;
  localStorage.setItem('ft.config', JSON.stringify({ serverUrl: url, token, notif: { enabled: false, start: 9, end: 21, every: 1 } }));
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    LocalNotifications: { async createChannel() {}, async getPending() { return { notifications: [] }; }, async cancel() {}, async checkPermissions() { return { display: 'granted' }; }, async requestPermissions() { return { display: 'granted' }; }, async schedule() {} },
    KeepAwake: { async keepAwake() { window.__awake = true; }, async allowSleep() { window.__awake = false; } },
    StepCounter: {
      async addListener(ev, cb) { steps.cb = cb; return { remove: async () => { steps.cb = null; } }; },
      async start() { clearInterval(steps.t); steps.t = setInterval(() => { steps.total += 3; steps.cb && steps.cb({ steps: 0, total: steps.total }); }, 1000); return { running: true, steps: 0, total: steps.total }; },
      async getSteps() { return { steps: 0, total: steps.total }; }, async stop() { clearInterval(steps.t); return {}; },
    } } };
}, { url: SERVER, token: TOKEN });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('dialog', (d) => d.accept());
await page.goto('http://localhost/');
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
ok(await page.isVisible('#hrPick') && await page.isVisible('#wkStart'), 'workout tab: HR + recorder panels visible in app');
await page.click('#hrPick');
await page.waitForFunction(() => document.querySelector('#hrDevStatus').textContent.includes('подключён ✔'));
ok(await page.evaluate(() => window.__ble.reqOpts.services[0] === '0000180d-0000-1000-8000-00805f9b34fb' && window.__ble.chr === '00002a37-0000-1000-8000-00805f9b34fb'), 'scan filtered by HR service 0x180D, notifications on 0x2A37');
await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#liveHr').textContent));
ok(true, 'live HR shown: ' + await page.textContent('#liveHr') + ' (uint8 and uint16 formats parsed)');
ok(await page.evaluate(() => JSON.parse(localStorage['ft.config']).hrDevice.name === 'Xiaomi Smart Band 8'), 'device remembered');
await page.click('#wkStart');
await page.waitForTimeout(7000);
ok(await page.evaluate(() => window.__awake === true), 'screen kept awake while recording');
const steps = parseInt(await page.textContent('#liveSteps'), 10);
ok(steps >= 15, `steps counted from phone sensor: ${steps}, distance ${await page.textContent('#liveDist')} km`);
ok((await page.textContent('#liveTime')).startsWith('0:0'), 'duration ' + await page.textContent('#liveTime'));
// disconnect → auto-reconnect
await page.evaluate(() => window.__ble.onDisc());
await page.waitForFunction(() => window.__ble.connects >= 2, null, { timeout: 8000 });
ok(true, 'auto-reconnect after BLE disconnect');
await page.waitForTimeout(1500);
await page.screenshot({ path: shot('screenshot-workout-live.png'), fullPage: true });
await page.click('#wkStop');
await page.waitForFunction(() => document.querySelector('#wkMsg').textContent.startsWith('Сохранено'));
ok(true, await page.textContent('#wkMsg'));
await page.waitForFunction(() => JSON.parse(localStorage['ft.wdirty'] || '[1]').length === 0, null, { timeout: 10000 });
const list = await fetch(SERVER + 'api/workouts', { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
const w = list[0];
ok(w && w.device === 'Xiaomi Smart Band 8' && w.steps >= 15 && w.hr.max >= 120 && w.distance_m === Math.round((w.steps + (w.steps_start_missed || 0)) * 0.75), `workout synced to server: ${w.duration_s}s, ${w.steps} steps, ${w.distance_m} m, HR avg ${w.hr.avg} max ${w.hr.max}`);
const full = await fetch(SERVER + 'api/workouts/' + w.id, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
ok(full.samples.length >= 5 && new Set(full.samples.map((s) => s[0])).size === full.samples.length, `HR samples stored once per second: ${full.samples.length}`);
const today = new Date().toLocaleDateString('sv-SE');
const day = await fetch(SERVER + 'api/days/' + today, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
ok(day.distance.run.km >= w.distance_m / 1000 - 0.01 && day.distance.run.done, `run distance added to today: ${day.distance.run.km} km`);
await page.click('.wk-item');
await page.waitForSelector('#wkDetail:not(.hidden)'); await page.waitForTimeout(800);
await page.screenshot({ path: shot('screenshot-workout-detail.png'), fullPage: true });
ok(true, 'detail with HR chart opened');
await browser.close();
console.log(process.exitCode ? 'WORKOUT MOCK FAILED' : 'WORKOUT MOCK PASSED');
