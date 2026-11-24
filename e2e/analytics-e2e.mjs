// v1.3 analytics through the web UI (local nginx → FastAPI): synthetic GPS runs → detail profiles, map, stats, calibration.
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { shot } from './paths.mjs';
const A = createRequire(import.meta.url)('../server/app/static/analysis.js');
const SERVER = 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

// synthetic run: loop around a park, speed varies, one 60 s stop, GPS noise ±3 m, strideTrue m/step
function synth(dayOffset, minutes, strideTrue, { stopAt = 600, badGps = false } = {}) {
  const dur = minutes * 60, series = [], track = [], samples = [];
  let steps = 0, d = 0, frac = 0;
  const lat0 = 55.0, lon0 = 37.0, Rloop = 400;
  for (let t = 1; t <= dur; t++) {
    const stopped = t >= stopAt && t < stopAt + 60;
    const v = stopped ? 0 : 2.8 + 0.6 * Math.sin(t / 120);          // m/s
    if (!stopped) { frac += v / strideTrue; const n = Math.floor(frac); frac -= n; steps += n; d += v; }
    series.push([t, steps]);
    const ang = d / Rloop, noise = () => (Math.random() - 0.5) * 6 / 111195;
    const acc = badGps ? 40 : 4 + Math.random() * 4;
    track.push([t, +(lat0 + Rloop * Math.sin(ang) / 111195 + noise()).toFixed(6), +(lon0 + Rloop * (1 - Math.cos(ang)) / (111195 * Math.cos(lat0 * Math.PI / 180)) + noise()).toFixed(6), +acc.toFixed(1)]);
    samples.push([t, Math.round(stopped ? 120 : 150 + 10 * Math.sin(t / 200))]);
  }
  const ser = series.filter((p, i) => i === 0 || p[1] !== series[i - 1][1]);
  const start = Date.now() - dayOffset * 86400000 - dur * 1000;
  const w = { id: 'wsyn' + dayOffset + 'x' + minutes, type: 'run', date: new Date(start).toLocaleDateString('sv-SE'), started_at: start, ended_at: start + dur * 1000,
    duration_s: dur, steps, stride_m: 0.75, samples, step_series: ser, track, updated_at: Date.now(), device: 'Polar H10',
    hr: { avg: 150, max: 160, min: 120 } };
  const an = A.analyze(w);
  Object.assign(w, { distance_m: an.distance_m, step_distance_m: an.step_distance_m, moving_s: an.moving_s, stop_s: an.stop_s, stops: an.stops,
    cadence_avg: an.cadence_avg, gps_distance_m: an.gps_distance_m, gps_ok: an.gps_ok, gps_acc: an.gps_acc, gps_coverage: an.gps_coverage,
    gps_stride_m: an.gps_stride_m, segments: an.segments, stride_source: 'manual' });
  return { w, trueDist: d, an };
}
const runs = [synth(9, 20, 1.02), synth(6, 25, 1.05), synth(3, 22, 1.0), synth(1, 15, 1.03, { badGps: true })];
for (const { w, trueDist, an } of runs) {
  const r = await fetch(SERVER + 'api/workouts/' + w.id, { method: 'PUT', headers: H, body: JSON.stringify(w) });
  if (r.status !== 200) { console.error(await r.text()); process.exitCode = 1; }
  console.log(`     run ${w.id}: true ${Math.round(trueDist)} m, gps ${an.gps_distance_m} (ok ${an.gps_ok}), steps ${w.steps}, moving ${an.moving_s}s, stops ${an.stops}/${an.stop_s}s, segs ${an.segments.length}, cad ${an.cadence_avg}`);
}
const g = runs[0];
ok(Math.abs(g.an.gps_distance_m - g.trueDist) / g.trueDist < 0.05, `GPS distance within 5 %: ${g.an.gps_distance_m} vs ${Math.round(g.trueDist)}`);
ok(g.an.stops === 1 && Math.abs(g.an.stop_s - 60) <= 3, `stop detected: ${g.an.stops} × ${g.an.stop_s}s`);
ok(!runs[3].an.gps_ok, 'bad-GPS run flagged (accuracy 40 m)');
const cal = await fetch(SERVER + 'api/stats/calibration', { headers: H }).then((r) => r.json());
ok(cal.run.n === 3 && Math.abs(cal.run.stride_m - 1.023) < 0.04, `calibrated stride ${cal.run.stride_m} m from ${cal.run.n} runs (true ≈1.02)`);

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto(SERVER);
await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN);
await page.click('#loginBtn').catch(() => {});
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForSelector('.wk-item');
await page.click(`.wk-item[data-id="${runs[2].w.id}"]`);
await page.waitForSelector('#wkDetail:not(.hidden)');
await page.waitForSelector('#wkMap .leaflet-tile-loaded', { timeout: 15000 }).catch(() => {});
const txt = await page.textContent('#wkDetailStats');
ok(/В движении/.test(txt) && /Остановки: 1/.test(txt) && /По GPS/.test(txt) && /Каденс средний: \d+/.test(txt), 'detail shows moving time, stops, GPS, cadence');
ok(await page.evaluate(() => !!window.__wkMap && document.querySelectorAll('#wkMap path.leaflet-interactive').length >= 1), 'track drawn on the map');
ok(await page.evaluate(() => document.querySelectorAll('#wkMap .leaflet-tile-loaded').length > 0), 'OSM tiles loaded');
const sp = await page.evaluate(() => { const c = Chart.getChart('wkSpeedChart'); return c ? c.data.datasets.map((d) => d.data.length) : null; });
ok(sp && sp[0] > 20 && sp[1] > 20, `speed profile: ${sp} segments (steps / GPS)`);
const cd = await page.evaluate(() => { const c = Chart.getChart('wkCadChart'); return c ? c.data.datasets[0].data.length : 0; });
ok(cd > 50, `cadence profile: ${cd} points`);
await page.screenshot({ path: shot('screenshot-analytics-detail.png'), fullPage: true });
await page.click('.tabs button[data-tab=stats]');
await page.waitForFunction(() => document.querySelectorAll('#runCards .card').length > 0, null, { timeout: 10000 });
const rc = await page.evaluate(() => { const c = Chart.getChart('runsChart'); return c ? c.data.labels.length : 0; });
ok(rc >= 4, `stats: runs chart with ${rc} runs; cards: ${(await page.textContent('#runCards')).replace(/\s+/g, ' ').slice(0, 120)}`);
await page.waitForTimeout(1500); await page.locator('#runCards').screenshot({ path: shot('screenshot-analytics-cards.png') });
await page.locator('#runsChart').screenshot({ path: shot('screenshot-analytics-runs.png') });
await page.click('.tabs button[data-tab=settings]');
await page.waitForFunction(() => /по 3 тренировкам/.test(document.querySelector('#calibPanel').textContent), null, { timeout: 10000 });
ok(true, 'settings: ' + (await page.textContent('#calibPanel')).slice(0, 110));
await page.selectOption('#strideMode', 'manual');
await page.waitForSelector('.calib-apply');
await page.click('.calib-apply');
ok(await page.evaluate(() => Math.abs(FT.Store.config().stride - FT.Store.config().calib.run.stride_m) < 0.001), 'apply calibrated stride manually');
await page.selectOption('#strideMode', 'auto');
await page.locator('#calibPanel').screenshot({ path: shot('screenshot-analytics-calib.png') });
await browser.close();
console.log(process.exitCode ? 'ANALYTICS E2E FAILED' : 'ANALYTICS E2E PASSED');
