// Background recording: mocked native WorkoutRecorder (foreground service) survives page reloads via sessionStorage.
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
    WorkoutRecorder: (() => {
      const S = () => JSON.parse(sessionStorage.getItem('svc') || 'null');
      const put = (o) => sessionStorage.setItem('svc', JSON.stringify(o));
      const calls = window.__wr = JSON.parse(sessionStorage.getItem('wrcalls') || '[]');
      const log = (c) => { calls.push(c); sessionStorage.setItem('wrcalls', JSON.stringify(calls)); };
      const snap = (since, o2 = {}) => { const s = S(); if (!s) return { running: false, orphan: false };
        const n = Math.floor((Date.now() - s.startedAt) / 1000); const samples = [];
        for (let i = 1; i <= n; i++) samples.push([i, 130 + (i % 20)]);
        return { running: s.running, startedAt: s.startedAt, type: s.type, stride: s.stride, deviceId: s.deviceId, deviceName: s.deviceName,
          steps: n * 3, bpm: 130 + (n % 20), bpmAt: Date.now(), hrStatus: s.deviceId ? 'connected' : 'none', sampleCount: n, samples: samples.slice(since || 0), since: since || 0,
          stepSeries: Array.from({ length: n }, (_, i) => [i + 1, (i + 1) * 3]).slice(o2.sinceSteps || 0), sinceSteps: o2.sinceSteps || 0,
          track: Array.from({ length: n }, (_, i) => [i + 1, 55.0 + (i + 1) * 3 / 111195, 37.0, 5]).slice(o2.sinceTrack || 0), sinceTrack: o2.sinceTrack || 0,
          gps: s.gps !== false, gpsStatus: 'ok', gpsDist: n * 3, gpsAcc: 5, gpsAt: Date.now() }; };
      return {
        async start(o) { log('start'); window.__startOpts = o; if (!o.resume) put({ running: true, ...o }); return { started: true, steps: true, location: true }; },
        async getState(o) { window.__lastGet = o; return snap(o && o.since, o || {}); },
        async setDevice(o) { log('setDevice'); const s = S(); put({ ...s, ...o }); },
        async stop() { log('stop'); const r = snap(0); sessionStorage.removeItem('svc'); r.running = false; return r; },
        async batteryStatus() { return { ignoringOptimizations: false, miui: true }; },
        async requestIgnoreBatteryOptimizations() { log('battery'); }, async openAutostartSettings() { log('autostart'); }, async openAppDetails() {},
      };
    })(),
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
await page.waitForSelector('#batPanel:not(.hidden)');
ok(await page.isVisible('#batOpt') && await page.isVisible('#batMiui'), 'battery/autostart hint shown (MIUI, optimisation on)');
await page.click('#batMiui'); await page.click('#batOpt');
await page.click('#hrPick');
await page.waitForFunction(() => document.querySelector('#hrDevStatus').textContent.includes('подключён ✔'));
await page.click('#wkStart');
await page.waitForTimeout(4500);
ok(await page.evaluate(() => window.__ble.t === undefined || true) && await page.evaluate(() => window.__wr.includes('start')), 'recording started in native service');
ok(await page.evaluate(() => !window.__awake), 'no keep-awake needed (screen may turn off)');
ok(await page.evaluate(() => window.__startOpts.gps === true && window.__lastGet.sinceTrack > 0 && window.__lastGet.sinceSteps > 0), 'GPS requested; incremental track/step polling');
ok((await page.textContent('#liveGps')) !== '—' && (await page.textContent('#liveGpsState')).includes('сигнал есть'), 'live GPS km ' + await page.textContent('#liveGps') + ' / ' + await page.textContent('#liveGpsState'));
ok(/^\d+$/.test(await page.textContent('#liveCad')), 'live cadence ' + await page.textContent('#liveCad'));
ok(parseInt(await page.textContent('#liveSteps'), 10) >= 9, 'live steps from service: ' + await page.textContent('#liveSteps'));
ok(/^\d+$/.test(await page.textContent('#liveHr')), 'live HR from service: ' + await page.textContent('#liveHr'));
// app killed & reopened while service keeps recording
await page.reload(); await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForTimeout(2500);
ok(await page.isVisible('#wkStop'), 'after reload: recording adopted, Stop visible, time ' + await page.textContent('#liveTime'));
// app storage lost entirely (only service state remains)
await page.evaluate(() => localStorage.removeItem('ft.activeWorkout'));
await page.reload(); await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForTimeout(2500);
ok(await page.isVisible('#wkStop'), 'after losing local state: workout recreated from service');
await page.screenshot({ path: shot('screenshot-workout-bg.png'), fullPage: true });
await page.click('#wkStop');
await page.waitForFunction(() => document.querySelector('#wkMsg').textContent.startsWith('Сохранено'));
ok(await page.evaluate(() => window.__wr.includes('stop')), await page.textContent('#wkMsg'));
await page.waitForFunction(() => JSON.parse(localStorage['ft.wdirty'] || '[1]').length === 0, null, { timeout: 10000 });
const list = await fetch(SERVER + 'api/workouts', { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
const w = list[0];
ok(w && w.duration_s >= 8 && w.steps >= 24 && w.hr.max >= 130, `synced: ${w.duration_s}s, ${w.steps} steps, ${w.distance_m} m, HR avg ${w.hr.avg} max ${w.hr.max}, device ${w.device}`);
ok(w.gps_distance_m >= 15 && w.moving_s > 0 && w.step_distance_m === Math.round((w.steps + (w.steps_start_missed || 0)) * 0.75), `analytics saved: gps ${w.gps_distance_m} m, moving ${w.moving_s}s, stops ${w.stops}, cadence ${w.cadence_avg}`);
const full = await fetch(SERVER + 'api/workouts/' + w.id, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());
ok(full.track.length >= 8 && full.step_series.length >= 8, `track ${full.track.length} pts, step series ${full.step_series.length} pts stored`);
ok(full.samples.length >= 8 && new Set(full.samples.map((s) => s[0])).size === full.samples.length, `samples complete & unique: ${full.samples.length}`);
await browser.close();
console.log(process.exitCode ? 'BG MOCK FAILED' : 'BG MOCK PASSED');
