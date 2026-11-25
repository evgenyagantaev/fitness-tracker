// Drag-stability e2e: long-axis session like a real run (start ~15 s, pause ~59–124 s).
// Uses real mouse.down/move/up with 1 px steps. Never clicks Save.
import { chromium } from 'playwright-core';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8090/fitness/';
const TOKEN = process.env.TOKEN || 'localtest-token';
const CHROME = process.env.CHROME_PATH || '/opt/google/chrome/chrome';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

const wid = 'wsegdrag01';
const started = Date.now() - 3600_000;
// Session like Evgeny's latest run: ~15 min pre, 20 min workout, ~20 min recovery
const session_samples = [];
for (let t = -900; t <= 2500; t += 2) {
  let bpm = 74;
  if (t >= 0 && t < 15) bpm = 78 + t;
  else if (t >= 15 && t < 59) bpm = 105;
  else if (t >= 59 && t <= 124) bpm = 95;
  else if (t > 124 && t < 1190) bpm = 130 + Math.round(15 * Math.sin(t / 80));
  else if (t >= 1190) bpm = Math.max(80, 145 - (t - 1190) * 0.05);
  session_samples.push([t, Math.max(50, Math.round(bpm))]);
}
const samples = session_samples.filter(([t]) => t >= 0 && t <= 1203);
const step_series = [];
let st = 0;
for (let t = 10; t <= 1203; t += 10) {
  let cad = 0;
  if (t >= 15 && t < 59) cad = 166;
  else if (t >= 59 && t <= 124) cad = 0;
  else if (t > 124 && t <= 1190) cad = 166;
  st += Math.round(cad / 6);
  step_series.push([t, st]);
}
const workout = {
  id: wid, type: 'run', date: '2026-11-25', started_at: started, ended_at: started + 1203_000,
  duration_s: 1203, steps: st, stride_m: 0.85, distance_m: 2634,
  hr: { avg: 135, max: 150, min: 78 }, samples, step_series,
  session_start: started - 900_000, session_end: started + 2500_000, session_samples,
  run_override: [15, 1190], pause_override: [[59, 124]],
  updated_at: Date.now(), deleted: false,
};

const putRes = await fetch(SERVER + 'api/workouts/' + wid + '?force=true', { method: 'PUT', headers: H, body: JSON.stringify(workout) });
ok(putRes.ok, 'seeded long-axis workout');

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
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

const getInfo = async () => {
  await page.locator('#wkChartBox').scrollIntoViewIfNeeded();
  return page.evaluate(() => {
    const ch = Chart.getChart('wkChart');
    const r = ch.canvas.getBoundingClientRect();
    const xs = ch.scales.x, ca = ch.chartArea, ed = ch.$editor;
    const X = (t) => r.left + xs.getPixelForValue(t / 60);
    return {
      left: r.left, top: r.top,
      ca: { left: ca.left, right: ca.right, top: ca.top, bottom: ca.bottom },
      viewMin: xs.min, viewMax: xs.max,
      draft: JSON.parse(JSON.stringify(ed.draft)),
      t0x: X(ed.draft.t0), t1x: X(ed.draft.t1),
      pausesX: ed.draft.pauses.map(([a, b]) => [X(a), X(b)]),
      midY: r.top + (ca.top + ca.bottom) / 2,
      pillT0: (ed.markerHits || []).filter((h) => h.type === 't0').map((h) => ({
        x: r.left + h.x, y: r.top + h.y, w: h.w, h: h.h,
      })),
      dragging: !!(ed.drag && ed.drag.kind === 'marker'),
      pxPerSec: (ca.right - ca.left) / ((xs.max - xs.min) * 60),
    };
  });
};

const dragSteps = async (fromX, y, toX, sample) => {
  const samples = [];
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  const dist = toX - fromX;
  const n = Math.max(20, Math.abs(Math.round(dist)));
  for (let i = 1; i <= n; i++) {
    const x = fromX + dist * (i / n);
    await page.mouse.move(x, y, { steps: 1 });
    if (i === 3 || i === Math.round(n * 0.4) || i === Math.round(n * 0.7) || i === n) {
      samples.push(await sample());
    }
  }
  // confirm drag is still live just before mouseup (must not have frozen)
  const live = await page.evaluate(() => {
    const ed = Chart.getChart('wkChart').$editor;
    return !!(ed.drag && ed.drag.kind === 'marker');
  });
  await page.mouse.up();
  await page.waitForTimeout(60);
  return { samples, live };
};

// ---------- default zoom ----------
let info = await getInfo();
ok(info.draft.t0 === 15 && info.draft.t1 === 1190, `default draft bounds t0=${info.draft.t0} t1=${info.draft.t1}`);
ok(info.draft.pauses.length === 1 && info.draft.pauses[0][0] === 59 && info.draft.pauses[0][1] === 124,
  `default pause ${JSON.stringify(info.draft.pauses)}`);
const gap = Math.abs(info.pausesX[0][0] - info.t0x);
ok(gap < 20, `t0 and pause-start are close at default zoom: ${gap.toFixed(1)} px (reproduces the tight-hit case)`);
ok(info.viewMax - info.viewMin > 40, `full session visible (span ${(info.viewMax - info.viewMin).toFixed(1)} min)`);

// 1. Drag t0 right in 1 px steps — must keep moving, stay in drag, not add a pause
const t0Before = info.draft.t0, pausesBefore = JSON.stringify(info.draft.pauses);
const t0Target = info.t0x + 36; // ~2 min at this zoom, past the pause start
const t0Drag = await dragSteps(info.t0x, info.midY, t0Target, async () => {
  return page.evaluate(() => Chart.getChart('wkChart').$editor.draft.t0);
});
ok(t0Drag.live, 't0 drag still active at last pixel (did not freeze / lose capture)');
info = await getInfo();
ok(info.draft.t0 > t0Before + 20, `t0 moved substantially at default zoom: ${t0Before} -> ${info.draft.t0}`);
ok(t0Drag.samples.length >= 3 && t0Drag.samples[t0Drag.samples.length - 1] > t0Drag.samples[0],
  `t0 kept advancing during drag: ${t0Drag.samples.join(' → ')}`);
const tenSecNearT0 = info.draft.pauses.some(([a, b]) => b - a === 10 && Math.abs(a - info.draft.t0) < 20);
ok(!tenSecNearT0, `dragging t0 did not insert a 10 s pause (${JSON.stringify(info.draft.pauses)})`);
ok(await page.isVisible('#wkSegSave'), 'Save appears only after mouseup (layout stayed still during drag)');

// 2. Double-click on the (new) start marker must not add a 10 s pause
const pausesAfterDrag = JSON.stringify(info.draft.pauses);
await page.mouse.dblclick(info.t0x, info.midY);
await page.waitForTimeout(80);
info = await getInfo();
ok(JSON.stringify(info.draft.pauses) === pausesAfterDrag && !info.draft.pauses.some(([a, b]) => b - a === 10 && Math.abs(a - info.draft.t0) < 20),
  `dblclick on start marker did not add a pause (${JSON.stringify(info.draft.pauses)})`);

// Cancel back to overrides
await page.click('#wkSegCancel');
await page.waitForTimeout(250);
info = await getInfo();
ok(info.draft.t0 === 15 && info.draft.pauses.length === 1 && info.draft.pauses[0][0] === 59,
  `Cancel restored t0=15 pause=[[59,124]] (got t0=${info.draft.t0} pauses=${JSON.stringify(info.draft.pauses)})`);

// 3. Grab the "старт бега" pill, not the hairline
info = await getInfo();
const pill = (info.pillT0 || []).sort((a, b) => b.w - a.w)[0];
ok(!!pill && pill.w > 20, `start pill hit-box present (${pill ? `${pill.w}×${pill.h}` : 'none'})`);
if (pill) {
  const grabX = pill.x + pill.w - 6; // right edge of the label, away from the line
  const grabY = pill.y + pill.h / 2;
  const t0b = info.draft.t0;
  const pillDrag = await dragSteps(grabX, grabY, grabX + 30, async () => {
    return page.evaluate(() => Chart.getChart('wkChart').$editor.draft.t0);
  });
  ok(pillDrag.live, 'pill drag still active at last pixel');
  info = await getInfo();
  ok(info.draft.t0 > t0b + 10, `dragging the start pill moved t0: ${t0b} -> ${info.draft.t0}`);
  await page.click('#wkSegCancel');
  await page.waitForTimeout(250);
}

// 4. Drag finish, pause start, pause end at default zoom
const dragMarker = async (label, fromX, dx, read, assertFn) => {
  info = await getInfo();
  const y = info.midY;
  const x0 = typeof fromX === 'function' ? fromX(info) : fromX;
  const before = await read();
  const res = await dragSteps(x0, y, x0 + dx, read);
  ok(res.live, `${label}: drag still active at last pixel`);
  const after = await read();
  assertFn(before, after, res);
  return after;
};

await dragMarker('t1 default', (i) => i.t1x, -30, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.t1),
  (b, a) => ok(a < b - 15, `t1 moved left at default zoom: ${b} -> ${a}`));
await dragMarker('pauseStart default', (i) => i.pausesX[0][0], 16, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.pauses[0][0]),
  (b, a) => ok(a > b + 5, `pause start moved right at default zoom: ${b} -> ${a}`));
await dragMarker('pauseEnd default', (i) => i.pausesX[0][1], 16, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.pauses[0][1]),
  (b, a) => ok(a > b + 5, `pause end moved right at default zoom: ${b} -> ${a}`));

await page.click('#wkSegCancel');
await page.waitForTimeout(250);

// ---------- zoomed to run (each marker from a fresh Cancel so they don't clamp each other) ----------
const zoomAndDrag = async (label, fromX, dx, read, assertFn) => {
  if (await page.isVisible('#wkSegCancel')) {
    await page.click('#wkSegCancel');
    await page.waitForTimeout(250);
  }
  await page.click('#wkZRun');
  await page.waitForTimeout(120);
  info = await getInfo();
  return dragMarker(label, fromX, dx, read, assertFn);
};

info = await getInfo();
if (info.viewMax - info.viewMin > 30) {
  await page.click('#wkZRun');
  await page.waitForTimeout(120);
  info = await getInfo();
}
ok(info.viewMax - info.viewMin < 30, `zoomed to run, span ${(info.viewMax - info.viewMin).toFixed(2)} min`);

await zoomAndDrag('t0 zoomed', (i) => i.t0x, 40, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.t0),
  (b, a) => ok(a > b + 8, `t0 moved right zoomed: ${b} -> ${a}`));
await zoomAndDrag('t1 zoomed', (i) => i.t1x, -40, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.t1),
  (b, a) => ok(a < b - 8, `t1 moved left zoomed: ${b} -> ${a}`));
await zoomAndDrag('pauseStart zoomed', (i) => i.pausesX[0][0], -30, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.pauses[0][0]),
  (b, a) => ok(a < b - 5, `pause start moved left zoomed: ${b} -> ${a}`));
await zoomAndDrag('pauseEnd zoomed', (i) => i.pausesX[0][1], 30, async () => page.evaluate(() => Chart.getChart('wkChart').$editor.draft.pauses[0][1]),
  (b, a) => ok(a > b + 5, `pause end moved right zoomed: ${b} -> ${a}`));

// Leave unsaved — Cancel, never Save (must not persist on the server)
await page.click('#wkSegCancel');
await page.waitForTimeout(250);
const srv = await fetch(SERVER + 'api/workouts/' + wid, { headers: H }).then((r) => r.json());
ok(Array.isArray(srv.run_override) && srv.run_override[0] === 15 && srv.run_override[1] === 1190,
  `server run_override unchanged: ${JSON.stringify(srv.run_override)}`);
ok(Array.isArray(srv.pause_override) && srv.pause_override[0][0] === 59 && srv.pause_override[0][1] === 124,
  `server pause_override unchanged: ${JSON.stringify(srv.pause_override)}`);

await browser.close();
console.log(fails ? `SEG EDITOR DRAG E2E: ${fails} FAILED` : 'SEG EDITOR DRAG E2E PASSED');
process.exit(fails ? 1 : 0);
