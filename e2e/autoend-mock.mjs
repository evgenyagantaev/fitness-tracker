// v1.7: forgotten «Стоп» on a beltless run: the service closes the workout by itself, the app builds the record from its snapshot
// (cut at the detected end, raw tail kept) on the next open. Mocked native WorkoutRecorder.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WWW, shot } from './paths.mjs';
const SERVER = 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
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
      const bpmAt = (s, abs) => (s.startedAt && abs >= s.startedAt && (!s.workoutEnd || abs < s.workoutEnd)) ? 160
        : (s.workoutEnd && abs >= s.workoutEnd) ? Math.max(95, 160 - 8 * (abs - s.workoutEnd) / 1000) : 72;
      const sessArr = (s) => { const out = []; for (let t = 1; s.sessionStart + t * 1000 <= Date.now(); t++) out.push([t, Math.round(bpmAt(s, s.sessionStart + t * 1000))]); return out; };
      // RR: one beat per second-sample, ±4% variability
      const rrArr = (s) => sessArr(s).map((p, i) => [p[0] * 1000, Math.round(60000 / p[1] * (1 + 0.04 * Math.sin(i * 1.3)))]);
      // ECG at 10× speed: a 30-s record finishes in 3 s
      const ecgN = () => { const e = JSON.parse(sessionStorage.getItem('ecg') || 'null'); return e ? Math.min(e.target, Math.floor((Date.now() - e.t0) * 1.3)) : 0; };
      const ecgSample = (i) => { const k = i % 85; return Math.round(1400 * Math.exp(-((k - 10) ** 2) / 2) + 250 * Math.exp(-((k - 40) ** 2) / 40) + 200 * Math.sin(i / 130)); };
      const snap = (q = {}) => { const s = S(); if (!s) return { running: false, orphan: false };
        const now = Date.now(), wa = !!s.workoutActive, n = wa ? Math.floor((now - s.startedAt) / 1000) : 0;
        const samples = []; for (let i = 1; i <= n; i++) samples.push([i, 160]);
        const se = sessArr(s);
        return { running: true, phase: s.phase, workoutActive: wa, workoutId: s.workoutId, workoutEnd: s.workoutEnd || 0, sessionStart: s.sessionStart,
          postMin: s.postMin || 90, sessWorkouts: s.sessWorkouts, startedAt: s.startedAt, type: s.type, stride: s.stride, deviceId: s.deviceId, deviceName: s.deviceName,
          steps: n * 3, bpm: Math.round(bpmAt(s, now)), bpmAt: now, hrStatus: s.deviceId ? 'connected' : 'none',
          samples: samples.slice(q.since || 0), since: Math.min(q.since || 0, samples.length) === (q.since || 0) ? (q.since || 0) : samples.length,
          stepSeries: Array.from({ length: n }, (_, i) => [i + 1, (i + 1) * 3]).slice(q.sinceSteps || 0), sinceSteps: q.sinceSteps || 0,
          track: [], sinceTrack: q.sinceTrack || 0, gps: false, gpsStatus: 'off', gpsDist: 0,
          sess: se.slice(q.sinceSess || 0), sinceSess: q.sinceSess || 0, sessCount: se.length,
          rr: rrArr(s).slice(q.sinceRr || 0), sinceRr: q.sinceRr || 0, ecgCapable: true }; };
      const finish = () => { const s = S(); const f = { sessionStart: s.sessionStart, sessionEnd: Date.now(), reason: 'user', workouts: s.sessWorkouts, samples: sessArr(s), rr: rrArr(s) };
        const all = JSON.parse(sessionStorage.getItem('finished') || '[]'); all.push(f); sessionStorage.setItem('finished', JSON.stringify(all)); sessionStorage.removeItem('svc'); };
      return {
        async monitor(o) { log('monitor'); if (!S()) put({ running: true, phase: 'pre', sessionStart: Date.now(), deviceId: o.deviceId, deviceName: o.deviceName, sessWorkouts: [], postMin: o.postMin }); },
        async start(o) { log('start'); window.__startOpts = o; if (o.resume) return { started: true };
          const s = S() || { running: true, sessionStart: o.startedAt, deviceId: o.deviceId, deviceName: o.deviceName, sessWorkouts: [] };
          put({ ...s, phase: 'workout', workoutActive: true, startedAt: o.startedAt, workoutId: o.workoutId, type: o.type, stride: o.stride, workoutEnd: 0, postMin: o.postMin });
          return { started: true, steps: true, location: true }; },
        async getState(o) { window.__lastGet = o; return snap(o || {}); },
        async setDevice(o) { log('setDevice'); const s = S(); if (s) put({ ...s, ...o }); },
        async stop() { log('stop'); const r = snap({}); const s = S(); const now = Date.now();
          s.sessWorkouts.push({ id: s.workoutId, startedAt: s.startedAt, endedAt: now });
          put({ ...s, phase: 'post', workoutActive: false, workoutEnd: now });
          r.workoutEndedAt = now; r.sessionContinues = !!s.deviceId; r.sessWorkouts = s.sessWorkouts; if (!s.deviceId) finish(); return r; },
        async endSession() { log('endSession'); if (S()) finish(); },
        async takeFinishedSessions() { const all = JSON.parse(sessionStorage.getItem('finished') || '[]'); sessionStorage.removeItem('finished'); window.__taken = (window.__taken || 0) + all.length; return { sessions: all }; },
        async startEcg(o) { log('startEcg'); if (!S()) throw new Error('сначала подключи пояс'); sessionStorage.setItem('ecg', JSON.stringify({ t0: Date.now(), target: o.seconds * 130, sec: o.seconds })); },
        async getEcg(o) { const e = JSON.parse(sessionStorage.getItem('ecg') || 'null'); if (!e) return { status: 'idle', count: 0, samples: [], since: o.since };
          const n = ecgN(); if (n >= e.target) { this._saveEcg(n); return { status: 'idle', count: n, samples: [], since: o.since }; }
          const sm = []; for (let i = o.since; i < n; i++) sm.push(ecgSample(i)); return { status: 'recording', count: n, target: e.target, samples: sm, since: o.since, capable: true }; },
        _saveEcg(n) { const e = JSON.parse(sessionStorage.getItem('ecg')); sessionStorage.removeItem('ecg');
          let bin = ''; for (let i = 0; i < n; i++) { const v = ecgSample(i) & 0xffff; bin += String.fromCharCode(v & 255, v >> 8); }
          const recs = JSON.parse(sessionStorage.getItem('ecgrecs') || '[]');
          recs.push({ id: 'e' + e.t0.toString(36), started_at: e.t0, fs: 130, n, duration_s: Math.round(n / 1.3) / 100, device: 'Polar H10 MOCK', samples_b64: btoa(bin), phase: S() ? S().phase : null });
          sessionStorage.setItem('ecgrecs', JSON.stringify(recs)); },
        async stopEcg() { log('stopEcg'); if (sessionStorage.getItem('ecg')) this._saveEcg(ecgN()); },
        async takeEcgRecords() { const r = JSON.parse(sessionStorage.getItem('ecgrecs') || '[]'); sessionStorage.removeItem('ecgrecs'); return { records: r }; },
        async addListener(ev, cb) { (window.__wrL = window.__wrL || {})[ev] = cb; return { remove: async () => {} }; },
        // the strap is taken off after the run: the service ends the session by itself, trims the no-data tail and tells the app
        __strapOff(offAgoS) { const s = S(); const end = Date.now() - offAgoS * 1000;
          const f = { sessionStart: s.sessionStart, sessionEnd: end, reason: 'strap-off', workouts: s.sessWorkouts,
            samples: sessArr(s).filter((p) => s.sessionStart + p[0] * 1000 <= end), rr: rrArr(s).filter((p) => s.sessionStart + p[0] <= end) };
          const all = JSON.parse(sessionStorage.getItem('finished') || '[]'); all.push(f); sessionStorage.setItem('finished', JSON.stringify(all)); sessionStorage.removeItem('svc');
          window.__wrL && window.__wrL.sessionFinished && window.__wrL.sessionFinished({}); },
        async takeAutoEnded() { const all = JSON.parse(sessionStorage.getItem('autoended') || '[]'); sessionStorage.removeItem('autoended'); window.__takenAuto = (window.__takenAuto || 0) + all.length; return { workouts: all }; },
        // the service closed the run 25 min after it really ended (beltless: the session ends with it)
        __autoEnd() { const s = S(); const start = Date.now() - 40 * 60000, endSec = 15 * 60;
          const ss = [], tail = [], tr = []; let st = 0;
          for (let t = 15; t <= 40 * 60; t += 10) { const cad = t < 90 ? 100 : t <= endSec ? 165 : 0; st += cad / 6; (t <= endSec + 20 ? ss : tail).push([t, Math.round(st)]); }
          let lat = 55; for (let t = 0; t <= endSec + 20; t += 2) { lat += (t < 90 ? 1.3 : t <= endSec ? 2.8 : 0) * 2 / 111195; tr.push([t, lat, 37, 6]); }
          const o = { workoutId: s.workoutId, startedAt: start, type: 'run', stride: 0.9, deviceName: null, samples: [], stepSeries: ss, track: tr, steps: ss[ss.length - 1][1],
            autoEnd: { reason: 'auto', endedAt: start + (endSec + 20) * 1000, lastRunSec: endSec, detectedAt: Date.now() }, tail: { step_series: tail, track: [] } };
          sessionStorage.setItem('autoended', JSON.stringify([o])); sessionStorage.removeItem('svc');
          window.__wrL && window.__wrL.sessionFinished && window.__wrL.sessionFinished({}); },
        async batteryStatus() { return { ignoringOptimizations: true, miui: false }; },
        async requestIgnoreBatteryOptimizations() {}, async openAutostartSettings() {}, async openAppDetails() {},
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
page.on('response', async (r) => { if (r.status() === 422) console.error('422', (await r.text()).slice(0, 400)); });
await page.goto('http://localhost/');
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.click('#wkStart');
await page.waitForTimeout(3000);
const wid = await page.evaluate(() => window.__startOpts.workoutId);
ok(!!wid && await page.evaluate(() => !window.__startOpts.deviceId), 'beltless run started (no strap)');
// the user forgot «Стоп»: the service finishes by itself, the app is open
await page.evaluate(() => window.__wr_obj ? 0 : 0);
await page.evaluate(() => window.Capacitor.Plugins.WorkoutRecorder.__autoEnd());
await page.waitForFunction(() => document.querySelector('#wkMsg').textContent.includes('закрыта автоматически'), null, { timeout: 8000 });
ok(true, 'message: ' + (await page.textContent('#wkMsg')).slice(0, 150));
ok(await page.isHidden('#wkStop'), 'recording UI is closed (no active workout)');
ok(await page.locator('.wk-item').count() === 1, 'the workout is in the list');
// synced to the server with the segmentation, the auto_end marker and the raw tail
let w = null;
for (let i = 0; i < 20 && !(w && w.auto_end); i++) { await page.waitForTimeout(500); w = await fetch(SERVER + 'api/workouts/' + wid, { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.ok ? r.json() : null); }
ok(w && w.auto_end && w.auto_end.reason === 'auto', 'server has auto_end: ' + JSON.stringify(w && w.auto_end));
ok(w && w.duration_s === 15 * 60 + 20, 'duration cut at the detected end (+20 s): ' + (w && w.duration_s));
ok(w && w.tail && w.tail.step_series.length > 50, 'raw tail kept: ' + (w && w.tail && w.tail.step_series.length) + ' step points');
ok(w && w.seg && w.seg.src === 'auto' && Math.abs(w.seg.t0 - 90) < 20 && Math.abs(w.seg.t1 - 900) < 25, 'run segmented: ' + JSON.stringify(w && w.seg && [w.seg.t0, w.seg.t1, w.seg.src]));
ok(w && w.beltless === true, 'marked beltless');
ok(w && w.distance_m > 1800 && w.distance_m < 2500, 'distance over the run: ' + (w && w.distance_m));
await page.click('.wk-item');
await page.waitForTimeout(800);
const det = await page.textContent('#wkDetailStats');
ok(/без пояса/.test(det) && !/Пульс средний/.test(det), 'detail: beltless, no HR rows');
ok(await page.isVisible('#wkSegCtl'), 'boundary controls shown');
await page.screenshot({ path: shot('screenshot-autoend-beltless.png') });
// the same state read on the next app launch: nothing is collected twice
await page.reload(); await page.waitForSelector('#app:not(.hidden)');
ok(await page.locator('.wk-item').count() === 1, 'no duplicate after reload');
await browser.close();
console.log(process.exitCode ? 'FAILED' : 'ALL OK');
