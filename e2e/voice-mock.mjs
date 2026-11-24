// v1.8: voice announcements settings panel against a mocked native WorkoutRecorder (toggles are saved, the test button speaks, status shows the voice).
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
  const calls = window.__voice = { set: [], test: 0, info: 0 };
  const cfg = { enabled: true, events: true, hr: true, summary: true, distance: true };
  const info = () => ({ status: 'ok', engine: 'com.google.android.tts', voice: 'ru-ru-x-dfc-local', gender: 'female', voices: ['ru-ru-x-dfc-local'], ...cfg });
  localStorage.setItem('ft.config', JSON.stringify({ serverUrl: url, token, notif: { enabled: false, start: 9, end: 21, every: 1 } }));
  const WR = { async voiceInfo() { calls.info++; return info(); }, async setVoice(o) { calls.set.push(o); Object.assign(cfg, o); return info(); },
    async voiceTest() { calls.test++; return info(); }, async announceFinish(o) { calls.fin = o; return {}; } };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    LocalNotifications: { async createChannel() {}, async getPending() { return { notifications: [] }; }, async cancel() {}, async checkPermissions() { return { display: 'granted' }; }, async requestPermissions() { return { display: 'granted' }; }, async schedule() {} },
    KeepAwake: { async keepAwake() {}, async allowSleep() {} },
    WorkoutRecorder: new Proxy(WR, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k !== 'then' ? async () => ({ running: false }) : undefined)) }),
  } };
}, { url: SERVER, token: TOKEN });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto('http://localhost/');
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=settings]');
await page.waitForSelector('#voicePanel', { state: 'visible' });
await page.waitForFunction(() => document.getElementById('voiceInfo').textContent.includes('ru-ru-x-dfc-local'));
const t = await page.textContent('#voiceInfo');
ok(/женский/.test(t) && /google/.test(t), 'status shows engine and the female voice: ' + t);
ok(await page.$eval('#voiceOn', (e) => e.checked) && await page.$eval('#voiceHr', (e) => e.checked), 'all on by default');
await page.click('#voiceHr');
let v = await page.evaluate(() => window.__voice);
ok(v.set.length === 1 && v.set[0].hr === false && v.set[0].events === true && v.set[0].enabled === true, 'category toggle saved: ' + JSON.stringify(v.set[0]));
await page.click('#voiceOn');
ok(await page.$eval('#voiceCats', (e) => e.classList.contains('disabled')), 'categories dimmed when voice is off');
v = await page.evaluate(() => window.__voice);
ok(v.set[1].enabled === false, 'master switch saved');
await page.click('#voiceTest');
v = await page.evaluate(() => window.__voice);
ok(v.test === 1, 'test button asks the service to speak');
await page.locator('#voicePanel').screenshot({ path: shot('screenshot-voice-settings.png') });
await browser.close();
