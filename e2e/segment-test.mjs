// v1.7 unit tests of the run segmentation (analysis.js): approach / run / pauses / cooldown, beltless, overrides. No server needed.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const A = require('../server/app/static/analysis.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (v, e, tol, m) => ok(Math.abs(v - e) <= tol, `${m}: ${v} ≈ ${e} ±${tol}`);

// profile: [from, to, cadence spm, speed m/s]
function build(profile, duration, { gps = true, motion = false, lagFirst = 15 } = {}) {
  const prof = (t) => profile.find((p) => t >= p[0] && t < p[1]) || [0, 0, 0, 0];
  const series = []; let st = 0, lat = 55.0;
  for (let t = 1; t <= duration; t++) {
    st += prof(t)[2] / 60;
    if (t >= lagFirst && (t - lagFirst) % 10 === 0) series.push([t, Math.round(st)]);
  }
  const track = [];
  if (gps) { lat = 55.0; for (let t = 0; t <= duration; t++) { lat += prof(t)[3] / 111195; track.push([t, lat, 37.0 + (t % 2) * 2e-6, 6]); } }
  const w = { type: 'run', duration_s: duration, steps: series.length ? series[series.length - 1][1] : 0, stride_m: 0.9, step_series: series, track };
  if (motion) w.motion = [];
  if (motion) for (let t = 5; t <= duration; t += 5) { const p = prof(t); w.motion.push([t, p[2] >= 135 ? Math.round(p[2]) : 0, p[2] >= 135 ? 0.5 : p[2] > 0 ? 0.12 : 0.01]); }
  return w;
}
const APPROACH = [0, 100, 100, 1.3], RUN1 = [100, 300, 165, 2.8], DOG = [300, 318, 0, 0], RUN2 = [318, 700, 165, 2.8], COOL = [700, 800, 100, 1.3];

// 0. v1.16: the pauses the phone saw live are the run's stops (every one, even 7 s); the run's start/end trim is unchanged
{
  const w = build([APPROACH, RUN1, DOG, RUN2, COOL], 800);
  const auto = A.analyze(w).seg;
  const ph = Object.assign({}, w, { phone_pauses: [[301, 318], [450, 457], [720, 780]] });   // the last one is in the cool-down
  const a = A.analyze(ph), s = a.seg;
  ok(s.pauses_src === 'phone', 'phone pauses used');
  ok(s.pauses.length === 2 && s.pauses[1][0] === 450 && s.pauses[1][1] === 457, `short 7 s pause kept, cool-down one clipped (${JSON.stringify(s.pauses)})`);
  ok(s.t0 === auto.t0 && s.t1 === auto.t1, 'run start/end trim unchanged');
  ok(a.stops === 2 && a.stop_s === 17 + 7, `stops=${a.stops} stop_s=${a.stop_s}`);
  const none = A.analyze(Object.assign({}, w, { phone_pauses: [] })).seg;
  ok(none.pauses.length === 0 && none.pauses_src === 'phone', 'phone saw no pauses: none');
  const old = A.analyze(w).seg;
  ok(old.pauses_src === undefined && old.pauses.length === 1, 'no phone pauses (old run): the segmenter decides as before');
  const ovr = A.analyze(Object.assign({}, w, { phone_pauses: [[450, 457]], pause_override: [[500, 520]] })).seg;
  ok(ovr.pauses.length === 1 && ovr.pauses[0][0] === 500 && ovr.pauses_src === undefined, 'manual pause_override still wins');
}

// 1. full picture with GPS
{
  const w = build([APPROACH, RUN1, DOG, RUN2, COOL], 800);
  const a = A.analyze(w), s = a.seg;
  ok(s.src === 'auto', 'src auto');
  near(s.t0, 100, 12, 'run start'); near(s.t1, 700, 12, 'run end');
  ok(s.approach_s === Math.round(s.t0) && Math.abs(s.cooldown_s - (800 - s.t1)) < 1.5, 'approach/cooldown seconds');
  ok(s.pauses.length === 1, `one pause (${JSON.stringify(s.pauses)})`);
  if (s.pauses.length) { near(s.pauses[0][0], 300, 8, 'pause start'); near(s.pauses[0][1], 318, 8, 'pause end'); }
  near(a.moving_s, (s.t1 - s.t0) - 18, 10, 'moving time = run − pause');
  // GPS distance is the run only: 2.8 m/s × (582 s moving) ≈ 1630 m (not the approach/cooldown 1.3 m/s)
  near(a.gps_distance_m, 2.8 * 582, 80, 'GPS distance over the run only');
  // pace on moving time only
  near(a.pace_s_km, 1000 / 2.8, 12, 'pace on moving time (~357 s/km)');
  ok(a.segments.every((x) => Number.isInteger(x[2])), 'segment step counts are integers (server model requires int)');
  near(a.cadence_avg, 165, 8, 'cadence over the run only (not diluted by approach/pause)');
}
// 2. cadence only (GPS dead)
{
  const w = build([APPROACH, RUN1, DOG, RUN2, COOL], 800, { gps: false });
  const s = A.analyze(w).seg;
  ok(s.src === 'auto', 'no GPS: run found by cadence');
  near(s.t0, 100, 20, 'no GPS: start'); near(s.t1, 700, 20, 'no GPS: end');
  ok(s.pauses.length >= 1, 'no GPS: the 18-s pause is found from the missing steps');
}
// 3. beltless with the phone accelerometer profile: pauses of 6 s become visible, approach is walking
{
  const w = build([APPROACH, RUN1, [300, 308, 0, 0], [308, 700, 165, 2.8], COOL], 800, { gps: false, motion: true });
  const s = A.analyze(w).seg;
  ok(s.src === 'auto' && s.cad_src, 'motion profile used');
  ok(s.pauses.some((p) => p[0] >= 290 && p[1] <= 320), `short (8 s) pause caught via phone motion (${JSON.stringify(s.pauses)})`);
}
// 4. override moves the boundaries and is reported as such; stats follow
{
  const w = build([APPROACH, RUN1, DOG, RUN2, COOL], 800);
  const base = A.analyze(w);
  w.run_override = [150, 600];
  const o = A.analyze(w);
  ok(o.seg.src === 'override' && o.seg.t0 === 150 && o.seg.t1 === 600, 'override applied');
  ok(o.moving_s < base.moving_s && o.gps_distance_m < base.gps_distance_m, 'recomputed over the new bounds');
  w.run_override = [null, 650];
  const o2 = A.analyze(w);
  ok(o2.seg.t1 === 650 && Math.abs(o2.seg.t0 - base.seg.t0) < 1, 'one-sided override');
}
// 5. walks are not segmented; a run that never ran uses the whole record
{
  const w = build([[0, 600, 105, 1.4]], 600); w.type = 'walk';
  ok(A.analyze(w).seg.src === 'whole', 'walk → whole');
  const r = build([[0, 600, 105, 1.4]], 600);
  const s = A.analyze(r).seg;
  ok(s.src === 'none' && s.t0 === 0 && s.t1 === 600, 'never ran → whole record, no cut');
}
// 6. a dog stop must not split the run, a long walk break (> GAP_MERGE) does not extend it
{
  const w = build([APPROACH, [100, 400, 165, 2.8], [400, 440, 0, 0], [440, 500, 165, 2.8], [500, 900, 100, 1.3]], 900);
  const s = A.analyze(w).seg;
  near(s.t0, 100, 12, 'dog 40 s: start'); near(s.t1, 500, 12, 'dog 40 s: end (the 400 s walk after is cooldown)');
}
// 9. after the run stops, 16 s of walking delays the step-gap / GPS-flat marker; the start is pulled back to the real stop, the resume is not
{
  const w = build([APPROACH, [100, 300, 165, 2.8], [300, 316, 80, 1.0], [316, 360, 0, 0], [360, 700, 165, 2.8], COOL], 800);
  const s = A.analyze(w).seg;
  ok(s.pauses.length >= 1, `gradual stop: a pause is found (${JSON.stringify(s.pauses)})`);
  if (s.pauses.length) {
    near(s.pauses[0][0], 300, 5, 'pause start is the real stop, not ~15 s later');
    near(s.pauses[0][1], 360, 8, 'pause end (resume) is unshifted');
  }
}
// 10. a manual pause list wins over auto detection and the start back-shift (including «no pauses»)
{
  const w = build([APPROACH, RUN1, DOG, RUN2, COOL], 800);
  const auto = A.analyze(w).seg;
  w.pause_override = [[310, 400]];
  const s = A.analyze(w).seg;
  ok(s.pauses.length === 1 && s.pauses[0][0] === 310 && s.pauses[0][1] === 400, `pause_override used as-is (${JSON.stringify(s.pauses)})`);
  ok(Math.abs(s.t0 - auto.t0) < 1 && Math.abs(s.t1 - auto.t1) < 1, 'run bounds stay auto when only pauses are overridden');
  w.pause_override = [];
  ok(A.analyze(w).seg.pauses.length === 0, 'empty pause_override means no pauses');
  w.run_override = [150, 600];
  w.pause_override = [[200, 250], [240, 260]];
  const o = A.analyze(w).seg;
  ok(o.src === 'override' && o.t0 === 150 && o.pauses.length === 1 && o.pauses[0][0] === 200 && o.pauses[0][1] === 260,
    `run + pause overrides combine and merge (${JSON.stringify(o.pauses)})`);
}
// 7. beltless flag + derive: no HR blocks
{
  const w = build([APPROACH, RUN1, RUN2, COOL], 800);
  const d = A.derive(Object.assign({ id: 'x', date: '2026-11-24', started_at: 0, samples: [] }, w), []);
  ok(d.beltless === true, 'no HR → beltless');
  ok(!d.hr || !d.hr.avg, 'no zero HR numbers for beltless');
}
// 8. HR anchored at the real run end (recovery counts from there, baseline stays before «Старт»)
{
  const w = build([APPROACH, RUN1, RUN2, COOL], 800);
  const samples = []; for (let t = 0; t <= 800; t++) samples.push([t, t < 100 ? 110 : t < 700 ? 170 : Math.max(120, 170 - (t - 700) * 0.5)]);
  const x = Object.assign({ id: 'y', date: '2026-11-24', started_at: 0, samples, session_samples: [] }, w);
  const d = A.derive(x, []);
  ok(d.beltless === false, 'with HR → not beltless');
  near(d.hr.max, 170, 2, 'HR max inside the run');
  near(d.hr.avg, 170, 6, 'HR average over the run only (approach/cooldown excluded)');
  Object.assign(x, d);
  near(A.runBounds(x)[1], 700, 12, 'runBounds end'); near(A.runBounds(x)[0], 100, 12, 'runBounds start');
}
// 9. a manual pause that still has steps/GPS must not blow up speed or cadence charts
{
  const w = build([[0, 200, 165, 2.8], [200, 312, 150, 2.2], [312, 700, 165, 2.8]], 700, { lagFirst: 1 });
  w.run_override = [0, 700];
  w.pause_override = [[200, 312]];
  const a = A.analyze(w);
  const speeds = a.segments.map(([t0, t1, n, dm, gm, mv]) => dm / mv * 3.6);
  const gpsSpeeds = a.segments.filter((sg) => sg[4] != null).map(([t0, t1, n, dm, gm, mv]) => gm / mv * 3.6);
  ok(speeds.every((v) => v < 20), `no 300 km/h step-speed spikes after a stepping pause (max ${Math.max(0, ...speeds).toFixed(1)} km/h)`);
  ok(!gpsSpeeds.length || gpsSpeeds.every((v) => v < 20), `no 300 km/h GPS-speed spikes (max ${gpsSpeeds.length ? Math.max(...gpsSpeeds).toFixed(1) : 0} km/h)`);
  ok(a.segments.every(([t0, t1]) => t1 <= 201 || t0 >= 311), `100-step segments stay outside the pause (${JSON.stringify(a.segments.filter(([t0, t1]) => t0 < 312 && t1 > 200))})`);
  const spikes = a.cadence.filter(([, c]) => c > 220);
  ok(spikes.length === 0, `cadence has no 400 spm spikes at pause edges (${JSON.stringify(spikes)})`);
  near(a.cadence_avg, 165, 8, 'avg cadence ignores steps inside the pause');
  near(a.gps_distance_m, 2.8 * (200 + 388), 80, 'GPS distance excludes the pause');
  near(a.steps_run, 165 * (200 + 388) / 60, 40, 'steps_run excludes pause steps');
}
// 10. pace profile helpers: s/km, no blow-ups, axis auto-fits and stays in range
{
  ok(A.paceSec(1000, 420) === 420, '7:00 /км from 1 km in 420 s');
  ok(A.paceSec(83, 1) == null, '300 km/h segment is dropped, not a 0:43 pace');
  ok(A.paceSec(100, 200) == null, '33 min/km walk is dropped (slower than 12:00)');
  ok(A.paceSec(0, 30) == null && A.paceSec(100, 0) == null, 'zero distance or time is dropped');
  const tight = A.paceAxisRange([390, 420, 450]);
  ok(tight.min <= 390 && tight.max >= 450 && tight.min >= 120 && tight.max <= 720, `auto-fit around data: ${JSON.stringify(tight)}`);
  ok(tight.max - tight.min < 300, 'auto-fit does not force the full 3:00–12:00 window');
  const empty = A.paceAxisRange([]);
  ok(empty.min === 180 && empty.max === 720, 'empty series defaults to 3:00–12:00');
  const one = A.paceAxisRange([420]);
  ok(one.max - one.min >= 60 && one.min <= 420 && one.max >= 420, `single point has at least 1 min span: ${JSON.stringify(one)}`);
}
console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
