"""Phone accelerometer (beltless runs): a coarse motion profile for run start / pause detection and a fallback cadence.

Input: the same raw file format as the H10 (data.bin = int16 LE x,y,z in mG; frames.csv "samplesSoFar,sensorMs,wallMs"),
recorded by the phone at ~50 Hz while the workout runs. Orientation is unknown (phone in a pocket, a case, an armband), so only
the magnitude |a| is used, and NO chest-style running dynamics are attempted (an arm/hip carried phone cannot give them).

Per window of 10 s (hop 5 s): energy = standard deviation of |a| after removing the 1-s moving mean (g);
cadence = strongest rhythm of |a| between 60 and 240 steps/min (Goertzel), accepted only if it stands out of the band noise;
half-rate peaks (arm swing / one foot) are folded to the step rate. Output rows: [t_s from «Старт», cadence (0 = no rhythm), energy g].
"""
from __future__ import annotations

import math
from array import array
from typing import Any

from . import dynamics as D

PHONE_V = 1
WIN_S, HOP_S = 10.0, 5.0
STILL_G = 0.04                  # below this the phone is not moving at all
F_LO, F_HI, F_STEP = 1.0, 4.0, 0.05


def _movmean(x: list[float], h: int) -> list[float]:
    n = len(x)
    c = [0.0] * (n + 1)
    for i, v in enumerate(x):
        c[i + 1] = c[i] + v
    return [(c[min(n, i + h + 1)] - c[max(0, i - h)]) / (min(n, i + h + 1) - max(0, i - h)) for i in range(n)]


def _power(x: list[float], f: float, dt: float) -> float:
    w = 2 * math.pi * f * dt
    c = 2 * math.cos(w)
    s1 = s2 = 0.0
    for v in x:
        s1, s2 = v + c * s1 - s2, s1
    return s1 * s1 + s2 * s2 - c * s1 * s2


def cadence_of(x: list[float], dt: float) -> int:
    """Steps/min of a detrended |a| window, or 0 when there is no clear rhythm."""
    if len(x) < 4 / dt:
        return 0
    m = sum(x) / len(x)
    xs = [(v - m) * (0.5 - 0.5 * math.cos(2 * math.pi * i / (len(x) - 1))) for i, v in enumerate(x)]   # Hann
    freqs = [F_LO + k * F_STEP for k in range(int((F_HI - F_LO) / F_STEP) + 1)]
    pw = [_power(xs, f, dt) for f in freqs]
    kmax = max(range(len(pw)), key=lambda k: pw[k])
    band = sum(pw) / len(pw)
    if band <= 0 or pw[kmax] < 4.0 * band:
        return 0
    f = freqs[kmax]
    if f < 1.7:     # half-rate (stride) peak: fold up when the doubled frequency carries real power too
        k2 = min(range(len(freqs)), key=lambda k: abs(freqs[k] - 2 * f))
        if pw[k2] >= 0.15 * pw[kmax]:
            f = freqs[k2]
    return int(round(f * 60))


def analyze(data: bytes, frames_csv: str, meta: dict[str, Any] | None = None, workout: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    fs_nom = float(meta.get("fs") or 50)
    xs, ys, zs = D.parse(data)
    n = len(xs)
    if n < fs_nom * 20:
        return {"v": PHONE_V, "kind": "phone", "ok": False, "reason": "мало данных", "samples": n}
    t0, dt = D.timing(frames_csv, n, fs_nom)
    fr_idx, fr_t = D._frame_times(frames_csv, dt, t0)
    dts = dt / 1000.0
    mag = [math.sqrt(xs[i] * xs[i] + ys[i] * ys[i] + zs[i] * zs[i]) / 1000.0 for i in range(n)]
    del xs, ys, zs
    base = _movmean(mag, max(1, int(round(1.0 / dts / 2))))
    det = [mag[i] - base[i] for i in range(n)]
    w_start = (workout or {}).get("started_at") or meta.get("started_at") or D._time_of(0, fr_idx, fr_t, t0, dt)
    win = int(WIN_S / dts)
    hop = max(1, int(HOP_S / dts))
    rows: list[list[Any]] = []
    for a in range(0, max(1, n - win // 2), hop):
        seg = det[a:a + win]
        if len(seg) < win // 2:
            break
        m = sum(seg) / len(seg)
        energy = math.sqrt(sum((v - m) ** 2 for v in seg) / len(seg))
        mid = a + len(seg) // 2
        t = (D._time_of(mid, fr_idx, fr_t, t0, dt) - w_start) / 1000.0
        cad = cadence_of(seg, dts) if energy >= STILL_G else 0
        rows.append([round(t, 1), cad, round(energy, 3)])
    cads = sorted(r[1] for r in rows if r[1] > 0)
    return {"v": PHONE_V, "kind": "phone", "ok": True, "samples": n, "fs": round(1000.0 / dt, 2), "duration_s": round(n * dts),
            "t0": round(t0), "motion": rows, "cad_med": cads[len(cads) // 2] if cads else None,
            "active_pct": round(100 * sum(1 for r in rows if r[1] > 0) / max(1, len(rows)))}
