/* Workout analytics shared by web & app: stops (auto-pause), moving time, 100-step segments (speed profile),
   cadence profile, GPS distance with quality check. Pure functions, no DOM. */
(function (root) {
  'use strict';
  const STOP_GAP_S = 10;       // no steps for ≥10 s → stopped
  const SEG_STEPS = 100;
  const GPS_MAX_ACC = 25;      // metres; worse fixes are ignored
  const R = 6371008.8;

  function hav(a, b) {
    const toR = Math.PI / 180, dLat = (b[1] - a[1]) * toR, dLon = (b[2] - a[2]) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  /** GPS: cumulative distance curve [[sec, metres]] from track [[sec, lat, lon, acc]]. Same filter as the service. */
  function gpsCurve(track) {
    const curve = []; let anchor = null, dist = 0;
    const good = (track || []).filter((p) => p && p.length >= 4 && p[3] <= GPS_MAX_ACC);
    // smooth jitter: centred moving average over ±2 fixes within ±3 s (keeps corners, kills noise that inflates distance)
    const sm = good.map((p, i) => {
      let la = 0, lo = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(good.length - 1, i + 2); j++) if (Math.abs(good[j][0] - p[0]) <= 3) { la += good[j][1]; lo += good[j][2]; n++; }
      return [p[0], la / n, lo / n, p[3]];
    });
    for (const p of sm) {
      if (!anchor) { anchor = p; curve.push([p[0], 0]); continue; }
      const d = hav(anchor, p), dt = Math.max(1, p[0] - anchor[0]);
      if (d / dt > 12) continue;
      if (d >= Math.max(4, 0.6 * Math.max(p[3], anchor[3]))) { dist += d; anchor = p; }
      curve.push([p[0], dist]);
    }
    return { curve, dist, good };
  }
  function at(curve, t) {   // linear interpolation of a monotone [[t, v]] curve
    if (!curve.length) return null;
    if (t <= curve[0][0]) return curve[0][1];
    if (t >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    let lo = 0, hi = curve.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (curve[m][0] <= t) lo = m; else hi = m; }
    const a = curve[lo], b = curve[hi];
    return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  }
  function median(xs) { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

  /** Stops = gaps without steps (≥ STOP_GAP_S), unless GPS shows movement there. Without steps: GPS-only. */
  function findStops(series, duration, gps) {
    const stops = [];
    const moving = (t0, t1) => {   // GPS veto: moved ≥ 1.2 m/s over the gap with good fixes around it
      if (!gps || gps.curve.length < 2) return false;
      const near = (t) => gps.good.some((p) => Math.abs(p[0] - t) <= 5);
      if (!near(t0) || !near(t1)) return false;
      return (at(gps.curve, t1) - at(gps.curve, t0)) / Math.max(1, t1 - t0) >= 1.2;
    };
    if (series && series.length) {
      const pts = [[0, series[0][0] <= 2 ? series[0][1] : 0]].concat(series, [[duration, series[series.length - 1][1]]]);
      for (let i = 1; i < pts.length; i++) {
        const [t0, s0] = pts[i - 1], [t1, s1] = pts[i], dt = t1 - t0;
        if (dt >= STOP_GAP_S && (s1 - s0) / dt < 0.3) {
          const a = t0 + (i === 1 ? 0 : 1), b = t1 - (i === pts.length - 1 ? 0 : 1);
          if (b - a >= STOP_GAP_S - 2 && !moving(a, b)) stops.push([a, b]);
        }
      }
    } else if (gps && gps.good.length > 10) {
      // no step data: standing = < 7 m in 15 s
      let start = null;
      for (let t = 0; t <= duration; t += 5) {
        const d = at(gps.curve, Math.min(duration, t + 15)) - at(gps.curve, t);
        if (d < 7) { if (start === null) start = t; } else if (start !== null) { if (t + 10 - start >= 15) stops.push([start, t + 10]); start = null; }
      }
      if (start !== null && duration - start >= 15) stops.push([start, duration]);
    }
    // merge overlaps
    const out = [];
    for (const s of stops.sort((a, b) => a[0] - b[0])) { const l = out[out.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else out.push(s.slice()); }
    return out;
  }
  function stoppedWithin(stops, t0, t1) { let s = 0; for (const [a, b] of stops) s += Math.max(0, Math.min(b, t1) - Math.max(a, t0)); return s; }
  /** run intervals with pauses cut out, in order */
  function movingIntervals(t0, t1, stops) {
    const iv = [];
    let from = t0;
    for (const [a, b] of stops) {
      if (b <= t0 || a >= t1) continue;
      const lo = Math.max(a, t0), hi = Math.min(b, t1);
      if (lo > from) iv.push([from, lo]);
      from = Math.max(from, hi);
    }
    if (t1 > from) iv.push([from, t1]);
    return iv;
  }
  /** change in a monotone [[t, v]] curve over the parts of [t0, t1] that fall inside pauses */
  function deltaWithin(curve, stops, t0, t1) {
    let s = 0;
    if (!curve || !curve.length) return 0;
    for (const [a, b] of stops) {
      const lo = Math.max(a, t0), hi = Math.min(b, t1);
      if (hi > lo) s += at(curve, hi) - at(curve, lo);
    }
    return s;
  }

  function crossTime(series, target) {   // time when cumulative steps reach `target`
    for (let i = 0; i < series.length; i++) {
      if (series[i][1] >= target) {
        if (i === 0) return series[0][0];
        const [t0, s0] = series[i - 1], [t1, s1] = series[i];
        return s1 === s0 ? t1 : t0 + (t1 - t0) * (target - s0) / (s1 - s0);
      }
    }
    return null;
  }

  // ---------------- v1.7: run segmentation (approach / run / pauses / cooldown) ----------------
  // The run is NOT «Старт»→«Стоп»: it is found from the data. Running = cadence ≥ RUN_CAD and GPS speed ≥ RUN_SPEED
  // (each falls back to the other when it is missing: GPS poor / step counter lag), sustained ≥ MIN_RUN_S.
  const SEG = { V: 1, RUN_CAD: 135, STRONG_CAD: 150, RUN_SPEED: 1.7, SPEED_ALONE: 2.0, MIN_RUN_S: 40, GAP_MERGE_S: 90, BIN_S: 5,
    WIN_CAD_S: 20, WIN_SPD_S: 30, PAUSE_MIN_S: 6, MOTION_PAUSE_MIN_S: 5, EXCL_S: 7, CAL_EDGE_S: 10 };

  /** cumulative steps at t from a series [[t, steps]]; null before the first event (step-counter lag = unknown) */
  function stepsFn(series, duration) {
    if (!series.length) return () => null;
    const pts = series.concat([[Math.max(duration, series[series.length - 1][0]), series[series.length - 1][1]]]);
    const t0 = series[0][0];
    return (t) => (t < t0 - 0.001 ? null : at(pts, t));
  }
  function nearest(arr, t, maxD) {   // [[t, ...]] sorted
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m][0] <= t) lo = m; else hi = m; }
    const a = arr[lo], b = arr[hi], x = Math.abs(a[0] - t) <= Math.abs(b[0] - t) ? a : b;
    return Math.abs(x[0] - t) <= maxD ? x : null;
  }
  /** GPS speed (m/s) around t over `win` s; null when there are no good fixes at the window ends */
  function gpsSpeedAt(gps, t, win) {
    if (!gps || gps.curve.length < 2 || !gps.good.length) return null;
    const f0 = gps.good[0][0], f1 = gps.good[gps.good.length - 1][0];
    const a = Math.max(f0, t - win / 2), b = Math.min(f1, t + win / 2);
    if (b - a < win / 2) return null;
    const near = (x) => nearest(gps.good, x, 6) != null;
    if (!near(a) || !near(b)) return null;
    return (at(gps.curve, b) - at(gps.curve, a)) / (b - a);
  }
  /** one bin: is it running? {run: true|false|null, cad, spd} */
  function binState(c, S, gps, motion, duration) {
    const W = SEG.WIN_CAD_S / 2;
    let cad = null, src = null;
    const a = Math.max(0, c - W), b = Math.min(duration, c + W);
    if (b - a >= W) {
      const sa = S(a), sb = S(b);
      if (sa != null && sb != null) { cad = (sb - sa) * 60 / (b - a); src = 'steps'; }
    }
    if (cad == null && motion) { const m = nearest(motion, c, 7); if (m && m[1] != null) { cad = m[1]; src = 'motion'; } }
    const spd = gpsSpeedAt(gps, c, SEG.WIN_SPD_S);
    let run;
    if (cad == null && spd == null) run = null;
    else if (cad == null) run = spd >= SEG.SPEED_ALONE;
    else if (spd == null) run = cad >= SEG.RUN_CAD;
    else if (cad >= SEG.RUN_CAD) run = spd >= SEG.RUN_SPEED || (cad >= SEG.STRONG_CAD && spd >= 0.6);
    else run = cad >= 100 && spd >= 2.4;     // fast jog with a few counter-batching misses
    return { c, run, cad, spd, src };
  }
  function mergeIntervals(iv, gap) {
    const out = [];
    for (const x of iv.slice().sort((p, q) => p[0] - q[0])) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + (gap || 0)) l[1] = Math.max(l[1], x[1]); else out.push(x.slice()); }
    return out;
  }
  // The live pause detector (RunVoice) announces after a 5 s mean of Doppler < 0.8 m/s has itself been
  // held for 5 s, plus any deceleration — about 15 s after the runner actually stopped. The spoken
  // «приостановлена» stays at detection time; the recorded pause starts at that real stop.
  const PAUSE_LOOKBACK_S = 25;   // 5 s mean + 5 s still-streak + margin for a gradual slowdown
  /** GPS speed around t over `win` s, from raw good fixes (not the 4 m gated curve, which keeps updating into a slow stop). */
  function rawSpeedAt(good, t, win) {
    if (!good || good.length < 2) return null;
    const pa = nearest(good, t - win / 2, 4), pb = nearest(good, t + win / 2, 4);
    if (!pa || !pb || pb[0] - pa[0] < win * 0.5) return null;
    return hav(pa, pb) / (pb[0] - pa[0]);
  }
  /** 5-sample mean of raw speed ending at t (same shape as the live spd5); null when too few fixes. */
  function rawSpd5(good, t) {
    let s = 0, c = 0;
    for (let k = t - 4; k <= t; k++) { const v = rawSpeedAt(good, k, 2); if (v != null) { s += v; c++; } }
    return c >= 3 ? s / c : null;
  }
  /**
   * Move a pause's start back to the second after the last still-running 5 s speed (or cadence)
   * inside the detection window. Resume (`b`) is left unchanged. If nothing run-like is found,
   * the detected start is kept (already close when it came from a step gap).
   */
  function refinePauseStart(series, gps, duration, a, b) {
    const lo = Math.max(0, a - PAUSE_LOOKBACK_S);
    let lastRun = null;
    const good = gps && gps.good;
    if (good && good.length >= 2) {
      for (let t = lo; t <= a; t++) { const v = rawSpd5(good, t); if (v != null && v >= SEG.RUN_SPEED) lastRun = t; }
    }
    if (lastRun == null && series && series.length) {
      const ev = [[lo, null]].concat(series.filter((p) => p[0] <= a && p[0] >= lo - 12));
      for (let i = 1; i < ev.length; i++) {
        const t0 = ev[i - 1][0], t1 = ev[i][0], s0 = ev[i - 1][1], s1 = ev[i][1], dt = t1 - t0;
        if (s0 == null || dt <= 0 || dt > 12) continue;
        if ((s1 - s0) * 60 / dt >= SEG.RUN_CAD) lastRun = t1;
      }
    }
    if (lastRun == null) return a;
    const start = lastRun + 1;
    if (start >= b - 3) return a;
    return Math.min(a, Math.max(lo, start));
  }
  /** pauses inside [t0,t1]: no steps (≥ STOP_GAP_S), GPS standing still (≥ PAUSE_MIN_S) or phone-motion standing (≥ MOTION_PAUSE_MIN_S) */
  function findPauses(series, duration, gps, motion, S, t0, t1) {
    const iv = [];
    for (const [a, b] of findStops(series, duration, gps)) { const x = Math.max(a, t0), y = Math.min(b, t1); if (y - x >= 5) iv.push([x, y]); }
    if (motion && motion.length) {
      let st = null;
      for (const m of motion) {
        const still = m[2] != null && m[2] < MOTION_STILL_G && (m[1] == null || m[1] === 0);
        const a = m[0] - 2.5, b = m[0] + 2.5;
        if (still && b > t0 && a < t1) { if (st == null) st = Math.max(a, t0); } else if (st != null) { const e = Math.min(m[0] - 2.5, t1); if (e - st >= SEG.MOTION_PAUSE_MIN_S) iv.push([st, e]); st = null; }
      }
      if (st != null && t1 - st >= SEG.MOTION_PAUSE_MIN_S) iv.push([st, t1]);
    } else if (gps && gps.curve.length > 10) {
      const hasFix = (t) => nearest(gps.good, t, 3) != null;
      let st = null;
      const flat = (t) => hasFix(t) && at(gps.curve, t + 3) - at(gps.curve, t - 3) < 2.5;
      for (let t = Math.ceil(t0); t <= t1 + 1; t++) {
        if (t <= t1 && flat(t)) { if (st == null) st = t; }
        else if (st != null) {
          const a = st, b = t - 1;
          if (b - a >= SEG.PAUSE_MIN_S) {
            const sa = S(Math.max(0, a - 10)), sb = S(Math.min(duration, b + 10));
            const cad = sa != null && sb != null && b + 10 - Math.max(0, a - 10) > 0 ? (sb - sa) * 60 / (Math.min(duration, b + 10) - Math.max(0, a - 10)) : null;
            if (cad == null || cad < SEG.STRONG_CAD) iv.push([a, b]);
          }
          st = null;
        }
      }
    }
    const refined = iv.map((x) => [refinePauseStart(series, gps, duration, x[0], x[1]), x[1]]);
    return mergeIntervals(refined, 3).filter((x) => x[1] - x[0] >= 5).map((x) => [Math.round(x[0] * 10) / 10, Math.round(x[1] * 10) / 10]);
  }
  const MOTION_STILL_G = 0.04;
  /**
   * Run boundaries. Returns {v, src: 'auto'|'override'|'whole'|'none', t0, t1, approach_s, cooldown_s, pauses, conf, bins}
   * w: {type, duration_s, step_series, track, motion?, run_override?: [t0|null, t1|null], pause_override?: [[t0,t1], ...]}
   * pause_override, when an array (including empty), replaces auto-detected pauses and is not back-shifted.
   */
  function segment(w, pre) {
    const duration = w.duration_s || 0;
    const series = pre && pre.series || (w.step_series || []).filter((p) => p && p.length >= 2);
    const gps = pre && pre.gps || gpsCurve(w.track);
    const S = stepsFn(series, duration);
    const motion = w.motion && w.motion.length ? w.motion : null;
    const out = { v: SEG.V, src: 'none', t0: 0, t1: duration, approach_s: 0, cooldown_s: 0, pauses: [], conf: null };
    if (w.type && w.type !== 'run') {                       // walks / workouts: the whole record, legacy stops
      out.src = 'whole';
      out.pauses = findStops(series, duration, gps).map((x) => [x[0], x[1]]);
      return out;
    }
    const bins = [];
    for (let c = 0; c <= duration + 0.001; c += SEG.BIN_S) bins.push(binState(c, S, gps, motion, duration));
    // runs of running bins, merged over gaps ≤ GAP_MERGE_S; a group needs ≥ MIN_RUN_S of running
    const blocks = []; let cur = null;
    for (const b of bins) {
      if (b.run) { if (!cur) cur = [b.c, b.c]; else cur[1] = b.c; } else if (cur) { blocks.push(cur); cur = null; }
    }
    if (cur) blocks.push(cur);
    const groups = [];
    for (const bl of blocks) {
      const l = groups[groups.length - 1];
      if (l && bl[0] - l.end <= SEG.GAP_MERGE_S) { l.end = bl[1]; l.run += bl[1] - bl[0] + SEG.BIN_S; } else groups.push({ start: bl[0], end: bl[1], run: bl[1] - bl[0] + SEG.BIN_S });
    }
    const good = groups.filter((g) => g.run >= SEG.MIN_RUN_S);
    const ov = Array.isArray(w.run_override) ? w.run_override : null;
    if (good.length) {
      // a window of WIN_CAD_S/2 on each side leaks into the neighbours: the first/last running bin centre sits ~10 s inside
      const H = SEG.WIN_CAD_S / 2;
      out.t0 = Math.max(0, good[0].start - H); out.t1 = Math.min(duration, good[good.length - 1].end + H);
      out.src = 'auto';
      const withBoth = bins.filter((b) => b.run != null && b.cad != null && b.spd != null);
      const agree = withBoth.filter((b) => b.run === (b.cad >= SEG.RUN_CAD)).length;
      const known = bins.filter((b) => b.run != null).length / Math.max(1, bins.length);
      out.conf = withBoth.length >= bins.length * 0.6 && agree / withBoth.length > 0.9 ? 'high' : known > 0.7 ? 'medium' : 'low';
      out.cad_src = bins.filter((b) => b.src === 'motion').length > bins.filter((b) => b.src === 'steps').length ? 'motion' : 'steps';
    } else out.src = 'none';   // never ran: the whole record counts (nothing to cut)
    if (ov) {
      if (ov[0] != null && isFinite(ov[0])) out.t0 = Math.max(0, Math.min(duration, ov[0]));
      if (ov[1] != null && isFinite(ov[1])) out.t1 = Math.max(0, Math.min(duration, ov[1]));
      if (out.t1 < out.t0 + 10) { out.t0 = 0; out.t1 = duration; }
      out.src = 'override';
    }
    out.t0 = Math.round(out.t0 * 10) / 10; out.t1 = Math.round(out.t1 * 10) / 10;
    out.approach_s = Math.round(out.t0); out.cooldown_s = Math.round(Math.max(0, duration - out.t1));
    // manual pauses always win: the auto detector (and the 15 s start back-shift) must not move them
    if (Array.isArray(w.pause_override)) out.pauses = applyPauseOverride(w.pause_override, out.t0, out.t1);
    else out.pauses = findPauses(series, duration, gps, motion, S, out.t0, out.t1);
    return out;
  }
  /** Clip, order and merge a user-supplied pause list; empty means «no pauses». */
  function applyPauseOverride(raw, t0, t1) {
    const iv = [];
    for (const p of raw || []) {
      if (!p || p.length < 2) continue;
      const a = Math.max(t0, Math.min(t1, +p[0])), b = Math.max(t0, Math.min(t1, +p[1]));
      if (isFinite(a) && isFinite(b) && b - a >= 1) iv.push([Math.min(a, b), Math.max(a, b)]);
    }
    return mergeIntervals(iv, 0).map((x) => [Math.round(x[0] * 10) / 10, Math.round(x[1] * 10) / 10]);
  }

  /**
   * @param w {duration_s, steps, stride_m, step_series, track}
   * @returns summary fields + profiles
   */
  function analyze(w) {
    const duration = w.duration_s || 0, stride = w.stride_m || 0.75;
    const series = (w.step_series || []).filter((p) => p && p.length >= 2);
    const steps = Math.max(w.steps || 0, series.length ? series[series.length - 1][1] : 0);
    const gps = gpsCurve(w.track);
    const seg = segment(w, { series, gps });
    const R0 = seg.t0, R1 = seg.t1, runLen = Math.max(0, R1 - R0);
    const stops = seg.pauses;
    const S = stepsFn(series, duration);
    const stepsSpan = series.length ? Math.max(0, (S(R1) != null ? S(R1) : 0) - (S(R0) != null ? S(R0) : 0)) : steps;
    const stepsRun = series.length ? Math.max(0, Math.round(stepsSpan - deltaWithin(series, stops, R0, R1))) : steps;
    const stop_s = Math.round(stops.reduce((x, [a, b]) => x + (b - a), 0));
    const moving_s = Math.max(0, Math.round(runLen - stop_s));
    const step_distance_m = Math.round(stepsRun * stride);

    // GPS quality
    const goodAcc = gps.good.map((p) => p[3]);
    let covered = 0;
    for (let i = 1; i < gps.good.length; i++) { const dt = gps.good[i][0] - gps.good[i - 1][0]; if (dt <= 10) covered += dt; }
    const coverage = duration > 0 ? Math.min(1, covered / Math.max(1, duration)) : 0;
    const gps_acc = goodAcc.length ? Math.round(median(goodAcc) * 10) / 10 : null;
    const gps_total_m = gps.good.length >= 2 ? Math.round(gps.dist) : null;
    const gps_distance_m = gps.good.length >= 2 ? Math.round(Math.max(0, at(gps.curve, R1) - at(gps.curve, R0) - deltaWithin(gps.curve, stops, R0, R1))) : null;
    const gps_ok = gps.good.length >= 30 && coverage >= 0.8 && gps_acc !== null && gps_acc <= 20 && (gps_total_m || 0) >= 200;

    // 100-step segments over moving parts of the run only (a pause must not become a 300 km/h block)
    // [t_start, t_end, steps, dist_by_steps_m, dist_gps_m|null, moving_s]
    const segments = [];
    if (series.length) {
      for (const [a, b] of movingIntervals(R0, R1, stops)) {
        const sA = S(a) != null ? S(a) : 0;
        const sB = S(b) != null ? S(b) : sA;
        if (sB - sA < 30 || b <= a) continue;
        let prevT = a, prevS = sA;
        for (let k = Math.floor(sA / SEG_STEPS) * SEG_STEPS + SEG_STEPS; k <= sB; k += SEG_STEPS) {
          const t = crossTime(series, k);
          if (t == null || t > b + 0.05) break;
          if (t < a - 0.05) continue;
          const tClamped = Math.min(b, Math.max(a, t));
          if (k - prevS >= 30) segments.push(seg100(prevT, tClamped, Math.round(k - prevS)));
          prevT = tClamped; prevS = k;
        }
        if (sB - prevS >= 30 && b > prevT) segments.push(seg100(prevT, b, Math.round(sB - prevS)));
      }
    }
    function seg100(t0, t1, n) {
      const mv = Math.max(0.1, (t1 - t0) - stoppedWithin(stops, t0, t1));
      const g = gps.curve.length >= 2 && gps_ok
        ? Math.round(Math.max(0, (at(gps.curve, t1) - at(gps.curve, t0)) - deltaWithin(gps.curve, stops, t0, t1)) * 10) / 10
        : null;
      return [Math.round(t0 * 10) / 10, Math.round(t1 * 10) / 10, n, Math.round(n * stride * 10) / 10, g, Math.round(mv * 10) / 10];
    }

    // cadence profile (steps/min) every 10 s over a 30 s window; 0 while stopped.
    // Only steps outside pauses go into the rate, otherwise a short pause on the edge of the window inflates cadence to 400+.
    const cadence = [];
    if (series.length) {
      const stepsAt = (t) => { if (t <= series[0][0]) return t < series[0][0] ? Math.min(series[0][1], 0) : series[0][1]; return Math.round(at(series, t)); };
      for (let t = 30; t <= duration; t += 10) {
        const stopped = stoppedWithin(stops, t - 30, t);
        const n = stepsAt(t) - stepsAt(t - 30);
        const nPause = Math.round(deltaWithin(series, stops, t - 30, t));
        const nMov = Math.max(0, n - nPause);
        const movingWin = 30 - stopped;
        cadence.push([t, stopped >= 20 || movingWin < 10 ? 0 : Math.round(nMov * 60 / Math.max(10 / 1, movingWin))]);
      }
    }
    // step-counter start lag: the first event can arrive 15–20 s after «Старт»; steps before it are lost except the few it
    // reports itself. v1.7: it matters only if the RUN already started inside that lag (R0 < lag) — then the steps between R0 and the
    // first event are estimated from the GPS distance covered meanwhile ÷ the steady stride of the rest of the run.
    let lag_s = 0, steps_start_missed = 0, steps_start_src = null;
    if (series.length && series[0][0] > 3) {
      lag_s = series[0][0];
      if (R0 < lag_s - 3) {
        const first = series[0][1];
        const t2 = Math.min(R1, lag_s + 60);
        const rate = t2 - lag_s >= 20 ? (Math.round(at(series, t2)) - first) / (t2 - lag_s) : 0;
        let est = 0;
        if (gps.curve.length >= 2 && gps_ok) {
          const lagDist = at(gps.curve, lag_s) - at(gps.curve, R0);
          const restSteps = (S(R1) != null ? S(R1) : steps) - first, restDist = at(gps.curve, R1) - at(gps.curve, lag_s);
          const stride0 = restSteps >= 100 && restDist > 50 ? restDist / restSteps : null;
          if (stride0 && stride0 > 0.3 && stride0 < 2.5) { est = lagDist / stride0; steps_start_src = 'gps'; }
          else {
            const mvSpeed = gps_distance_m / Math.max(1, moving_s);
            const frac = mvSpeed > 0 ? Math.max(0, Math.min(1, (lagDist / Math.max(1, lag_s - R0)) / mvSpeed)) : 1;
            est = rate * (lag_s - R0) * frac; steps_start_src = 'pace';
          }
          if (rate > 0) est = Math.min(est, rate * (lag_s - R0) * 1.5);
        }
        steps_start_missed = Math.max(0, Math.round(est - first));
        if (!steps_start_missed) steps_start_src = null;
      }
    }
    const cadRaw = moving_s >= 30 && stepsRun > 0 ? Math.round((stepsRun + steps_start_missed) / (moving_s / 60)) : null;
    const cadence_avg = cadRaw != null && cadRaw <= 400 ? cadRaw : null;   // the server rejects > 400 and would then refuse the whole sync
    const steps_run = stepsRun + steps_start_missed;
    const steps_adj = steps + steps_start_missed;
    const step_distance_adj_m = Math.round(steps_run * stride);
    const distance_m = gps_ok ? gps_distance_m : step_distance_adj_m;
    // stride calibration: only «clean» stretches of the run — no first/last CAL_EDGE_S, no ±EXCL_S around pauses, no step-counter lag
    const clean = []; {
      let a = R0 + SEG.CAL_EDGE_S; if (lag_s > 0) a = Math.max(a, lag_s + 5);
      const b0 = R1 - SEG.CAL_EDGE_S;
      let from = a;
      for (const [pa, pb] of stops) {
        const lo = pa - SEG.EXCL_S, hi = pb + SEG.EXCL_S;
        if (lo - from >= 20) clean.push([from, Math.min(lo, b0)]);
        from = Math.max(from, hi);
      }
      if (b0 - from >= 20) clean.push([from, b0]);
    }
    let cal_steps = null, cal_gps_m = null;
    if (gps_ok && series.length) {
      let cs = 0, cg = 0;
      for (const [a, b] of clean) {
        if (b <= a || S(a) == null || S(b) == null) continue;
        cs += S(b) - S(a); cg += at(gps.curve, b) - at(gps.curve, a);
      }
      if (cs >= 100) { cal_steps = Math.round(cs); cal_gps_m = Math.round(cg); }
    }
    const gps_stride_m = cal_steps >= 100 ? Math.round(cal_gps_m / cal_steps * 1000) / 1000
      : gps_ok && steps_run >= 100 ? Math.round(gps_distance_m / steps_run * 1000) / 1000 : null;
    const seg_out = { v: seg.v, src: seg.src, conf: seg.conf, t0: R0, t1: R1, approach_s: seg.approach_s, cooldown_s: seg.cooldown_s, pauses: stops,
      run_s: Math.round(runLen), moving_s, steps_run, steps_total: steps, gps_run_m: gps_distance_m, gps_total_m, cad_src: seg.cad_src || 'steps' };
    return { duration_s: Math.round(duration), moving_s, stop_s, stops: stops.length, stop_list: stops, step_distance_m, steps, steps_run,
      gps_distance_m, gps_total_m, gps_ok, gps_acc, gps_coverage: Math.round(coverage * 100) / 100, gps_stride_m, seg: seg_out,
      distance_m, cadence_avg, segments, cadence, lag_s, steps_start_missed, steps_start_src, steps_adj, step_distance_adj_m, cal_steps, cal_gps_m,
      pace_s_km: distance_m > 50 && moving_s > 0 ? Math.round(moving_s / (distance_m / 1000)) : null,
      gps_pace_s_km: gps_distance_m > 50 && moving_s > 0 ? Math.round(moving_s / (gps_distance_m / 1000)) : null,
      step_pace_s_km: step_distance_adj_m > 50 && moving_s > 0 ? Math.round(moving_s / (step_distance_adj_m / 1000)) : null };
  }

  // ---------------- heart-rate recovery ----------------
  const HRR_MIN = [1, 2, 3, 5, 10];
  /**
   * Recovery after a workout from the HR session.
   * @param w {duration_s, session_samples: [[sec relative to workout start (negative = before), bpm]]}
   */
  /** [t0, t1] of the run in seconds from «Старт» (v1.7 segmentation); the whole record for old / non-run workouts */
  function runBounds(w) {
    const sg = w && w.seg;
    if (sg && sg.t0 != null && sg.t1 != null && sg.t1 > sg.t0) return [sg.t0, sg.t1];
    return [0, (w && w.duration_s) || 0];
  }
  function recovery(w) {
    const [RS, D] = runBounds(w);
    const cut = w.tail_cut != null ? w.tail_cut : Infinity, mask = (w.quality && w.quality.mask) || [];
    const masked = (t) => mask.some((m) => t >= m[0] && t <= m[1]);
    const ss = (w.session_samples || []).filter((p) => p && p.length >= 2 && p[1] >= 25 && p[1] <= 250 && p[0] < cut && !masked(p[0])).slice().sort((a, b) => a[0] - b[0]);
    if (!ss.length || D <= 0) return null;
    const pre = ss.filter((p) => p[0] < 0), run = ss.filter((p) => p[0] >= RS && p[0] <= D);
    const post = ss.filter((p) => p[0] > D).map((p) => [p[0] - D, p[1]]);
    const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const win = (arr, t0, t1) => { const out = []; for (const p of arr) { if (p[0] > t1) break; if (p[0] >= t0) out.push(p[1]); } return out; };
    const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

    // before the start: resting/warm-up baseline = lowest 60-s mean (needs ≥ 2 min of data)
    const pre_s = pre.length ? Math.round(-pre[0][0]) : 0;
    let baseline = null;
    if (pre_s >= 120) {
      for (let t = pre[0][0]; t + 60 <= 0; t += 10) {
        const xs = win(pre, t, t + 60);
        if (xs.length >= 20) { const m = mean(xs); if (baseline === null || m < baseline) baseline = m; }
      }
    }
    // back-to-back run: «before» is the rest after the previous run — use the session's real pre-run baseline instead
    const inh = w.inherit || null;
    if (inh) baseline = inh.baseline != null ? inh.baseline : null;
    const pre_median = pre.length >= 10 ? median(pre.map((p) => p[1])) : null;
    const pre_last = pre.length ? mean(win(pre, -60, 0)) : null;   // just before the start

    const hr_peak = run.length ? Math.max(...run.map((p) => p[1])) : null;
    const endWin = win(run, D - 10, D).concat(post.filter((p) => p[0] <= 3).map((p) => p[1]));
    const hr_end = endWin.length ? Math.max(...endWin) : null;
    const post_s = post.length ? Math.round(post[post.length - 1][0]) : 0;
    const res = { hr_end, hr_peak, baseline: r1(baseline), pre_median: r1(pre_median), pre_last: r1(pre_last), pre_s, post_s,
      hrr: {}, hr_at: {}, t_below_100: null, t_below_base10: null, tau: null, hr_ss: null, fit_r2: null, final_post: null,
      gaps: 0, max_gap_s: 0, post_ok: false, repeat: !!inh, repeat_of: inh ? inh.of : null, masked_s: (w.quality && w.quality.masked_s) || 0 };
    if (hr_end == null || post.length < 10) return res;

    // gaps / disconnects in the first 10 minutes
    let prevT = 0;
    for (const p of post) { if (p[0] > 600) break; const g = p[0] - prevT; if (g > 10) { res.gaps++; res.max_gap_s = Math.max(res.max_gap_s, Math.round(g)); } prevT = p[0]; }
    res.post_ok = post_s >= 60 && post[0][0] <= 15;

    for (const k of HRR_MIN) {
      const t = k * 60; if (post_s < t - 5) continue;
      const xs = win(post, t - 5, t + 5);
      if (!xs.length) continue;   // gap at this moment
      const v = mean(xs);
      res.hr_at[k] = r1(v); res.hrr[k] = r1(hr_end - v);
    }
    // threshold times on a 15-s mean
    for (let t = 0; t <= post_s; t += 5) {
      const xs = win(post, t - 7, t + 7); if (xs.length < 3) continue;
      const v = mean(xs);
      if (res.t_below_100 === null && v < 100) res.t_below_100 = t;
      if (res.t_below_base10 === null && baseline !== null && v < baseline + 10) res.t_below_base10 = t;
    }
    // exponential fit HR(t) = hr_ss + A·exp(-t/τ) over the first ≤ 10 min (5-s bins; gaps skipped)
    const bins = [];
    for (let t = 0; t <= Math.min(600, post_s); t += 5) { const xs = win(post, t, t + 5); if (xs.length) bins.push([t + 2.5, mean(xs)]); }
    if (bins.length >= 20 && post_s >= 120) {
      let best = null;
      for (let tau = 10; tau <= 1200; tau *= 1.04) {
        const xs = bins.map((b) => Math.exp(-b[0] / tau)), ys = bins.map((b) => b[1]);
        const mx = mean(xs), my = mean(ys);
        let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
        if (sxx <= 0) continue;
        const A = sxy / sxx, c = my - A * mx;
        let sse = 0; for (let i = 0; i < xs.length; i++) sse += (ys[i] - (c + A * xs[i])) ** 2;
        if (A > 0 && (!best || sse < best.sse)) best = { tau, A, c, sse };
      }
      if (best) {
        const my = mean(bins.map((b) => b[1])); const sst = bins.reduce((x, b) => x + (b[1] - my) ** 2, 0);
        res.tau = Math.round(best.tau); res.hr_ss = r1(best.c); res.fit_A = r1(best.A); res.fit_r2 = sst > 0 ? Math.round((1 - best.sse / sst) * 100) / 100 : null;
      }
    }
    if (post_s >= 300) res.final_post = r1(mean(win(post, post_s - 120, post_s)));
    return res;
  }
  /** Compact metrics for storage on the workout record. */
  function recoverySummary(r) {
    if (!r) return null;
    const o = { hr_end: r.hr_end, hr_peak: r.hr_peak, baseline: r.baseline, pre_s: r.pre_s, post_s: r.post_s, tau: r.tau, hr_ss: r.hr_ss,
      fit_r2: r.fit_r2, final_post: r.final_post, t_below_100: r.t_below_100, t_below_base10: r.t_below_base10, gaps: r.gaps };
    if (r.repeat) o.repeat = 1;
    for (const k of HRR_MIN) o['hrr' + k] = r.hrr[k] != null ? r.hrr[k] : null;
    return o;
  }

  // ---------------- HRV from RR intervals ----------------
  /** Clean RR: physiological range + reject jumps >20% vs the local median of neighbours (ectopics / missed beats). */
  function cleanRR(rr) {
    const xs = (rr || []).filter((p) => p && p.length >= 2 && p[1] >= 300 && p[1] <= 2000).slice().sort((a, b) => a[0] - b[0]);
    const out = []; let rejected = 0;
    for (let i = 0; i < xs.length; i++) {
      const nb = []; for (let j = Math.max(0, i - 5); j <= Math.min(xs.length - 1, i + 5); j++) if (j !== i) nb.push(xs[j][1]);
      const m = nb.length ? median(nb) : xs[i][1];
      if (Math.abs(xs[i][1] - m) > 0.2 * m) { rejected++; continue; }
      out.push(xs[i]);
    }
    return { rr: out, rejected, total: xs.length };
  }
  /** Time-domain HRV for [time, rr_ms] pairs (already cleaned). Successive differences only between adjacent beats. */
  function hrvStats(pts) {
    if (!pts || pts.length < 20) return null;
    const v = pts.map((p) => p[1]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
    let ss = 0, n = 0, nn50 = 0;
    for (let i = 1; i < pts.length; i++) {
      // adjacent only: the gap between beat times must be ~ the RR itself (no dropped beats between)
      if (pts[i][0] - pts[i - 1][0] > (pts[i][1] / 1000) * 1.5 + 0.05) continue;
      const d = pts[i][1] - pts[i - 1][1]; ss += d * d; n++; if (Math.abs(d) > 50) nn50++;
    }
    if (n < 10) return null;
    const rmssd = Math.sqrt(ss / n);
    const r1 = (x) => Math.round(x * 10) / 10;
    // v1.6.1: segment SDNN (mean SD of 60-s segments) — the drift of the mean HR over 5 min (calming down, walking to the
    // start) no longer inflates it; whole-window SD stays as sdnn_total
    const segs = []; let i0 = 0;
    for (let i = 1; i <= pts.length; i++) {
      if (i === pts.length || pts[i][0] - pts[i0][0] >= 60) {
        const seg = v.slice(i0, i);
        if (seg.length >= 20) { const m = seg.reduce((a, b) => a + b, 0) / seg.length; segs.push(Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / (seg.length - 1))); }
        i0 = i;
      }
    }
    const sdSeg = segs.length ? segs.reduce((a, b) => a + b, 0) / segs.length : sd;
    return { n: pts.length, rmssd: r1(rmssd), ln_rmssd: rmssd > 0 ? Math.round(Math.log(rmssd) * 100) / 100 : null, sdnn: r1(sdSeg), sdnn_total: r1(sd), pnn50: r1(nn50 / n * 100),
      mean_rr: Math.round(mean), hr: r1(60000 / mean) };
  }
  /**
   * HRV around a workout.
   * @param w {duration_s, session_rr: [[beat time, sec relative to workout start; rr ms]]}
   * Windows: pre = last ≤5 min before the start (needs ≥2 min of clean beats);
   * post5_10 = 5–10 min after the finish; post_end = last 5 min of the post-run recording (≥15 min after the finish).
   */
  function hrv(w) {
    const D = runBounds(w)[1];
    const cut = w.tail_cut != null ? w.tail_cut : Infinity, mask = (w.quality && w.quality.mask) || [];
    const c = cleanRR((w.session_rr || []).filter((p) => p[0] < cut && !mask.some((m) => p[0] >= m[0] && p[0] <= m[1])));
    if (c.total < 30) return null;
    const pts = c.rr;
    const sel = (t0, t1) => pts.filter((p) => p[0] >= t0 && p[0] < t1);
    const span = (xs) => xs.length > 1 ? xs[xs.length - 1][0] - xs[0][0] : 0;
    const res = { artifacts_pct: Math.round(c.rejected / c.total * 1000) / 10, beats: c.total, pre: null, post5_10: null, post_end: null, series: [] };
    const preAll = pts.filter((p) => p[0] < 0);
    if (preAll.length) {
      const end = Math.min(0, preAll[preAll.length - 1][0] + 1);
      // skip the last 30 s before the start (people jog in place / walk to the start line)
      const xs = sel(end - 330, end - 30);
      if (span(xs) >= 120) res.pre = Object.assign(hrvStats(xs) || {}, { t0: Math.round(xs[0][0]), t1: Math.round(xs[xs.length - 1][0]) });
      if (res.pre && res.pre.rmssd == null) res.pre = null;
    }
    if (w.inherit) res.pre = w.inherit.hrv_pre ? Object.assign({}, w.inherit.hrv_pre, { inherited: true }) : null;
    const post = pts.filter((p) => p[0] > D);
    if (post.length) {
      const xs = sel(D + 300, D + 600);
      if (span(xs) >= 150) res.post5_10 = hrvStats(xs);
      const last = post[post.length - 1][0];
      if (last - D >= 900) { const ys = sel(last - 300, last + 1); if (span(ys) >= 150) res.post_end = hrvStats(ys); }
    }
    // rolling RMSSD (60-s window every 15 s) for the chart
    if (pts.length) {
      const t0 = Math.ceil(pts[0][0] / 15) * 15, t1 = pts[pts.length - 1][0];
      let lo = 0;
      for (let t = t0; t <= t1; t += 15) {
        while (lo < pts.length && pts[lo][0] < t - 30) lo++;
        const xs = []; for (let i = lo; i < pts.length && pts[i][0] < t + 30; i++) xs.push(pts[i]);
        if (xs.length < 25) continue;
        const st = hrvStatsLite(xs); if (st != null) res.series.push([t, st]);
      }
    }
    return res;
  }
  function hrvStatsLite(xs) {
    let ss = 0, n = 0;
    for (let i = 1; i < xs.length; i++) { if (xs[i][0] - xs[i - 1][0] > (xs[i][1] / 1000) * 1.5 + 0.05) continue; const d = xs[i][1] - xs[i - 1][1]; ss += d * d; n++; }
    return n >= 15 ? Math.round(Math.sqrt(ss / n) * 10) / 10 : null;
  }
  function hrvSummary(h) {
    if (!h) return {};
    const g = (o, k) => (o && o[k] != null ? o[k] : null);
    return { rmssd_pre: g(h.pre, 'rmssd'), sdnn_pre: g(h.pre, 'sdnn'), hr_pre_rr: g(h.pre, 'hr'), rmssd_post: g(h.post5_10, 'rmssd'),
      rmssd_post_end: g(h.post_end, 'rmssd'), rr_artifacts: h.artifacts_pct };
  }

  // ---------------- ECG: R-peak detection (Pan–Tompkins-lite) ----------------
  /** @param x Int16Array/array of µV at fs Hz. Returns sample indices of R peaks. Works on either polarity. */
  function rPeaks(x, fs) {
    fs = fs || 130;
    const n = x.length; if (n < fs * 2) return [];
    // band-pass ≈ 5–15 Hz: moving-average high-pass (remove baseline) then short low-pass
    const hp = new Float64Array(n), w1 = Math.round(fs * 0.2);
    let acc = 0; for (let i = 0; i < n; i++) { acc += x[i]; if (i >= w1) acc -= x[i - w1]; hp[i] = x[i] - acc / Math.min(i + 1, w1); }
    const lp = new Float64Array(n); for (let i = 2; i < n; i++) lp[i] = (hp[i] + 2 * hp[i - 1] + hp[i - 2]) / 4;
    // derivative, square, integrate over 150 ms
    const sq = new Float64Array(n); for (let i = 2; i < n - 2; i++) { const d = (2 * lp[i + 2] + lp[i + 1] - lp[i - 1] - 2 * lp[i - 2]) / 8; sq[i] = d * d; }
    const wi = Math.max(1, Math.round(0.15 * fs)), mwi = new Float64Array(n);
    acc = 0; for (let i = 0; i < n; i++) { acc += sq[i]; if (i >= wi) acc -= sq[i - wi]; mwi[i] = acc / wi; }
    // adaptive threshold over 2-s blocks
    const refr = Math.round(0.25 * fs), peaks = [];
    let spk = 0, npk = 0;
    const init = mwi.slice(0, fs * 2); spk = Math.max(...init) * 0.6; npk = spk * 0.15;
    let last = -refr;
    for (let i = 1; i < n - 1; i++) {
      if (!(mwi[i] > mwi[i - 1] && mwi[i] >= mwi[i + 1])) continue;
      const thr = npk + 0.3 * (spk - npk);
      if (mwi[i] > thr && i - last > refr) {
        // locate the actual R sample: largest |deviation| in the filtered signal within the window before the integrator peak
        let best = i, bv = -1;
        for (let j = Math.max(0, i - wi - 3); j <= Math.min(n - 1, i + 2); j++) { const v = Math.abs(lp[j]); if (v > bv) { bv = v; best = j; } }
        if (peaks.length && best - peaks[peaks.length - 1] < refr) { spk = 0.875 * spk + 0.125 * mwi[i]; continue; }
        peaks.push(best); last = i; spk = 0.875 * spk + 0.125 * mwi[i];
      } else npk = 0.875 * npk + 0.125 * mwi[i];
    }
    // refine to the local extremum of the raw signal (same polarity as the majority)
    let pos = 0; for (const p of peaks) if (lp[p] > 0) pos++;
    const sign = pos >= peaks.length / 2 ? 1 : -1, r = Math.round(0.04 * fs);
    return peaks.map((p) => { let b = p; for (let j = Math.max(0, p - r); j <= Math.min(n - 1, p + r); j++) if (sign * x[j] > sign * x[b]) b = j; return b; })
      .filter((p, i, a) => i === 0 || p - a[i - 1] >= refr);
  }
  /** Summary for an ECG strip from its R peaks. */
  function ecgStats(peaks, fs) {
    fs = fs || 130;
    const rr = []; for (let i = 1; i < peaks.length; i++) rr.push([peaks[i] / fs, Math.round((peaks[i] - peaks[i - 1]) * 1000 / fs)]);
    const c = cleanRR(rr), h = hrvStats(c.rr);
    const meanRR = rr.length ? rr.reduce((a, b) => a + b[1], 0) / rr.length : null;
    return { beats: peaks.length, hr_avg: meanRR ? Math.round(600000 / meanRR) / 10 : null, rmssd: h ? h.rmssd : null, sdnn: h ? h.sdnn : null,
      pnn50: h ? h.pnn50 : null, artifacts_pct: c.total ? Math.round(c.rejected / c.total * 1000) / 10 : null };
  }

  // ---------------- signal quality: cadence lock / double-counted beats ----------------
  /**
   * Chest straps on dry electrodes can lock onto running cadence (HR ≈ steps/min) and double-count beats
   * (RR alternating ~1:2). Returns masked stretches [[t0, t1]] in seconds relative to the workout start.
   * @param w {duration_s, samples [[t, bpm]], session_rr [[t, rr]]}, an = analyze(w)
   */
  function signalQuality(w, an) {
    const D = w.duration_s || 0, hr = (w.samples || []).filter((p) => p && p[1] >= 25);
    const rr = (w.session_rr || []).filter((p) => p[0] >= 0 && p[0] <= D);
    const cad = (an && an.cadence) || [];
    const win = [];
    let ri = 0;
    for (let t = 5; t <= D; t += 10) {
      const h = median(hr.filter((p) => p[0] >= t - 5 && p[0] < t + 5).map((p) => p[1]));
      let c = null, best = 1e9; for (const q of cad) { const d = Math.abs(q[0] - t); if (d < best) { best = d; c = q[1]; } }
      if (best > 20) c = null;
      while (ri < rr.length && rr[ri][0] < t - 5) ri++;
      const xs = []; for (let j = ri; j < rr.length && rr[j][0] < t + 5; j++) xs.push(rr[j][1]);
      let alt = 0; for (let j = 1; j < xs.length; j++) { const q = Math.max(xs[j], xs[j - 1]) / Math.max(1, Math.min(xs[j], xs[j - 1])); if (q >= 1.6 && q <= 2.5) alt++; }
      const altF = xs.length > 4 ? alt / (xs.length - 1) : 0;
      const nearCad = h != null && c != null && c >= 120 && Math.abs(h - c) <= 4;
      win.push({ t, h, c, altF, bad: (nearCad && (altF >= 0.05 || !rr.length)) || altF >= 0.2 });
    }
    // an implausible HR jump (≥25 bpm within 5 s) next to a bad window belongs to the artefact too
    for (let i = 0; i < hr.length - 1; i++) {
      const a = hr[i], b = hr.find((p) => p[0] > a[0] && p[0] <= a[0] + 5);
      if (b && Math.abs(b[1] - a[1]) >= 25) {
        const k = Math.min(win.length - 1, Math.max(0, Math.floor(a[0] / 10)));
        if (win[k] && ((win[k - 1] && win[k - 1].bad) || (win[k + 1] && win[k + 1].bad) || win[k].bad)) win[k].bad = true;
      }
    }
    // lone good windows between bad ones are bad too (lock flickers)
    for (let i = 1; i < win.length - 1; i++) if (!win[i].bad && win[i - 1].bad && win[i + 1].bad) win[i].fill = true;
    const mask = [];
    for (const x of win) {
      if (!x.bad && !x.fill) continue;
      const a = Math.max(0, x.t - 5), b = Math.min(D, x.t + 5), l = mask[mask.length - 1];
      if (l && a <= l[1] + 0.5) l[1] = b; else mask.push([a, b]);
    }
    const out = mask.filter((m) => m[1] - m[0] >= 20);
    const masked_s = Math.round(out.reduce((x, m) => x + m[1] - m[0], 0));
    const c = cleanRR(rr), rr_art = c.total ? Math.round(c.rejected / c.total * 1000) / 10 : null;
    const masked_pct = D > 0 ? Math.round(masked_s / D * 1000) / 10 : 0;
    const label = masked_pct >= 10 || (rr_art != null && rr_art >= 10) ? 'poor' : masked_pct > 0 || (rr_art != null && rr_art >= 3) ? 'fair' : 'good';
    return { mask: out, masked_s, masked_pct, rr_artifacts_pct: rr_art, label };
  }
  function hrStats(samples, mask, lo, hi) {
    const xs = (samples || []).filter((p) => p && p[1] >= 25 && p[1] <= 250 && (lo == null || p[0] >= lo) && (hi == null || p[0] <= hi) && !(mask || []).some((m) => p[0] >= m[0] && p[0] <= m[1])).map((p) => p[1]);
    if (!xs.length) return null;
    return { avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10, max: Math.max(...xs), min: Math.min(...xs) };
  }

  /** Strap taken off: beats go haywire for the last seconds. Returns the cut time (sec, workout-relative) or null. */
  function tailCut(rr, D) {
    const xs = (rr || []).filter((p) => p && p.length >= 2).slice().sort((a, b) => a[0] - b[0]);
    if (xs.length < 30) return null;
    const tEnd = xs[xs.length - 1][0];
    if (tEnd <= (D || 0)) return null;   // only after the finish
    let i0 = xs.findIndex((p) => p[0] >= tEnd - 90); if (i0 < 10) i0 = 10;
    const isArt = (j) => {
      const v = xs[j][1]; if (v < 300 || v > 2000) return true;
      const prev = []; for (let k = j - 1; k >= 0 && prev.length < 8; k--) { const u = xs[k][1]; if (u >= 300 && u <= 2000) prev.push(u); }
      const m = median(prev); return m != null && Math.abs(v - m) > 0.25 * m;
    };
    for (let j = i0; j < xs.length; j++) {
      if (!isArt(j)) continue;
      let n = 0; for (let k = j; k < Math.min(xs.length, j + 5); k++) if (isArt(k)) n++;
      // a cluster that lasts until the end of the recording
      let tailBad = 0, tailAll = 0; for (let k = j; k < xs.length; k++) { tailAll++; if (isArt(k)) tailBad++; }
      if (n >= 2 && tailBad / tailAll >= 0.4) return Math.round((xs[j][0] - xs[j][1] / 1000) * 10) / 10;
    }
    return null;
  }

  /** Previous workout in the same HR session that ended right before this one (back-to-back runs). */
  function previousInSession(w, list) {
    if (!w.session_start) return null;
    let best = null;
    for (const p of list || []) {
      if (!p || p.id === w.id || p.deleted || !p.ended_at || p.ended_at > w.started_at) continue;
      if (Math.abs(p.ended_at - w.session_start) <= 15000 && (!best || p.ended_at > best.ended_at)) best = p;
    }
    return best;
  }

  const ANALYSIS_V = 6;   // profiles, run distance and avg cadence skip steps/GPS inside pauses (no 300 km/h spikes)
  /**
   * Derived (re-computable) fields of a workout; raw data (samples, step_series, track, session_*) is never changed.
   * @param list all workouts (for back-to-back detection; previous ones should already be derived)
   */
  function derive(w, list) {
    const an = analyze(w);
    const q = signalQuality(w, an);
    const [R0, R1] = [an.seg.t0, an.seg.t1];
    const beltless = !((w.samples || []).length >= 10 || (w.session_samples || []).length >= 10);
    // HR figures over the RUN only (not the walk to the track / back home)
    const hrRaw = hrStats(w.samples, [], R0, R1) || (beltless ? null : w.hr_raw || w.hr || null);
    const hr = hrStats(w.samples, q.mask, R0, R1) || hrRaw;
    const out = { analysis_v: ANALYSIS_V, quality: q, hr, hr_raw: hrRaw, cadence_avg: an.cadence_avg, steps_start_missed: an.steps_start_missed,
      step_distance_m: an.step_distance_adj_m, cal_steps: an.cal_steps, cal_gps_m: an.cal_gps_m, gps_stride_m: an.gps_stride_m, distance_m: an.distance_m,
      moving_s: an.moving_s, stop_s: an.stop_s, stops: an.stops, gps_distance_m: an.gps_distance_m, segments: an.segments, seg: an.seg, beltless };
    const tc = tailCut(w.session_rr, w.duration_s);
    out.tail_cut = tc;
    if (!out.hr) delete out.hr;
    if (!out.hr_raw) delete out.hr_raw;
    const prev = previousInSession(w, list);
    if (prev) {
      const pr = prev.recovery || {}, pi = prev.inherit || null;
      out.inherit = pi ? Object.assign({}, pi, { of: pi.of }) : { of: prev.id, baseline: pr.baseline != null ? pr.baseline : null,
        hrv_pre: pr.rmssd_pre != null ? { rmssd: pr.rmssd_pre, sdnn: pr.sdnn_pre, hr: pr.hr_pre_rr } : null };
    } else out.inherit = null;
    if (w.session_samples && w.session_samples.length) {
      const v = Object.assign({}, w, out);
      out.recovery = Object.assign(recoverySummary(recovery(v)) || {}, hrvSummary(hrv(v)));
    }
    return out;
  }

  const api = { analyze, segment, SEG, runBounds, signalQuality, hrStats, tailCut, previousInSession, derive, ANALYSIS_V, gpsCurve, findStops, refinePauseStart, applyPauseOverride, haversine: hav, recovery, recoverySummary, HRR_MIN, STOP_GAP_S, SEG_STEPS,
    cleanRR, hrvStats, hrv, hrvSummary, rPeaks, ecgStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FTAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
