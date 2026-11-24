"""Running dynamics from the raw Polar H10 accelerometer (offline, after the run).

Input: data.bin (int16 LE x,y,z in mG, ~200 Hz), frames.csv ("samplesSoFar,sensorMs,wallMs" per BLE frame).
The H10 sits on the sternum, close to the centre of mass, so the trunk acceleration is a fair proxy:
  * steps / cadence        – peaks of the vertical specific force
  * vertical oscillation   – double integral of vertical acceleration over each step (drift removed per step)
  * lateral sway           – same, sideways, over each stride (two steps)
  * impact                 – peak vertical force at landing, g
  * ground contact / flight– from the signal shape: in flight the trunk is in free fall (vertical specific force ≈ 0 g),
                             so contact = from leaving the flight baseline (foot strike) to coming back to it (toe-off),
                             threshold baseline + 0.12 g; a step counts as "clear" if both ends are found inside the step.
                             Fallback/cross-check: spring-mass "sine" model Fmax/mg = π/2 · T_step / t_contact (Morin 2005)
  * stride length          – GPS distance over running stretches / strap steps in them
  * balance                – contact time of one side vs the other; the side comes from the sway direction (estimate)
Pure Python (no numpy on the server); ~1 s per 10 min of data.
"""
from __future__ import annotations

import math
from array import array
from statistics import median
from typing import Any

DYN_V = 2
G = 9.80665


def parse(data: bytes) -> tuple[array, array, array]:
    a = array("h")
    a.frombytes(data[: len(data) // 6 * 6])
    if a.itemsize != 2:
        raise ValueError("int16 expected")
    import sys
    if sys.byteorder == "big":
        a.byteswap()
    return a[0::3], a[1::3], a[2::3]


def timing(frames_csv: str, n: int, fs_nominal: float = 200.0) -> tuple[float, float]:
    """(t0 wall ms of sample 0, dt ms). Sensor clock → slope; wall clock lower envelope → offset."""
    rows = []
    for line in frames_csv.splitlines():
        p = line.strip().split(",")
        if len(p) == 3:
            try:
                r = (int(p[0]), int(p[1]), int(p[2]))
            except ValueError:
                continue
            if r[2] > 10 ** 12 and r[0] > 0:   # a line cut by a crash has a short wall time
                rows.append(r)
    if len(rows) < 2:
        return (rows[0][2] if rows else 0) - n * 1000.0 / fs_nominal, 1000.0 / fs_nominal
    # sensor ms of the last sample of each frame vs its index (samplesSoFar-1); a reconnect may reset the
    # sensor clock, so use the longest run where the sensor clock moves forward consistently
    segs, cur = [], [rows[0]]
    for r in rows[1:]:
        dn, dts = r[0] - cur[-1][0], r[1] - cur[-1][1]
        if dn > 0 and 0 < dts < dn * 1000.0 / fs_nominal * 3 + 2000:
            cur.append(r)
        else:
            segs.append(cur); cur = [r]
    segs.append(cur)
    best = max(segs, key=lambda s: s[-1][0] - s[0][0])
    if len(best) >= 2 and best[-1][0] > best[0][0]:
        dt = (best[-1][1] - best[0][1]) / (best[-1][0] - best[0][0])
        if not (1000.0 / fs_nominal * 0.9 < dt < 1000.0 / fs_nominal * 1.1):
            dt = 1000.0 / fs_nominal
    else:
        dt = 1000.0 / fs_nominal
    # wall time of sample i ≈ wall arrival of its frame minus BLE latency: take the earliest-arriving frames
    off = min(r[2] - (r[0] - 1) * dt for r in rows)
    return off, dt


def _frame_times(frames_csv: str, dt: float, t0: float) -> tuple[list[int], list[float]]:
    """Per frame: (index of its last sample, wall ms of it) from the sensor clock + the offset of timing().
    Lets samples after a reconnect gap get their real time."""
    idx, ts = [], []
    off = None
    rows = []
    for line in frames_csv.splitlines():
        p = line.strip().split(",")
        if len(p) != 3:
            continue
        try:
            r = (int(p[0]), int(p[1]), int(p[2]))
        except ValueError:
            continue
        if r[2] > 10 ** 12 and r[0] > 0:
            rows.append(r)
    if not rows:
        return [], []
    off = min(r[2] - r[1] for r in rows)
    for r in rows:
        if idx and r[0] <= idx[-1]:
            continue
        idx.append(r[0] - 1); ts.append(r[1] + off)
    return idx, ts


def _time_of(i: int, idx: list[int], ts: list[float], t0: float, dt: float) -> float:
    if not idx:
        return t0 + i * dt
    import bisect
    k = bisect.bisect_left(idx, i)
    if k >= len(idx):
        return ts[-1] + (i - idx[-1]) * dt
    return ts[k] - (idx[k] - i) * dt


def _hav(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def _stride_gps(run_steps: list[dict], track: list, t_of) -> tuple[float, int, float] | None:
    """Running stretches = runs of consecutive running steps (gap < 1 s), ≥ 20 steps and ≥ 10 s long.
    Step length = Σ GPS distance over the stretches / Σ steps in them. Track rows: [t_s from start, lat, lon, acc_m]."""
    pts = [p for p in track if len(p) >= 3 and (len(p) < 4 or p[3] is None or p[3] <= 20)]
    if len(pts) < 10 or len(run_steps) < 20:
        return None
    ts, cum = [float(pts[0][0])], [0.0]
    for a, b in zip(pts, pts[1:]):
        ts.append(float(b[0])); cum.append(cum[-1] + _hav(a[1], a[2], b[1], b[2]))
    import bisect

    def at(t):
        if t <= ts[0] or t >= ts[-1]:
            return None
        k = bisect.bisect_left(ts, t)
        f = (t - ts[k - 1]) / ((ts[k] - ts[k - 1]) or 1)
        return cum[k - 1] + f * (cum[k] - cum[k - 1])

    stretches, cur = [], [run_steps[0]]
    for s in run_steps[1:]:
        prev = cur[-1]
        if t_of(s["i"]) - t_of(prev["i"]) < 1.0:
            cur.append(s)
        else:
            stretches.append(cur); cur = [s]
    stretches.append(cur)
    tot_m, tot_n = 0.0, 0
    for st in stretches:
        st = [x for x in st if ts[0] < t_of(x["i"]) < ts[-1]]   # clip to the GPS track's time range
        if len(st) < 20:
            continue
        t1, t2 = t_of(st[0]["i"]), t_of(st[-1]["i"])
        if t2 - t1 < 10:
            continue
        d1, d2 = at(t1), at(t2)
        if d1 is None or d2 is None:
            continue
        tot_m += d2 - d1; tot_n += len(st) - 1
    if tot_n < 100 or tot_m <= 0:
        return None
    sl = tot_m / tot_n
    return (sl, tot_n, tot_m) if 0.4 <= sl <= 2.5 else None


def _movmean(x, w: int) -> array:
    n = len(x)
    if n == 0:
        return []
    h = w // 2
    c = array("d", bytes(8 * (n + 1)))
    acc = 0.0
    for i, v in enumerate(x):
        acc += v
        c[i + 1] = acc
    out = array("d", bytes(8 * n))
    for i in range(n):
        lo, hi = max(0, i - h), min(n, i + h + 1)
        out[i] = (c[hi] - c[lo]) / (hi - lo)
    return out


def _ptp_double_integral(acc: list[float], dt_s: float) -> float:
    """Peak-to-peak displacement of a (quasi-)periodic acceleration segment, m. Mean, velocity mean and linear
    drift removed (the segment is one period, so the trunk starts and ends at the same height/side)."""
    n = len(acc)
    if n < 4:
        return 0.0
    m = sum(acc) / n
    v, s = [0.0] * n, 0.0
    for i in range(n):
        s += (acc[i] - m) * dt_s
        v[i] = s
    vm = sum(v) / n
    p, s = [0.0] * n, 0.0
    for i in range(n):
        s += (v[i] - vm) * dt_s
        p[i] = s
    slope = (p[-1] - p[0]) / (n - 1)
    q = [p[i] - p[0] - slope * i for i in range(n)]
    return max(q) - min(q)


def _q(xs: list[float], f: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    k = (len(s) - 1) * f
    lo = int(math.floor(k)); hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def analyze(data: bytes, frames_csv: str, meta: dict[str, Any] | None = None,
            workout: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    fs_nom = float(meta.get("fs") or 200)
    xs, ys, zs = parse(data)
    n = len(xs)
    if n < fs_nom * 20:
        return {"v": DYN_V, "ok": False, "reason": "мало данных", "samples": n}
    t0, dt = timing(frames_csv, n, fs_nom)
    fr_idx, fr_t = _frame_times(frames_csv, dt, t0)
    fs = 1000.0 / dt
    dts = dt / 1000.0
    ax = array("d", (v / 1000.0 for v in xs)); ay = array("d", (v / 1000.0 for v in ys)); az = array("d", (v / 1000.0 for v in zs))
    del xs, ys, zs
    # gravity = 2 s moving mean (orientation of the strap may drift a bit during a run)
    w2 = max(3, int(fs * 2))
    gx, gy, gz = _movmean(ax, w2), _movmean(ay, w2), _movmean(az, w2)
    sv = array("d", bytes(8 * n)); sl = array("d", bytes(8 * n))
    for i in range(n):
        gn = math.sqrt(gx[i] ** 2 + gy[i] ** 2 + gz[i] ** 2) or 1.0
        ux, uy, uz = gx[i] / gn, gy[i] / gn, gz[i] / gn            # "up" (accelerometer reads +1 g upward at rest)
        sv[i] = ax[i] * ux + ay[i] * uy + az[i] * uz               # vertical specific force, g (1 = standing still)
        # forward = device Z (out of the chest) projected on the horizontal plane; lateral = up × forward (left +)
        fx, fy, fz = -uz * ux, -uz * uy, 1 - uz * uz
        fn = math.sqrt(fx * fx + fy * fy + fz * fz) or 1.0
        fx, fy, fz = fx / fn, fy / fn, fz / fn
        lx, ly, lz = uy * fz - uz * fy, uz * fx - ux * fz, ux * fy - uy * fx
        sl[i] = ax[i] * lx + ay[i] * ly + az[i] * lz
    del ax, ay, az, gx, gy, gz
    svs = _movmean(sv, max(1, int(round(fs * 0.025))))              # 25 ms smoothing (removes the sharp heel transient)

    # ---- steps: peaks of the smoothed vertical force, adaptive threshold per 10 s, ≥ 0.27 s apart, dip < 1 g between
    win = int(fs * 10)
    thr_w = []
    for s0 in range(0, n, win):
        seg = svs[s0:s0 + win]
        p95 = _q(list(seg[:: max(1, len(seg) // 400)]), 0.95) if len(seg) else 1.3
        thr_w.append(1.0 + max(0.25, 0.5 * (p95 - 1.0)))
    min_gap = int(fs * 0.27)
    peaks: list[int] = []
    i = 1
    while i < n - 1:
        if svs[i] > thr_w[i // win] and svs[i] >= svs[i - 1] and svs[i] >= svs[i + 1]:
            # local max over ±min_gap/2
            lo, hi = max(0, i - min_gap // 2), min(n, i + min_gap // 2 + 1)
            if svs[i] >= max(svs[lo:hi]):
                if peaks and i - peaks[-1] < min_gap:
                    if svs[i] > svs[peaks[-1]]:
                        peaks[-1] = i
                elif peaks and min(svs[peaks[-1]:i]) > 1.0:
                    if svs[i] > svs[peaks[-1]]:
                        peaks[-1] = i
                else:
                    peaks.append(i)
                i += 1
                continue
        i += 1

    wk_type = (workout or {}).get("type") or "run"
    steps = []
    for k in range(len(peaks) - 1):
        a, b = peaks[k], peaks[k + 1]
        T = (b - a) * dts
        if not (0.24 <= T <= 1.4):
            continue
        fmax = svs[a]
        # raw impact peak around the landing
        r0, r1 = max(0, a - int(fs * 0.06)), min(n, a + int(fs * 0.06))
        impact = max(sv[r0:r1])
        running = T <= 0.5 and fmax >= 1.5
        tc_model = math.pi * T / (2 * fmax) if fmax > 1.0 else T
        tc_model = min(max(tc_model, 0.10), T)
        # shape: flight baseline = 10th percentile of the smoothed force over the step
        seg = sorted(svs[a:b])
        base = seg[len(seg) // 10]
        th = base + 0.12
        lo_lim = peaks[k - 1] if k > 0 else max(0, a - int(fs * 0.3))
        a0 = a
        while a0 > lo_lim and svs[a0] > th:
            a0 -= 1
        b0 = min(b, a + int(fs * 0.06))
        while b0 < b and svs[b0] > th:
            b0 += 1
        clear = a0 > lo_lim and b0 < b and base < 0.4
        tc = (b0 - a0) * dts if clear else tc_model
        tc = min(max(tc, 0.10), T)
        vo = _ptp_double_integral([(v - 1.0) * G for v in sv[a:b]], dts)
        steps.append({"i": a, "T": T, "run": running, "fmax": fmax, "impact": impact, "tc": tc, "tc_model": tc_model,
                      "clear": clear, "vo": vo})
    # lateral sway and side per stride (two steps)
    for k in range(len(steps) - 1):
        s1, s2 = steps[k], steps[k + 1]
        if s2["i"] - s1["i"] > int(fs * 1.5) or abs(s1["T"] - s2["T"]) > 0.25 * max(s1["T"], s2["T"]):
            continue
        a, b = s1["i"], s2["i"] + int(round(s2["T"] / dts))
        acc = [v * G for v in sl[a:b]]
        if len(acc) < 8:
            continue
        s1["sway"] = _ptp_double_integral(acc, dts)
        # side: lateral position at landing of step 1 relative to the stride mean (left + → left foot)
        nA = len(acc); m = sum(acc) / nA
        v, s = [0.0] * nA, 0.0
        for j in range(nA):
            s += (acc[j] - m) * dts; v[j] = s
        vm = sum(v) / nA
        p, s = [0.0] * nA, 0.0
        for j in range(nA):
            s += (v[j] - vm) * dts; p[j] = s
        slope = (p[-1] - p[0]) / (nA - 1)
        q = [p[j] - p[0] - slope * j for j in range(nA)]
        mid1 = min(nA - 1, int(round(s1["T"] / dts / 2)))
        mid2 = min(nA - 1, int(round(s1["T"] / dts + s2["T"] / dts / 2)))
        s1["side_score"] = q[mid1] - q[mid2]

    run_steps = [s for s in steps if s["run"]] if wk_type == "run" else steps
    is_run = wk_type == "run"
    res: dict[str, Any] = {"v": DYN_V, "ok": True, "samples": n, "fs": round(fs, 2), "duration_s": round(n * dts),
                           "t0": round(t0), "steps_h10": len(peaks), "steps_used": len(run_steps), "type": wk_type}
    if len(run_steps) < 30:
        res.update(ok=False, reason="мало беговых шагов")
        return res

    def stat(key, scale=1.0, nd=1):
        vals = [s[key] * scale for s in run_steps if key in s]
        if len(vals) < 10:
            return None
        return {"med": round(median(vals), nd), "p25": round(_q(vals, 0.25), nd), "p75": round(_q(vals, 0.75), nd)}

    res["cadence"] = stat("T", 1, 4)
    if res["cadence"]:
        res["cadence"] = {k: round(60.0 / v) for k, v in res["cadence"].items()}
        res["cadence"]["p25"], res["cadence"]["p75"] = res["cadence"]["p75"], res["cadence"]["p25"]
    res["vo_cm"] = stat("vo", 100, 1)
    res["sway_cm"] = stat("sway", 100, 1)
    res["impact_g"] = stat("impact", 1, 2)
    if is_run:
        res["gct_ms"] = stat("tc", 1000, 0)
        res["gct_model_ms"] = stat("tc_model", 1000, 0)
        clear = sum(1 for s in run_steps if s["clear"]) / len(run_steps)
        g = res["gct_ms"]
        iqr_rel = (g["p75"] - g["p25"]) / g["med"] if g and g["med"] else 1
        res["gct_clear_pct"] = round(clear * 100)
        res["gct_conf"] = "high" if clear >= 0.8 and iqr_rel <= 0.2 else "medium" if clear >= 0.5 else "low"
        for s in run_steps:
            s["tf"] = s["T"] - s["tc"]; s["duty"] = s["tc"] / s["T"]
        res["flight_ms"] = stat("tf", 1000, 0)
        res["duty_pct"] = stat("duty", 100, 1)
        sided = [s for s in run_steps if "side_score" in s]
        L = [s["tc"] for s in sided if s["side_score"] > 0]; R = [s["tc"] for s in sided if s["side_score"] < 0]
        if len(L) >= 20 and len(R) >= 20:
            mL, mR = median(L), median(R)
            res["balance_l_pct"] = round(100 * mL / (mL + mR), 1)
    # stride length / vertical ratio: GPS distance over running stretches / strap steps in them
    w = workout or {}
    w_start = w.get("started_at") or _time_of(0, fr_idx, fr_t, t0, dt)
    sl_gps = _stride_gps(run_steps, w.get("track") or [], lambda i: (_time_of(i, fr_idx, fr_t, t0, dt) - w_start) / 1000.0)
    # start steps: strap steps before the phone step counter's first event (only if ACC started within 3 s of «Старт»)
    ser = [p for p in (w.get("step_series") or []) if p and len(p) >= 2]
    acc_lag = (_time_of(0, fr_idx, fr_t, t0, dt) - w_start) / 1000.0
    res["acc_start_s"] = round(acc_lag, 1)
    if ser and w.get("started_at") and -1 <= acc_lag <= 3 and peaks:
        t_first = float(ser[0][0])
        n_before = sum(1 for i in peaks if (_time_of(i, fr_idx, fr_t, t0, dt) - w_start) / 1000.0 < t_first)
        res["start_steps_h10"] = n_before
        res["start_missed_h10"] = max(0, n_before - int(ser[0][1]))
        res["phone_first_event"] = [t_first, int(ser[0][1])]
    dist = w.get("distance_m") or 0
    mov = w.get("moving_s") or w.get("duration_s") or 0
    if sl_gps:
        res["step_len_m"] = round(sl_gps[0], 2)
        res["step_len_src"] = "gps"
        res["stretch_steps"], res["stretch_m"] = sl_gps[1], round(sl_gps[2])
        if res.get("vo_cm"):
            res["vratio_pct"] = round(res["vo_cm"]["med"] / (sl_gps[0] * 100) * 100, 1)
    elif res.get("cadence") and dist and mov:
        res["step_len_src"] = "avg"
        speed = dist / mov
        step_len = speed / (res["cadence"]["med"] / 60.0)
        res["step_len_m"] = round(step_len, 2)
        if res.get("vo_cm"):
            res["vratio_pct"] = round(res["vo_cm"]["med"] / (step_len * 100) * 100, 1)
    # per-minute series: [t_s from the workout start, cadence, vo_cm, gct_ms, impact_g]
    series = []
    by_min: dict[int, list[dict]] = {}
    for s in run_steps:
        by_min.setdefault(int(max(0.0, _time_of(s["i"], fr_idx, fr_t, t0, dt) - w_start) / 1000 // 60), []).append(s)
    for m_i in sorted(by_min):
        g = by_min[m_i]
        if len(g) < 20:
            continue
        series.append([m_i * 60, round(60 / median([s["T"] for s in g])), round(median([s["vo"] for s in g]) * 100, 1),
                       round(median([s["tc"] for s in g]) * 1000) if is_run else None, round(median([s["impact"] for s in g]), 2)])
    res["series"] = series
    return res
