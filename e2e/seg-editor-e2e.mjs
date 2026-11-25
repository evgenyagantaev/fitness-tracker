// Interactive HR segmentation editor e2e (zoom, pan, drag start/finish/pause edges, add/delete pause, save/cancel/reset)
import { chromium } from 'playwright-core';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8090/fitness/';
const TOKEN = process.env.TOKEN || 'localtest-token';
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const near = (v, e, tol, m) => ok(Math.abs(v - e) <= tol, `${m}: ${v} ≈ ${e} ±${tol}`);

// Build a synthetic run: pre-monitoring -180..0, approach 0..60, run 60..540 (pause 200..250), cooldown 540..600, post 600..900
const wid = 'wsegedit01';
const started = Date.now() - 3600_000;
const session_samples = [];
for (let t = -180; t <= 900; t += 2) {
  let bpm = 74;
  if (t >= 0 && t < 60) bpm = 95 + (t / 60) * 30;
  else if (t >= 60 && t < 200) bpm = 148;
  else if (t >= 200 && t <= 250) bpm = 122;
  else if (t > 250 && t < 540) bpm = 156;
  else if (t >= 540 && t < 600) bpm = 132 - ((t - 540) / 60) * 18;
  else if (t >= 600) bpm = Math.max(82, 114 - (t - 600) * 0.12);
  session_samples.push([t, Math.round(bpm)]);
}
const samples = session_samples.filter(([t]) => t >= 0 && t <= 600);
const step_series = [];
let st = 0;
for (let t = 10; t <= 600; t += 10) {
  let cad = 105;
  if (t >= 60 && t <= 200) cad = 166;
  else if (t > 200 && t <= 250) cad = 0;
  else if (t > 250 && t <= 540) cad = 166;
  else if (t > 540) cad = 100;
  st += Math.round(cad / 6);
  step_series.push([t, st]);
}
const track = [];
let lat = 55.0;
for (let t = 0; t <= 600; t += 2) {
  let spd = 1.3;
  if (t >= 60 && t <= 200) spd = 2.8;
  else if (t > 200 && t <= 250) spd = 0.0;
  else if (t > 250 && t <= 540) spd = 2.8;
  else if (t > 540) spd = 1.2;
  lat += (spd * 2) / 111195;
  track.push([t, lat, 37.0, 4]);
}

const workout = {
  id: wid, type: 'run', date: '2026-11-25', started_at: started, ended_at: started + 600_000,
  duration_s: 600, steps: st, stride_m: 0.9, distance_m: 1200,
  hr: { avg: 145, max: 160, min: 95 }, samples, step_series, track,
  session_start: started - 180_000, session_end: started + 900_000, session_samples,
  updated_at: Date.now(), deleted: false,
};

const putRes = await fetch(SERVER + 'api/workouts/' + wid + '?force=true', { method: 'PUT', headers: H, body: JSON.stringify(workout) });
ok(putRes.ok, 'seeded test workout on server');

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
page.on('pageerror', (e) => { fails++; console.error('PAGEERROR', e.message); });

await page.goto(SERVER);
await page.fill('#loginToken', TOKEN);
await page.click('#loginBtn');
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForSelector(`.wk-item[data-id="${wid}"]`);
await page.click(`.wk-item[data-id="${wid}"]`);
await page.waitForSelector('#wkDetail:not(.hidden)');
await page.waitForSelector('#wkChartBar:not(.hidden)');
await page.waitForTimeout(300);

const getChartInfo = async () => {
  await page.locator('#wkChartBox').scrollIntoViewIfNeeded();
  return page.evaluate(() => {
  const ch = Chart.getChart('wkChart');
  const r = ch.canvas.getBoundingClientRect();
  const xs = ch.scales.x, ca = ch.chartArea;
  const ed = ch.$editor;
  return {
    left: r.left, top: r.top, ca: { left: ca.left, right: ca.right, top: ca.top, bottom: ca.bottom },
    viewMin: xs.min, viewMax: xs.max,
    fullMin: ed.fullMin, fullMax: ed.fullMax,
    draft: ed.draft,
    delHits: ed.delHits,
    pxOf: {},
    t0x: r.left + xs.getPixelForValue(ed.draft.t0 / 60),
    t1x: r.left + xs.getPixelForValue(ed.draft.t1 / 60),
    pausesX: ed.draft.pauses.map(([a, b]) => [r.left + xs.getPixelForValue(a / 60), r.left + xs.getPixelForValue(b / 60)]),
    midY: r.top + (ca.top + ca.bottom) / 2,
  };
  });
};

let info = await getChartInfo();
ok(info.draft.pauses.length === 1, `initial auto pause detected (${JSON.stringify(info.draft.pauses)})`);
ok(await page.isHidden('#wkSegSave'), 'Save hidden before edits');

// 1. Wheel zoom + pan + reset
const fullSpan = info.viewMax - info.viewMin;
await page.mouse.move(info.left + (info.ca.left + info.ca.right) / 2, info.midY);
await page.mouse.wheel(0, -240);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(100);
let zoomed = await getChartInfo();
ok((zoomed.viewMax - zoomed.viewMin) < fullSpan * 0.75, `wheel zoomed in: ${(zoomed.viewMax - zoomed.viewMin).toFixed(2)} < ${fullSpan.toFixed(2)}`);

// Pan right by dragging empty area far from markers
const panX = zoomed.left + zoomed.ca.left + (zoomed.ca.right - zoomed.ca.left) * 0.52;
const safePanX = Math.abs(panX - zoomed.t0x) > 25 && Math.abs(panX - zoomed.t1x) > 25 ? panX : zoomed.left + zoomed.ca.left + 40;
await page.mouse.move(safePanX, info.midY);
await page.mouse.down();
await page.mouse.move(safePanX - 60, info.midY, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(80);
let panned = await getChartInfo();
ok(panned.viewMin > zoomed.viewMin + 0.05, `pan shifted viewMin: ${zoomed.viewMin.toFixed(2)} -> ${panned.viewMin.toFixed(2)}`);

await page.click('#wkZReset');
await page.waitForTimeout(80);
let resetZ = await getChartInfo();
near(resetZ.viewMax - resetZ.viewMin, fullSpan, 0.05, 'zoom reset restores full span');

// 2. Drag t0 & check Cancel
info = await getChartInfo();
const oldT0 = info.draft.t0;
const targetT0Px = info.left + (info.t0x - info.left) + 25;
await page.mouse.move(info.t0x, info.midY);
await page.mouse.down();
await page.mouse.move(targetT0Px, info.midY, { steps: 8 });
const readoutDuringDrag = await page.textContent('#wkCursorReadout');
await page.mouse.up();
await page.waitForTimeout(80);
ok(readoutDuringDrag.includes('старт'), `cursor readout while dragging t0: "${readoutDuringDrag}"`);
let afterT0 = await getChartInfo();
ok(afterT0.draft.t0 > oldT0 + 5, `t0 moved right: ${oldT0} -> ${afterT0.draft.t0}`);
ok(Number.isInteger(afterT0.draft.t0), 't0 snapped to 1 s');
ok(await page.isVisible('#wkSegSave') && await page.isVisible('#wkSegCancel'), 'Save/Cancel visible after drag');

await page.click('#wkSegCancel');
await page.waitForTimeout(200);
let afterCancel = await getChartInfo();
near(afterCancel.draft.t0, oldT0, 1, 'Cancel reverted t0');
ok(await page.isHidden('#wkSegSave'), 'Save hidden after Cancel');

// 3. Zoom to run, drag t0, drag t1, drag pause start, add a pause via + Пауза, add via dblclick, delete via × badge, Save!
await page.click('#wkZRun');
await page.waitForTimeout(80);
info = await getChartInfo();
const runZoomSpan = info.viewMax - info.viewMin;

// Drag t0 to +20s (~80s) and t1 to -20s (~520s)
const pxPerSec = (info.ca.right - info.ca.left) / (runZoomSpan * 60);
await page.mouse.move(info.t0x, info.midY);
await page.mouse.down();
await page.mouse.move(info.t0x + 20 * pxPerSec, info.midY, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(50);

info = await getChartInfo();
await page.mouse.move(info.t1x, info.midY);
await page.mouse.down();
await page.mouse.move(info.t1x - 20 * pxPerSec, info.midY, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(50);

// Drag pause 0 start edge earlier by 12s
info = await getChartInfo();
const p0StartBefore = info.draft.pauses[0][0];
await page.mouse.move(info.pausesX[0][0], info.midY);
await page.mouse.down();
await page.mouse.move(info.pausesX[0][0] - 12 * pxPerSec, info.midY, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(50);
info = await getChartInfo();
ok(info.draft.pauses[0][0] < p0StartBefore - 5, `pause start moved earlier: ${p0StartBefore} -> ${info.draft.pauses[0][0]}`);

// Add pause via "+ Пауза" button drag (340s..370s)
await page.click('#wkAddPause');
info = await getChartInfo();
const x340 = await page.evaluate(() => { const ch = Chart.getChart('wkChart'); return ch.canvas.getBoundingClientRect().left + ch.scales.x.getPixelForValue(340 / 60); });
const x370 = await page.evaluate(() => { const ch = Chart.getChart('wkChart'); return ch.canvas.getBoundingClientRect().left + ch.scales.x.getPixelForValue(370 / 60); });
await page.mouse.move(x340, info.midY);
await page.mouse.down();
await page.mouse.move(x370, info.midY, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(80);
info = await getChartInfo();
ok(info.draft.pauses.length === 2, `added 2nd pause via drag (${JSON.stringify(info.draft.pauses)})`);

// Plain dblclick in the run must NOT add a pause (it was stealing start-marker drags)
const x440 = await page.evaluate(() => { const ch = Chart.getChart('wkChart'); return ch.canvas.getBoundingClientRect().left + ch.scales.x.getPixelForValue(440 / 60); });
const pausesBeforePlain = info.draft.pauses.length;
await page.mouse.dblclick(x440, info.midY);
await page.waitForTimeout(80);
info = await getChartInfo();
ok(info.draft.pauses.length === pausesBeforePlain, `plain dblclick did not add a pause (${JSON.stringify(info.draft.pauses)})`);

// Add 3rd pause via Shift+dblclick at 440s, then delete it via chart × badge
await page.keyboard.down('Shift');
await page.mouse.dblclick(x440, info.midY);
await page.keyboard.up('Shift');
await page.waitForTimeout(80);
info = await getChartInfo();
ok(info.draft.pauses.length === 3, `added 3rd pause via Shift+dblclick (${JSON.stringify(info.draft.pauses)})`);
const delHit = info.delHits[2];
ok(!!delHit, '3rd pause has × delete badge on chart');
if (delHit) {
  await page.mouse.click(info.left + delHit.x + delHit.w / 2, info.top + delHit.y + delHit.h / 2);
  await page.waitForTimeout(80);
}
info = await getChartInfo();
ok(info.draft.pauses.length === 2, `deleted 3rd pause via chart × badge (${JSON.stringify(info.draft.pauses)})`);

// Save explicitly
const expectedT0 = info.draft.t0, expectedT1 = info.draft.t1, expectedPauses = info.draft.pauses;
await page.click('#wkSegSave');
await page.waitForFunction(() => document.querySelector('#wkSegStatus')?.textContent.includes('Сохранено'), null, { timeout: 10000 });
await page.waitForTimeout(150);

// Zoom preserved across Save!
const afterSaveInfo = await getChartInfo();
near(afterSaveInfo.viewMax - afterSaveInfo.viewMin, runZoomSpan, 0.1, 'zoom window preserved after Save');

// Server persisted overrides and recomputed moving_s / pauses
const srvSaved = await fetch(SERVER + 'api/workouts/' + wid, { headers: H }).then((r) => r.json());
ok(Array.isArray(srvSaved.run_override) && srvSaved.run_override[0] === expectedT0 && srvSaved.run_override[1] === expectedT1,
  `server stored run_override: ${JSON.stringify(srvSaved.run_override)}`);
ok(Array.isArray(srvSaved.pause_override) && srvSaved.pause_override.length === 2,
  `server stored pause_override: ${JSON.stringify(srvSaved.pause_override)}`);
ok(srvSaved.seg.pauses.length === 2 && srvSaved.stops === 2, `server seg updated: stops=${srvSaved.stops}, pauses=${JSON.stringify(srvSaved.seg.pauses)}`);
ok(srvSaved.seg.pauses[0][0] === expectedPauses[0][0], 'edited pause start saved exact');

// Reload page & verify persistence
await page.reload();
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForSelector(`.wk-item[data-id="${wid}"]`);
await page.click(`.wk-item[data-id="${wid}"]`);
await page.waitForSelector('#wkChartBar:not(.hidden)');
await page.waitForTimeout(250);
const reloadedInfo = await getChartInfo();
ok(reloadedInfo.draft.t0 === expectedT0 && reloadedInfo.draft.t1 === expectedT1 && reloadedInfo.draft.pauses.length === 2,
  `after reload overrides intact: t0=${reloadedInfo.draft.t0}, t1=${reloadedInfo.draft.t1}, pauses=${JSON.stringify(reloadedInfo.draft.pauses)}`);

// Reset to auto
await page.click('#wkSegReset');
await page.waitForFunction(() => document.querySelector('#wkSegStatus')?.textContent.includes('Возвращено'), null, { timeout: 10000 });
await page.waitForTimeout(300);
const srvReset = await fetch(SERVER + 'api/workouts/' + wid, { headers: H }).then((r) => r.json());
ok(srvReset.run_override == null && srvReset.pause_override == null, `reset cleared overrides on server (run=${srvReset.run_override}, pause=${srvReset.pause_override})`);
ok(srvReset.seg.src === 'auto' && srvReset.seg.pauses.length === 1, `reset restored auto seg (${JSON.stringify(srvReset.seg.pauses)})`);

await browser.close();
console.log(fails ? `SEG EDITOR E2E: ${fails} FAILED` : 'SEG EDITOR E2E PASSED');
process.exit(fails ? 1 : 0);
