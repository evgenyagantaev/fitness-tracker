"""Body composition from a Xiaomi Mi Body Composition Scale 2 (XMTZC05HM) weighing.

The scale reports only weight and one foot-to-foot impedance (Ω, ~50 kHz). Everything else is an estimate from
weight, impedance, height, age and sex using the regression published by the Mi Fit / Zepp Life reverse-engineering
community (the same math is used by several open-source projects). This module is an independent implementation of
those formulas — treat the results as a trend indicator, not as a clinical measurement.

sex: "m" | "f"; height in cm; age in years; weight in kg; impedance in Ω (None / 0 = no impedance in this weighing).
"""
from __future__ import annotations

import datetime as dt
from typing import Any


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def age_at(birth: str | None, when: dt.date) -> int | None:
    """birth: "YYYY" or "YYYY-MM-DD". Age in full years on `when` (a bare year counts as 1 July)."""
    if not birth:
        return None
    try:
        if len(birth) == 4:
            b = dt.date(int(birth), 7, 1)
        else:
            b = dt.date.fromisoformat(birth[:10])
    except ValueError:
        return None
    a = when.year - b.year - ((when.month, when.day) < (b.month, b.day))
    return a if 5 <= a <= 110 else None


def bmi(weight: float, height_cm: float) -> float:
    m = height_cm / 100.0
    return weight / (m * m)


def _lean_coeff(w: float, h: float, z: float, age: int) -> float:
    # lean-mass regression on height², weight, impedance and age (kg)
    return h * 9.058 / 100.0 * h / 100.0 + w * 0.32 + 12.226 - z * 0.0068 - age * 0.0542


def fat_pct(w: float, h: float, z: float, age: int, sex: str) -> float:
    if sex == "m":
        sub = 0.8
        k = 0.98 if w < 61 else 1.0
    else:
        sub = 9.25 if age <= 49 else 7.25
        k = 1.0
        if w > 60:
            k = 0.96 * (1.03 if h > 160 else 1.0)
        elif w < 50:
            k = 1.02 * (1.03 if h > 160 else 1.0)
    f = (1.0 - (_lean_coeff(w, h, z, age) - sub) * k / w) * 100.0
    if f > 63:
        f = 75.0
    return _clamp(f, 5.0, 75.0)


def bone_kg(w: float, h: float, z: float, age: int, sex: str) -> float:
    base = 0.18016894 if sex == "m" else 0.245691014
    b = _lean_coeff(w, h, z, age) * 0.05158 - base
    b = b + 0.1 if b > 2.2 else b - 0.1
    if (sex == "m" and b > 5.2) or (sex != "m" and b > 5.1):
        b = 8.0
    return _clamp(b, 0.5, 8.0)


def muscle_kg(w: float, h: float, z: float, age: int, sex: str) -> float:
    """«Мышцы» as Mi Fit shows them: weight − fat − bone (lean soft tissue, not skeletal muscle only)."""
    m = w - fat_pct(w, h, z, age, sex) / 100.0 * w - bone_kg(w, h, z, age, sex)
    if (sex == "m" and m >= 93.5) or (sex != "m" and m >= 84):
        m = 120.0
    return _clamp(m, 10.0, 120.0)


def water_pct(w: float, h: float, z: float, age: int, sex: str) -> float:
    x = (100.0 - fat_pct(w, h, z, age, sex)) * 0.7
    x *= 1.02 if x <= 50 else 0.98
    if x >= 65:
        x = 75.0
    return _clamp(x, 35.0, 75.0)


def visceral(w: float, h: float, age: int, sex: str) -> float:
    if sex == "m":
        if h < w * 1.6 + 63.0:
            v = age * 0.15 + (w * 305.0 / (h * 0.0826 * h - h * 0.4 + 48.0) - 2.9)
        else:
            v = age * 0.15 + (w * (h * -0.0015 + 0.765) - h * 0.143) - 5.0
    else:
        if w <= h * 0.5 - 13.0:
            v = age * 0.07 + (w * (h * -0.0024 + 0.691) - h * 0.027) - 10.5
        else:
            v = age * 0.07 + (w * 500.0 / (h * 1.45 + h * 0.1158 * h - 120.0) - 6.0)
    return _clamp(v, 1.0, 50.0)


def bmr(w: float, h: float, age: int, sex: str) -> float:
    if sex == "m":
        b = 877.8 + w * 14.916 - h * 0.726 - age * 8.976
        if b > 2322:
            b = 5000.0
    else:
        b = 864.6 + w * 10.2036 - h * 0.39336 - age * 6.204
        if b > 2996:
            b = 5000.0
    return _clamp(b, 500.0, 5000.0)


def profile_ok(p: dict[str, Any] | None) -> bool:
    p = p or {}
    try:
        h = float(p.get("height_cm") or 0)
    except (TypeError, ValueError):
        return False
    return 100 <= h <= 230 and p.get("sex") in ("m", "f") and bool(p.get("birth"))


def compose(weight: float, impedance: float | None, profile: dict[str, Any] | None, when: dt.date) -> dict[str, Any]:
    """All metrics that can be computed for this weighing; missing inputs → those keys are absent."""
    p = profile or {}
    out: dict[str, Any] = {}
    try:
        h = float(p.get("height_cm") or 0)
    except (TypeError, ValueError):
        h = 0.0
    if not (10 <= weight <= 250) or not (100 <= h <= 230):
        return out
    out["bmi"] = round(bmi(weight, h), 1)
    sex = p.get("sex")
    age = age_at(p.get("birth"), when)
    if sex not in ("m", "f") or age is None:
        return out
    out["age"] = age
    out["bmr_kcal"] = round(bmr(weight, h, age, sex))
    out["visceral"] = round(visceral(weight, h, age, sex), 1)
    z = float(impedance or 0)
    if 0 < z < 3000:
        out["fat_pct"] = round(fat_pct(weight, h, z, age, sex), 1)
        out["fat_kg"] = round(weight * out["fat_pct"] / 100.0, 1)
        out["muscle_kg"] = round(muscle_kg(weight, h, z, age, sex), 1)
        out["water_pct"] = round(water_pct(weight, h, z, age, sex), 1)
        out["bone_kg"] = round(bone_kg(weight, h, z, age, sex), 2)
        out["lean_kg"] = round(weight - out["fat_kg"], 1)
    return out
