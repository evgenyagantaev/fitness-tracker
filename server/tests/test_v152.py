"""v1.5.2: derived analytics fields (signal quality, back-to-back inheritance, tail cut, calibration without the 1st segment)."""


def wk(i, typ="run", gps=None, steps=2000, ok=True, **kw):
    w = {"id": f"wmotion{i:03d}", "type": typ, "date": f"2026-11-{i:02d}", "started_at": 1_790_000_000_000 + i * 86_400_000,
         "duration_s": 1200, "moving_s": 1100, "stop_s": 100, "stops": 2, "steps": steps, "stride_m": 0.75,
         "distance_m": gps if (gps and ok) else steps * 0.75, "step_distance_m": steps * 0.75, "gps_distance_m": gps,
         "gps_ok": ok, "gps_acc": 6.0, "cadence_avg": 165, "updated_at": 1, "samples": [[1, 120]],
         "step_series": [[1, 2], [2, 5]], "track": [[1, 55.0, 37.0, 5.0], [2, 55.00001, 37.0, 5.0]],
         "segments": [[0, 35.2, 100, 75.0, 82.1, 35.2], [35.2, 70.0, 100, 75.0, None, 34.8]]}
    w.update(kw)
    return w




def test_derived_fields_roundtrip_and_recovery_list(client):
    w = wk(1, gps=1700.0, analysis_v=2, hr={"avg": 145.0, "max": 168, "min": 80}, hr_raw={"avg": 151.2, "max": 192, "min": 80},
           quality={"mask": [[20, 140], [190, 520]], "masked_s": 450, "masked_pct": 51.7, "rr_artifacts_pct": 25.7, "label": "poor"},
           steps_start_missed=21, cal_steps=1900, cal_gps_m=1610.0, tail_cut=4141.2,
           inherit={"of": "wmotion000", "baseline": 58.0, "hrv_pre": {"rmssd": 42.0, "sdnn": 55.0, "hr": 62}},
           session_samples=[[-10, 70], [5, 120], [1300, 100]], recovery={"hr_end": 150, "baseline": 58.0, "repeat": 1})
    r = client.put("/api/workouts/wmotion001", json=w)
    assert r.status_code == 200, r.text
    full = client.get("/api/workouts/wmotion001").json()
    assert full["quality"]["label"] == "poor" and full["quality"]["mask"][1] == [190, 520]
    assert full["hr_raw"]["max"] == 192 and full["inherit"]["of"] == "wmotion000" and full["tail_cut"] == 4141.2
    rec = client.get("/api/stats/recovery").json()[0]
    assert rec["quality"]["masked_s"] == 450 and rec["inherit"]["baseline"] == 58.0 and rec["tail_cut"] == 4141.2
    assert client.get("/api/stats/runs").json()[0]["hr_avg"] == 145.0


def test_calibration_uses_steps_after_first_segment(client):
    client.put("/api/workouts/wmotion001", json=wk(1, gps=2100.0, steps=2500, cal_steps=2400, cal_gps_m=2040.0))
    client.put("/api/workouts/wmotion002", json=wk(2, gps=1800.0, steps=2200, cal_steps=2100, cal_gps_m=1785.0))
    client.put("/api/workouts/wmotion003", json=wk(3, gps=1600.0, steps=2000))   # old record: whole run
    c = client.get("/api/stats/calibration").json()["run"]
    assert c["n"] == 3 and c["stride_m"] == round((2040 + 1785 + 1600) / (2400 + 2100 + 2000), 3)
    assert {r["id"]: r for r in c["runs"]}["wmotion001"]["stride_m"] == round(2040 / 2400, 3)
    assert "_cs" not in c["runs"][0]


def test_bad_quality_label_rejected(client):
    assert client.put("/api/workouts/wmotion001", json=wk(1, gps=1700.0, quality={"label": "awful"})).status_code == 422
