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

  /**
   * @param w {duration_s, steps, stride_m, step_series, track}
   * @returns summary fields + profiles
   */
  function analyze(w) {
    const duration = w.duration_s || 0, stride = w.stride_m || 0.75;
    const series = (w.step_series || []).filter((p) => p && p.length >= 2);
    const steps = Math.max(w.steps || 0, series.length ? series[series.length - 1][1] : 0);
    const gps = gpsCurve(w.track);
    const stops = findStops(series, duration, gps);
    const stop_s = Math.round(stops.reduce((x, [a, b]) => x + (b - a), 0));
    const moving_s = Math.max(0, Math.round(duration - stop_s));
    const step_distance_m = Math.round(steps * stride);

    // GPS quality
    const goodAcc = gps.good.map((p) => p[3]);
    let covered = 0;
    for (let i = 1; i < gps.good.length; i++) { const dt = gps.good[i][0] - gps.good[i - 1][0]; if (dt <= 10) covered += dt; }
    const coverage = moving_s > 0 ? Math.min(1, covered / Math.max(1, duration)) : 0;
    const gps_acc = goodAcc.length ? Math.round(median(goodAcc) * 10) / 10 : null;
    const gps_distance_m = gps.good.length >= 2 ? Math.round(gps.dist) : null;
    const gps_ok = gps.good.length >= 30 && coverage >= 0.8 && gps_acc !== null && gps_acc <= 20 && (gps_distance_m || 0) >= 200;

    // 100-step segments: [t_start, t_end, steps, dist_by_steps_m, dist_gps_m|null, moving_s]
    const segments = [];
    if (series.length) {
      const base = series[0][0] <= 2 ? 0 : 0;
      let prevT = 0, prevS = base;
      for (let k = SEG_STEPS; k <= steps; k += SEG_STEPS) {
        const t = crossTime(series, k); if (t === null) break;
        segments.push(seg(prevT, t, k - prevS));
        prevT = t; prevS = k;
      }
      const rest = steps - prevS;
      if (rest >= 30) { const t = series[series.length - 1][0]; if (t > prevT) segments.push(seg(prevT, t, rest)); }
    }
    function seg(t0, t1, n) {
      const mv = Math.max(1, (t1 - t0) - stoppedWithin(stops, t0, t1));
      const g = gps.curve.length >= 2 && gps_ok ? Math.round((at(gps.curve, t1) - at(gps.curve, t0)) * 10) / 10 : null;
      return [Math.round(t0 * 10) / 10, Math.round(t1 * 10) / 10, n, Math.round(n * stride * 10) / 10, g, Math.round(mv * 10) / 10];
    }

    // cadence profile (steps/min) every 10 s over a 30 s window; 0 while stopped
    const cadence = [];
    if (series.length) {
      const stepsAt = (t) => { if (t <= series[0][0]) return t < series[0][0] ? Math.min(series[0][1], 0) : series[0][1]; return Math.round(at(series, t)); };
      for (let t = 30; t <= duration; t += 10) {
        const stopped = stoppedWithin(stops, t - 30, t);
        const n = stepsAt(t) - stepsAt(t - 30);
        cadence.push([t, stopped >= 20 ? 0 : Math.round(n * 60 / Math.max(10, 30 - stopped))]);
      }
    }
    // step-counter start lag: the first event can arrive 15–20 s after «Старт»; steps before it are lost except the
    // few it reports itself (v1.6.1: also when that first count is not 0 — 24.11: [15 s, 10 steps] while GPS ran 48 m).
    // Estimate: GPS distance during the lag ÷ steady stride (the stride of the rest of the run), else the steady step
    // rate of the following 30–60 s × lag (only if GPS shows movement during the lag); minus the first count.
    let lag_s = 0, steps_start_missed = 0, steps_start_src = null;
    if (series.length && series[0][0] > 3) {
      lag_s = series[0][0];
      const first = series[0][1];
      const t2 = Math.min(duration, lag_s + 60);
      const rate = t2 - lag_s >= 20 ? (Math.round(at(series, t2)) - first) / (t2 - lag_s) : 0;
      let est = 0;
      if (gps.curve.length >= 2 && gps_ok) {
        const lagDist = at(gps.curve, lag_s) - at(gps.curve, 0);
        const restSteps = steps - first, restDist = gps.dist - at(gps.curve, lag_s);
        const stride0 = restSteps >= 100 && restDist > 50 ? restDist / restSteps : null;
        if (stride0 && stride0 > 0.3 && stride0 < 2.5) { est = lagDist / stride0; steps_start_src = 'gps'; }
        else {
          const mvSpeed = gps.dist / Math.max(1, moving_s);
          const frac = mvSpeed > 0 ? Math.max(0, Math.min(1, (lagDist / lag_s) / mvSpeed)) : 1;
          est = rate * lag_s * frac; steps_start_src = 'pace';
        }
        if (rate > 0) est = Math.min(est, rate * lag_s * 1.5);   // GPS jumps at the start can't add more than 1.5× the pace
      }
      steps_start_missed = Math.max(0, Math.round(est - first));
      if (!steps_start_missed) steps_start_src = null;
    }
    const movingAfter = Math.max(0, (duration - lag_s) - stoppedWithin(stops, lag_s, duration));
    const cadence_avg = movingAfter >= 30 && steps > 0 ? Math.round(steps / (movingAfter / 60)) : null;
    const steps_adj = steps + steps_start_missed;
    const step_distance_adj_m = Math.round(steps_adj * stride);
    const distance_m = gps_ok ? gps_distance_m : step_distance_adj_m;
    // stride calibration without the first 100-step segment (start lag, getting going)
    let cal_steps = null, cal_gps_m = null;
    if (gps_ok && segments.length >= 3) {
      const t1 = segments[0][1];
      cal_steps = steps - segments[0][2];
      cal_gps_m = Math.round(gps.dist - at(gps.curve, t1));
    }
    const gps_stride_m = cal_steps >= 100 ? Math.round(cal_gps_m / cal_steps * 1000) / 1000
      : gps_ok && steps >= 100 ? Math.round(gps_distance_m / steps * 1000) / 1000 : null;
    return { duration_s: Math.round(duration), moving_s, stop_s, stops: stops.length, stop_list: stops, step_distance_m, steps,
      gps_distance_m, gps_ok, gps_acc, gps_coverage: Math.round(coverage * 100) / 100, gps_stride_m,
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
  function recovery(w) {
    const D = w.duration_s || 0;
    const cut = w.tail_cut != null ? w.tail_cut : Infinity, mask = (w.quality && w.quality.mask) || [];
    const masked = (t) => mask.some((m) => t >= m[0] && t <= m[1]);
    const ss = (w.session_samples || []).filter((p) => p && p.length >= 2 && p[1] >= 25 && p[1] <= 250 && p[0] < cut && !masked(p[0])).slice().sort((a, b) => a[0] - b[0]);
    if (!ss.length || D <= 0) return null;
    const pre = ss.filter((p) => p[0] < 0), run = ss.filter((p) => p[0] >= 0 && p[0] <= D);
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
    const D = w.duration_s || 0;
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
  function hrStats(samples, mask) {
    const xs = (samples || []).filter((p) => p && p[1] >= 25 && p[1] <= 250 && !(mask || []).some((m) => p[0] >= m[0] && p[0] <= m[1])).map((p) => p[1]);
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

  const ANALYSIS_V = 3;
  /**
   * Derived (re-computable) fields of a workout; raw data (samples, step_series, track, session_*) is never changed.
   * @param list all workouts (for back-to-back detection; previous ones should already be derived)
   */
  function derive(w, list) {
    const an = analyze(w);
    const q = signalQuality(w, an);
    const hrRaw = w.hr_raw || w.hr || hrStats(w.samples, []);
    const hr = hrStats(w.samples, q.mask) || hrRaw;
    const out = { analysis_v: ANALYSIS_V, quality: q, hr, hr_raw: hrRaw, cadence_avg: an.cadence_avg, steps_start_missed: an.steps_start_missed,
      step_distance_m: an.step_distance_adj_m, cal_steps: an.cal_steps, cal_gps_m: an.cal_gps_m, gps_stride_m: an.gps_stride_m, distance_m: an.distance_m };
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

  const api = { analyze, signalQuality, hrStats, tailCut, previousInSession, derive, ANALYSIS_V, gpsCurve, findStops, haversine: hav, recovery, recoverySummary, HRR_MIN, STOP_GAP_S, SEG_STEPS,
    cleanRR, hrvStats, hrv, hrvSummary, rPeaks, ecgStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FTAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
