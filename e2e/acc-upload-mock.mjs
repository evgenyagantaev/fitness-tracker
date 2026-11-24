// Native upload path of raw ACC (dynamics.js) with a mocked WorkoutRecorder: chunked deflate → server → analysis → delete.
// v1.6.1: the mock emulates Capacitor's argument typing (JSON round trip; PluginCall.getLong() returns the default for a
// JS number that fits in int, which is what v1.6 used → BUGGY=1 reproduces the 24.11 corruption and must NOT delete),
// returns crc32/len/offset like the new native code, and the server's files are compared byte-for-byte with the phone's.
// Env: ACC_DIR = the local server's acc folder (…/localrun/<db dir>/acc).
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { WWW, SERVER_DIR } from './paths.mjs';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const BUGGY = process.env.BUGGY === '1', ACC_DIR = process.env.ACC_DIR;
const AID = BUGGY ? 'awmockbug1' : 'awmockacc1';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
// synthetic 3-min run from the python generator
execSync(`cd ${SERVER_DIR} && python3 -c "
import sys; sys.path.insert(0,'tests'); sys.path.insert(0,'.')
from test_acc import synth
d,f,n=synth(dur=600)
open('/tmp/accm.bin','wb').write(d[:n*6]); open('/tmp/accm.csv','w').write(chr(10).join(l for l in f.splitlines() if int(l.split(',')[0])<=n)+chr(10))"`);
const DATA = readFileSync('/tmp/accm.bin').toString('base64'), FR = readFileSync('/tmp/accm.csv').toString('base64');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
const ctx = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
await ctx.route('http://localhost/**', (route) => {
  let p = new URL(route.request().url()).pathname; if (p.endsWith('/')) p += 'index.html';
  if (p === '/vendor/capacitor.js' || p === '/vendor/bluetooth-le.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  const f = join(WWW, p);
  if (!existsSync(f)) return route.fulfill({ status: 404, body: 'nf' });
  route.fulfill({ status: 200, contentType: types[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
await ctx.addInitScript(([DATA, FR, SERVER, TOKEN, BUGGY, AID]) => {
  localStorage.setItem('ft.config', JSON.stringify({ serverUrl: SERVER, token: TOKEN }));
  const bin = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const files = { data: bin(DATA), frames: bin(FR) };
  const n = files.data.length / 6;
  window.__acc = { deleted: [], reads: 0, offsets: [], errors: [], batt: [{ t: Date.now() - 60000, level: 97, device: 'Polar H10 X', phase: 'pre' }] };
  const CT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (u) => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CT[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    LocalNotifications: { async createChannel() {}, async checkPermissions() { return { display: 'granted' }; }, async requestPermissions() { return { display: 'granted' }; }, async getPending() { return { notifications: [] }; }, async cancel() {}, async schedule() { return { notifications: [] }; } },
    WorkoutRecorder: {
      async getState() { return { running: false }; }, async takeFinishedSessions() { return { sessions: [] }; }, async takeEcgRecords() { return { records: [] }; },
      async batteryStatus() { return { ignoring: true }; },
      async listAcc() { return { records: window.__acc.deleted.includes(AID) ? [] : [{ id: AID, fs: 200, range_g: 8, samples: n, complete: true, test: false, workout_id: 'wmockacc1', started_at: Date.now() - 200000, bytes: files.data.length, frames_bytes: files.frames.length, active: false }, { id: 'tjunk', complete: true, test: true, bytes: 6, frames_bytes: 0 }] }; },
      async readAccChunk(args) {
        window.__acc.reads++;
        // what the bridge does: JSON → org.json; numbers that fit in int become Integer
        const d = JSON.parse(JSON.stringify(args));
        const isInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
        const getLong = (k, def) => (typeof d[k] === 'number' && !isInt(d[k]) ? d[k] : def);     // PluginCall.getLong
        const argLong = (k, def) => (typeof d[k] === 'number' ? Math.trunc(d[k]) : typeof d[k] === 'string' && /^\d+$/.test(d[k]) ? Number(d[k]) : def);
        if (typeof d.offset !== 'number' || typeof d.length !== 'number') { window.__acc.errors.push('non-numeric args ' + JSON.stringify(d)); throw new Error('bad args'); }
        const offset = BUGGY ? getLong('offset', 0) : argLong('offset', -1);
        const length = argLong('length', 600000);
        window.__acc.offsets.push([d.file, d.offset, offset]);
        const u = files[d.file].subarray(offset, offset + length);
        const cs = new Blob([u]).stream().pipeThrough(new CompressionStream('deflate'));
        const r = { b64: b64(new Uint8Array(await new Response(cs).arrayBuffer())) };
        if (!BUGGY) { r.crc32 = crc32(u); r.len = u.length; r.offset = offset; }
        return r;
      },
      async accHash({ id }) {
        const h = async (u) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map((x) => x.toString(16).padStart(2, '0')).join('');
        return { sha256_data: await h(files.data), sha256_frames: await h(files.frames), bytes: files.data.length, frames_bytes: files.frames.length };
      },
      async deleteAcc({ id }) { window.__acc.deleted.push(id); return { ok: true }; },
      async takeStrapBattery() { const r = window.__acc.batt; window.__acc.batt = []; return { readings: r }; },
    } } };
}, [DATA, FR, SERVER, TOKEN, BUGGY, AID]);
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto('http://localhost/');
const H = { Authorization: 'Bearer ' + TOKEN };
if (BUGGY) {
  await page.waitForTimeout(12000);
  const st = await page.evaluate(() => window.__acc);
  ok(st.offsets.some((o) => o[1] > 0 && o[2] === 0), 'buggy mode reproduces getLong → offset 0');
  ok(!st.deleted.includes(AID), 'corrupted upload is NOT confirmed → phone keeps its copy');
  const rec = await fetch(SERVER + 'api/acc/' + AID, { headers: H }).then((r) => r.json());
  ok(!(rec.record && rec.record.complete), 'server did not accept the corrupted record');
} else {
  await page.waitForFunction((AID) => window.__acc.deleted.includes(AID), AID, { timeout: 30000 });
  const st = await page.evaluate(() => window.__acc);
  ok(st.deleted.includes('tjunk'), 'test record deleted without upload');
  ok(!st.errors.length, 'all plugin args numeric: ' + st.errors.join('; '));
  ok(st.reads >= 3, `uploaded in ${st.reads} chunks`);
  ok(st.offsets.every((o) => o[1] === o[2]) && st.offsets.filter((o) => o[0] === 'data').map((o) => o[2]).join() === [0, 1, 2, 3, 4, 5, 6].map((k) => k * 524288).filter((x) => x < readFileSync('/tmp/accm.bin').length).join(), 'chunks read at 0, 512K, 1M, … ' + st.offsets.filter((o) => o[0] === 'data').map((o) => o[2]).join(','));
  const rec = await fetch(SERVER + 'api/acc/' + AID, { headers: H }).then((r) => r.json());
  ok(rec.record && rec.record.complete && rec.record.meta.verified && rec.record.result.ok && Math.abs(rec.record.result.cadence.med - 170) <= 1, 'server has the verified record, dynamics ok: cadence ' + (rec.record && rec.record.result.cadence && rec.record.result.cadence.med));
  if (ACC_DIR) {
    const sd = readFileSync(join(ACC_DIR, AID, 'data.bin')), sf = readFileSync(join(ACC_DIR, AID, 'frames.csv'));
    ok(sd.equals(readFileSync('/tmp/accm.bin')), `server data.bin byte-equal to the phone file (${sd.length} B)`);
    ok(sf.equals(readFileSync('/tmp/accm.csv')), `server frames.csv byte-equal (${sf.length} B)`);
  } else ok(false, 'ACC_DIR not set — byte comparison skipped');
  await page.waitForTimeout(1500);
  const b = await fetch(SERVER + 'api/stats/strap-battery', { headers: H }).then((r) => r.json());
  ok(b.readings.some((r) => r.level === 97 && r.device === 'Polar H10 X'), 'strap battery reading uploaded');
}
await browser.close();
console.log(process.exitCode ? 'ACC UPLOAD FAILED' : 'ACC UPLOAD PASSED');
