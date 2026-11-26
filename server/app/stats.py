"""Statistics computed from daily records."""
from __future__ import annotations

from datetime import date as Date, timedelta
from typing import Any


def cells_of(v: dict[str, Any], planned_reps: int = 0) -> list[dict[str, Any]]:
    """Filled cells of a rep exercise on one day, in order.

    v1.11 board: `cells` = [{reps, id?, src?}] holds only filled cells (no planned sets, no norm).
    Older records (done[] + reps, optional counted[]) are read as-is, never rewritten: a ticked set
    is a cell with the planned reps, a set counted by the phone keeps its real reps.
    """
    if v.get("cells") is not None:
        return [c for c in v["cells"] if c and int(c.get("reps") or 0) > 0]
    done = [bool(x) for x in (v.get("done") or [])]
    counted = v.get("counted") or []
    per = int(v.get("reps", planned_reps) or 0)
    out: list[dict[str, Any]] = []
    for i, d in enumerate(done):
        if not d:
            continue
        c = counted[i] if i < len(counted) else None
        reps = int(c["reps"]) if c else per
        if reps > 0:
            out.append({"reps": reps, **({"id": c["id"], "src": "auto"} if c else {})})
    return out


def day_metrics(rec: dict[str, Any], exercises: list[dict[str, Any]], since: dict[str, str] | None = None) -> dict[str, Any]:
    """Per-day numbers: total reps & number of sets per exercise, km. No daily norm: the day's result is the sum.

    `completion` is only the share of the day's exercise kinds touched (pull-ups, push-ups, run, walk): 0.25 per kind.
    """
    reps: dict[str, int] = {}
    sets_done: dict[str, int] = {}
    km: dict[str, float] = {}
    cfg = {e["id"]: e for e in exercises}
    touched: set[str] = set()

    for ex_id, v in (rec.get("sets") or {}).items():
        cells = cells_of(v, int(cfg.get(ex_id, {}).get("reps", 0)))
        reps[ex_id] = sum(int(c["reps"]) for c in cells)
        sets_done[ex_id] = len(cells)
        if cells:
            touched.add(ex_id)
    for ex_id, v in (rec.get("distance") or {}).items():
        k = float(v.get("km") or 0)
        km[ex_id] = round(k, 3)
        if bool(v.get("done")) or k > 0:
            touched.add(ex_id)

    kinds = [e["id"] for e in exercises if not (since and since.get(e["id"], "") > rec["date"])]
    total_items = len(kinds)
    done_items = sum(1 for k in kinds if k in touched)
    active = bool(touched)
    completion = (done_items / total_items) if total_items else (1.0 if active else 0.0)
    return {
        "date": rec["date"],
        "reps": reps,
        "sets": sets_done,
        "km": km,
        "km_total": round(sum(km.values()), 3),
        "active": active,
        "completion": round(completion, 4),
        "complete": total_items > 0 and done_items >= total_items,
    }


def _parse(d: str) -> Date:
    return Date.fromisoformat(d)


def streaks(metrics: list[dict[str, Any]], today: Date) -> dict[str, Any]:
    active_days = {_parse(m["date"]) for m in metrics if m["active"]}
    full_days = {_parse(m["date"]) for m in metrics if m["complete"]}

    def longest(days: set[Date]) -> int:
        best = run = 0
        prev: Date | None = None
        for d in sorted(days):
            run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
            best = max(best, run)
            prev = d
        return best

    def current(days: set[Date]) -> int:
        # The streak is still alive if today isn't done yet but yesterday was.
        d = today if today in days else today - timedelta(days=1)
        n = 0
        while d in days:
            n += 1
            d -= timedelta(days=1)
        return n

    return {
        "today": today.isoformat(),
        "current": current(active_days),
        "longest": longest(active_days),
        "current_full": current(full_days),
        "longest_full": longest(full_days),
        "active_days": len(active_days),
        "full_days": len(full_days),
    }


def _bucket_start(d: Date, period: str) -> Date:
    if period == "week":
        return d - timedelta(days=d.weekday())  # Monday
    if period == "month":
        return d.replace(day=1)
    raise ValueError(period)


def _next_bucket(d: Date, period: str) -> Date:
    if period == "week":
        return d + timedelta(days=7)
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1)


MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def summary(metrics: list[dict[str, Any]], period: str, count: int, today: Date) -> list[dict[str, Any]]:
    """Totals for the last `count` weeks/months (oldest first, empty buckets included)."""
    starts = [_bucket_start(today, period)]
    for _ in range(count - 1):
        s = starts[-1]
        prev = s - timedelta(days=7) if period == "week" else (s - timedelta(days=1)).replace(day=1)
        starts.append(prev)
    starts.reverse()
    buckets = []
    for s in starts:
        e = _next_bucket(s, period) - timedelta(days=1)
        label = f"{s.day:02d}.{s.month:02d}" if period == "week" else f"{MONTHS_RU[s.month - 1]} {s.year}"
        buckets.append({"start": s.isoformat(), "end": e.isoformat(), "label": label,
                        "reps": {}, "sets": {}, "km": 0.0, "km_by": {}, "active_days": 0, "full_days": 0})
    index = {b["start"]: b for b in buckets}
    for m in metrics:
        b = index.get(_bucket_start(_parse(m["date"]), period).isoformat())
        if b is None:
            continue
        for k, v in m["reps"].items():
            b["reps"][k] = b["reps"].get(k, 0) + v
        for k, v in m["sets"].items():
            b["sets"][k] = b["sets"].get(k, 0) + v
        b["km"] = round(b["km"] + m["km_total"], 3)
        for k, v in m["km"].items():
            b["km_by"][k] = round(b["km_by"].get(k, 0.0) + v, 3)
        b["active_days"] += 1 if m["active"] else 0
        b["full_days"] += 1 if m["complete"] else 0
    return buckets


def totals(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    reps: dict[str, int] = {}
    km = 0.0
    km_by: dict[str, float] = {}
    best_by: dict[str, float] = {}
    for m in metrics:
        for k, v in m["reps"].items():
            reps[k] = reps.get(k, 0) + v
        km += m["km_total"]
        for k, v in m["km"].items():
            km_by[k] = round(km_by.get(k, 0.0) + v, 3)
            best_by[k] = max(best_by.get(k, 0.0), v)
    best_km = max((m["km_total"] for m in metrics), default=0.0)
    return {"reps": reps, "km": round(km, 3), "best_km_day": best_km, "km_by": km_by, "best_km_day_by": best_by,
            "days_recorded": len(metrics)}


# ---------------- recorded workouts ----------------
def _moving(w: dict[str, Any]) -> float:
    m = w.get("moving_s")
    return float(m) if m else float(w.get("duration_s") or 0)


def runs(workouts: list[dict[str, Any]], typ: str, limit: int) -> list[dict[str, Any]]:
    """Per-workout summary (oldest first) for pace / distance trends."""
    out = []
    for w in workouts:
        if typ != "all" and w.get("type") != typ:
            continue
        dist = float(w.get("distance_m") or 0)
        mv = _moving(w)
        gps = w.get("gps_distance_m")
        out.append({
            "id": w["id"], "date": w.get("date"), "started_at": w["started_at"], "type": w.get("type"),
            "distance_m": round(dist), "duration_s": round(float(w.get("duration_s") or 0)), "moving_s": round(mv),
            "stops": w.get("stops", 0), "stop_s": round(float(w.get("stop_s") or 0)),
            "pace_s_km": round(mv / (dist / 1000)) if dist > 50 and mv > 0 else None,
            "speed_kmh": round(dist / mv * 3.6, 2) if dist > 0 and mv > 0 else None,
            "gps_distance_m": round(gps) if gps is not None else None, "gps_ok": bool(w.get("gps_ok")),
            "step_distance_m": round(float(w["step_distance_m"])) if w.get("step_distance_m") is not None
            else round(float(w.get("steps") or 0) * float(w.get("stride_m") or 0.75)),
            "cadence_avg": w.get("cadence_avg"), "hr_avg": (w.get("hr") or {}).get("avg"),
            "steps": w.get("steps", 0),
        })
    out.sort(key=lambda r: r["started_at"])
    return out[-limit:]


CAL_MIN_GPS_M = 800
CAL_MIN_STEPS = 500
CAL_LAST = 10


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def calibration(workouts: list[dict[str, Any]]) -> dict[str, Any]:
    """Stride length estimated from runs with good GPS: sum(gps distance) / sum(steps) over the last
    CAL_LAST good runs per type, after dropping runs > 15 % away from the median."""
    res: dict[str, Any] = {"rules": {"min_gps_m": CAL_MIN_GPS_M, "min_steps": CAL_MIN_STEPS, "last": CAL_LAST,
                                     "max_acc_m": 20, "min_coverage": 0.8}}
    for typ in ("run", "walk"):
        rows = []
        for w in sorted(workouts, key=lambda x: x["started_at"]):
            if w.get("type") != typ or w.get("gps_distance_m") is None:
                continue
            steps = int(w.get("steps") or 0)
            gps = float(w["gps_distance_m"])
            # v1.5.2: calibrate without the first 100-step segment (step-counter start lag, getting going)
            c_steps = int(w["cal_steps"]) if w.get("cal_steps") else steps
            c_gps = float(w["cal_gps_m"]) if w.get("cal_steps") and w.get("cal_gps_m") is not None else gps
            stride = c_gps / c_steps if c_steps else None
            reasons = []
            if not w.get("gps_ok"):
                reasons.append("плохой GPS")
            if gps < CAL_MIN_GPS_M:
                reasons.append("короткая")
            if steps < CAL_MIN_STEPS:
                reasons.append("мало шагов")
            if stride is not None and not (0.4 <= stride <= 2.0):
                reasons.append("неправдоподобно")
            rows.append({"id": w["id"], "date": w.get("date"), "started_at": w["started_at"], "steps": steps,
                         "gps_distance_m": round(gps), "stride_m": round(stride, 3) if stride else None,
                         "stride_used_m": w.get("stride_m"), "good": not reasons, "reason": ", ".join(reasons) or None,
                         "pace_s_km": round(_moving(w) / (gps / 1000)) if gps > 50 else None,
                         "_cs": c_steps, "_cg": c_gps})
        good = [r for r in rows if r["good"]][-CAL_LAST:]
        used: list[dict[str, Any]] = []
        if good:
            med = _median([r["stride_m"] for r in good])
            used = [r for r in good if abs(r["stride_m"] - med) <= 0.15 * med]
        for r in rows:
            r["used"] = r in used
            if r["good"] and not r["used"]:
                r["reason"] = "выброс" if r in good else "старая"
        est = round(sum(r["_cg"] for r in used) / sum(r["_cs"] for r in used), 3) if used else None
        for r in rows:
            r.pop("_cs", None)
            r.pop("_cg", None)
        spread = None
        if len(used) >= 2:
            xs = [r["stride_m"] for r in used]
            mean = sum(xs) / len(xs)
            spread = round((sum((x - mean) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5, 3)
        res[typ] = {"stride_m": est, "n": len(used), "spread_m": spread, "runs": rows[-30:]}
    return res


def _bin(samples: list[Any], bin_s: int) -> list[list[float]]:
    acc: dict[int, list[float]] = {}
    for t, v in samples:
        k = int((float(t) // bin_s) * bin_s)
        a = acc.setdefault(k, [0.0, 0])
        a[0] += float(v)
        a[1] += 1
    return [[k + bin_s / 2, round(a[0] / a[1], 1)] for k, a in sorted(acc.items())]


def recovery_curves(workouts: list[dict[str, Any]], bin_s: int = 3) -> list[dict[str, Any]]:
    """HR sessions (pre / run / post) downsampled to `bin_s` bins, newest first.
    Recovery metrics are computed by the shared client code (analysis.js) from these curves."""
    out = []
    for w in workouts:
        ss = w.get("session_samples") or []
        if not ss:
            continue
        out.append({
            "id": w["id"], "date": w.get("date"), "started_at": w["started_at"], "type": w.get("type"),
            "duration_s": w.get("duration_s"), "moving_s": w.get("moving_s"), "distance_m": w.get("distance_m"), "seg": w.get("seg"),
            "hr": w.get("hr"), "device": w.get("device"), "session_start": w.get("session_start"),
            "session_end": w.get("session_end"), "recovery": w.get("recovery"), "curve": _bin(ss, bin_s),
            "rr_count": len(w.get("session_rr") or []),
            "quality": w.get("quality"), "tail_cut": w.get("tail_cut"), "inherit": w.get("inherit"),
        })
    return out


def strap_battery(readings: list[dict[str, Any]]) -> dict[str, Any]:
    """H10 battery: it reports % only, so "health" = how fast % goes down per hour of use.
    Readings come at each connection and every 10 min while connected → gaps ≤ 20 min count as use time.
    A jump up by ≥ 8 % = a new battery (a coin cell recovers only 1–3 % after a rest)."""
    out: dict[str, Any] = {"readings": readings[-500:], "batteries": [], "current": None}
    by_dev: dict[str, list[dict[str, Any]]] = {}
    for r in sorted(readings, key=lambda r: r["t"]):
        by_dev.setdefault(r.get("device") or "", []).append(r)
    for dev, rs in by_dev.items():
        bat = None
        for i, r in enumerate(rs):
            if bat is None or r["level"] >= bat["last_level"] + 8:
                bat = {"device": dev, "installed_at": r["t"], "start_level": r["level"], "last_level": r["level"],
                       "last_at": r["t"], "use_s": 0.0, "acc_s": 0.0, "drop": 0}
                out["batteries"].append(bat)
                continue
            gap = (r["t"] - bat["last_at"]) / 1000
            if 0 < gap <= 20 * 60:
                bat["use_s"] += gap
                if r.get("acc"):
                    bat["acc_s"] += gap
            bat["drop"] = bat["start_level"] - r["level"]
            bat["last_level"] = r["level"]; bat["last_at"] = r["t"]
    for b in out["batteries"]:
        h = b["use_s"] / 3600
        b["use_h"] = round(h, 1)
        b["rate_pct_h"] = round(b["drop"] / h, 2) if h >= 2 and b["drop"] >= 2 else None
        b["left_h"] = round(b["last_level"] / b["rate_pct_h"]) if b["rate_pct_h"] else None
    if out["batteries"]:
        cur = max(out["batteries"], key=lambda b: b["last_at"])
        prev = [b for b in out["batteries"] if b is not cur and b["device"] == cur["device"] and b["rate_pct_h"]]
        cur = dict(cur)
        if cur["rate_pct_h"] and prev:
            cur["vs_prev"] = round(cur["rate_pct_h"] / prev[-1]["rate_pct_h"], 2)
        out["current"] = cur
    return out
