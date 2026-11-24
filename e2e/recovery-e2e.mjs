// Recovery tab through the web UI with synthetic HR sessions (pre / run / post with exponential recovery).
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { shot } from './paths.mjs';
const A = createRequire(import.meta.url)('../server/app/static/analysis.js');
const SERVER = 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
function synth(dayOff, tau, end, rest, postMin, gapAt = null) {
  const D = 1500, ss = [];
  for (let t = -900; t < 0; t++) ss.push([t, Math.round(rest + 8 + 6 * Math.sin(t / 50) + (Math.random() - .5) * 4)]);
  for (let t = 0; t <= D; t++) ss.push([t, Math.round(115 + (end - 115) * Math.min(1, t / 1200) + (Math.random() - .5) * 4)]);
  for (let t = 1; t <= postMin * 60; t++) { if (gapAt && t > gapAt && t < gapAt + 25) continue; ss.push([D + t, Math.round(rest + 15 + (end - rest - 15) * Math.exp(-t / tau) + (Math.random() - .5) * 4)]); }
  const start = Date.now() - dayOff * 86400000;
  const w = { id: 'wrecsyn' + String(dayOff).padStart(2, '0'), type: 'run', date: new Date(start).toLocaleDateString('sv-SE'), started_at: start, ended_at: start + D * 1000, duration_s: D,
    steps: 4000, distance_m: 4200 + dayOff * 10, moving_s: 1480, hr: { avg: 150, max: end, min: 110 }, device: 'Polar H10', updated_at: Date.now(),
    session_start: start - 900000, session_end: start + (D + postMin * 60) * 1000, session_samples: ss, samples: ss.filter((p) => p[0] >= 0 && p[0] <= D) };
  // RR intervals from the HR curve: variability high at rest, ~gone while running, slowly back after
  const rr = []; let t = -900 + 0.5;
  const hrAt = (x) => { const p = ss[Math.max(0, Math.min(ss.length - 1, Math.round(x + 900)))]; return p ? p[1] : 70; };
  const amp = (x) => x < 0 ? 0.045 + dayOff * 0.001 : x <= D ? 0.004 : Math.min(0.03, 0.004 + (x - D) / 1800 * 0.03);
  while (t < D + postMin * 60) { const base = 60000 / hrAt(t); const v = Math.round(base * (1 + amp(t) * (Math.sin(t * 1.7) + (Math.random() - 0.5)))); rr.push([Math.round(t * 1000) / 1000, v]); t += v / 1000; }
  w.session_rr = rr;
  w.recovery = Object.assign(A.recoverySummary(A.recovery(w)), A.hrvSummary(A.hrv(w)));
  return w;
}
const ws = [synth(20, 110, 172, 62, 40), synth(15, 100, 175, 60, 45), synth(11, 95, 170, 61, 30, 130), synth(7, 85, 176, 58, 50), synth(3, 80, 178, 57, 60), synth(1, 120, 168, 64, 20)];
for (const w of ws) { const r = await fetch(SERVER + 'api/workouts/' + w.id, { method: 'PUT', headers: H, body: JSON.stringify(w) }); if (r.status !== 200) { console.error(await r.text()); process.exitCode = 1; } }
const r0 = A.recovery(ws[4]);
ok(Math.abs(r0.tau - 80) <= 12 && r0.hrr[1] > 25 && r0.baseline < 70, `metrics on synthetic run (τ true 80): τ=${r0.tau}, HRR1=${r0.hrr[1]}, HRR2=${r0.hrr[2]}, base=${r0.baseline}, <100 at ${r0.t_below_100}s`);
const g = A.recovery(ws[2]);
ok(g.gaps === 1 && g.max_gap_s >= 24, `gap handled: ${g.gaps} gap(s), max ${g.max_gap_s}s, HRR2=${g.hrr[2]}`);
const api = await fetch(SERVER + 'api/stats/recovery', { headers: H }).then((r) => r.json());
const a1 = api.find((x) => x.id === 'wrecsyn01'); ok(api.length >= 6 && a1 && a1.curve.length < ws[5].session_samples.length / 2, `endpoint: ${api.length} sessions, curve bins ${a1 && a1.curve.length} (raw ${ws[5].session_samples.length})`);

const h0 = A.hrv(ws[4]);
ok(h0 && h0.pre && h0.pre.rmssd > 20 && h0.post5_10 && h0.post5_10.rmssd < h0.pre.rmssd && h0.series.length > 50, `HRV synthetic: pre RMSSD ${h0.pre.rmssd}, SDNN ${h0.pre.sdnn}, post5-10 ${h0.post5_10.rmssd}, series ${h0.series.length}, artifacts ${h0.artifacts_pct}%`);
// ECG: synthetic 60-s strip with known beats → R peaks, then stored on the server
function ecgSynth(id, sec, bpm, startedAt) {
  const fs = 130, n = fs * sec, x = new Float64Array(n), beats = []; let t = 0.4;
  while (t < sec - 0.5) { beats.push(Math.round(t * fs)); t += 60 / bpm * (1 + 0.06 * Math.sin(beats.length * 0.9)); }
  for (let i = 0; i < n; i++) x[i] = 250 * Math.sin(i / fs * 2) + (Math.random() - 0.5) * 30;
  for (const p of beats) for (let k = -20; k <= 50; k++) { const j = p + k; if (j < 0 || j >= n) continue;
    x[j] += 1300 * Math.exp(-(k * k) / 2) - 250 * Math.exp(-((k - 3) ** 2) / 2) - 150 * Math.exp(-((k + 3) ** 2) / 2) + 300 * Math.exp(-((k - 35) ** 2) / 40) + 90 * Math.exp(-((k + 18) ** 2) / 10); }
  const i16 = new Int16Array(n); for (let i = 0; i < n; i++) i16[i] = Math.round(x[i]);
  const peaks = A.rPeaks(i16, fs), st = A.ecgStats(peaks, fs);
  const hit = beats.filter((b) => peaks.some((p) => Math.abs(p - b) <= 2)).length;
  return { rec: { id, started_at: startedAt, fs, n, duration_s: sec, samples_b64: Buffer.from(i16.buffer).toString('base64'), r_peaks: peaks, hr_avg: st.hr_avg, rmssd: st.rmssd, sdnn: st.sdnn, device: 'Polar H10 9A1B2C3D', phase: 'pre', updated_at: Date.now() }, beats: beats.length, hit, peaks: peaks.length };
}
const e1 = ecgSynth('ecgsyn0001', 60, 64, Date.now() - 3 * 86400000), e2 = ecgSynth('ecgsyn0002', 120, 58, Date.now() - 3600000);
ok(e1.hit === e1.beats && e1.peaks === e1.beats && e2.hit === e2.beats, `ECG R peaks: ${e1.hit}/${e1.beats} and ${e2.hit}/${e2.beats} found (no false: ${e1.peaks}, ${e2.peaks}); HR ${e2.rec.hr_avg}, RMSSD ${e2.rec.rmssd}`);
for (const e of [e1, e2]) { const r = await fetch(SERVER + 'api/ecg/' + e.rec.id, { method: 'PUT', headers: H, body: JSON.stringify(e.rec) }); ok(r.status === 200, `ECG ${e.rec.id} stored (${Math.round(JSON.stringify(e.rec).length / 1024)} KB)`); }

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
for (const [vw, vh, tag] of [[1100, 900, 'desktop'], [393, 851, 'mobile']]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: tag === 'mobile' ? 2 : 1, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  await page.goto(SERVER);
  await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tabs button[data-tab=recovery]');
  await page.waitForSelector('#recMain:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(600);
  const cards = (await page.textContent('#recCards')).replace(/\s+/g, ' ');
  ok(/за 1 мин/.test(cards) && /τ/.test(cards) && /к среднему|как обычно/.test(cards), `${tag}: cards ${cards.slice(0, 160)}`);
  const hints = await page.$$eval('#recHints div', (d) => d.map((x) => x.className + ': ' + x.textContent));
  ok(hints.length >= 2, `${tag}: hints\n       ` + hints.join('\n       '));
  const n = await page.evaluate(() => ({ curve: Chart.getChart('recCurve').data.datasets.length, overlay: Chart.getChart('recOverlay').data.datasets.length, trend: Chart.getChart('recTrend').data.labels.length, rows: document.querySelectorAll('#recTable tr').length }));
  ok(n.curve >= 4 && n.overlay === 6 && n.trend >= 6 && n.rows >= 7, `${tag}: charts ${JSON.stringify(n)}`);
  await page.click('#recModeSeg button[data-mode=drop]');
  await page.selectOption('#recPick', 'wrecsyn03');
  ok((await page.textContent('#recLatestTitle')).includes('Бег'), `${tag}: pick another run → ${await page.textContent('#recLatestTitle')}`);
  await page.selectOption('#recPick', 'wrecsyn01');
  await page.screenshot({ path: shot(`screenshot-recovery-${tag}.png`), fullPage: true });
  // HRV block
  const hrvCards = (await page.textContent('#recHrvCards')).replace(/\s+/g, ' ');
  ok(/RMSSD до старта/.test(hrvCards) && !(await page.isHidden('#recHrvBody')), `${tag}: HRV cards ${hrvCards.slice(0, 200)}`);
  const hv = await page.evaluate(() => ({ series: Chart.getChart('recHrvChart').data.datasets[0].data.length, trend: Chart.getChart('recHrvTrend').data.labels.length }));
  ok(hv.series > 50 && hv.trend >= 6, `${tag}: HRV chart ${JSON.stringify(hv)}; hints: ` + (await page.textContent('#recHrvHints')).slice(0, 220));
  // ECG
  await page.waitForSelector('#ecgViewBox:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(300);
  ok((await page.$$('#ecgList tr[data-id]')).length >= 2 && (await page.textContent('#ecgStats')).includes('RMSSD'), `${tag}: ECG list 2 + viewer: ` + (await page.textContent('#ecgStats')).replace(/\s+/g, ' '));
  await page.click('#ecgZoom button[data-w="5"]');
  const box = await page.locator('#ecgCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.2, box.y + 100, { steps: 5 }); await page.mouse.up();
  const t0 = await page.evaluate(() => document.querySelector('#ecgCanvas') && 1);
  ok(t0 === 1, `${tag}: ECG zoom 5 s + drag work without errors`);
  if (tag === 'desktop') await page.locator('#ecgPanel').screenshot({ path: shot('screenshot-ecg-desktop.png') });
  else await page.locator('#ecgPanel').screenshot({ path: shot('screenshot-ecg-mobile.png') });
  await page.locator('#recHrvPanel').screenshot({ path: shot(`screenshot-hrv-${tag}.png`) });
  const tabsFit = await page.evaluate(() => { const t = document.querySelector('.tabs'); return t.scrollWidth <= t.clientWidth + 2; });
  ok(tabsFit, `${tag}: 5 tabs fit the width`);
  if (tag === 'desktop') {
    await page.click('.tabs button[data-tab=workout]');
    await page.click('.wk-item[data-id="wrecsyn03"]');
    await page.waitForSelector('#wkDetail:not(.hidden)'); await page.waitForTimeout(500);
    ok((await page.textContent('#wkRecovery')).includes('за 1 мин'), 'detail: recovery metrics + session chart');
    await page.locator('#wkDetail').screenshot({ path: shot('screenshot-recovery-detail.png') });
  }
  await ctx.close();
}
await browser.close();
console.log(process.exitCode ? 'RECOVERY E2E FAILED' : 'RECOVERY E2E PASSED');
