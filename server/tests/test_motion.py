"""v1.3: motion analytics fields, run trends and GPS stride calibration."""


def wk(i, typ="run", gps=None, steps=2000, ok=True, **kw):
    w = {"id": f"wmotion{i:03d}", "type": typ, "date": f"2026-11-{i:02d}", "started_at": 1_790_000_000_000 + i * 86_400_000,
         "duration_s": 1200, "moving_s": 1100, "stop_s": 100, "stops": 2, "steps": steps, "stride_m": 0.75,
         "distance_m": gps if (gps and ok) else steps * 0.75, "step_distance_m": steps * 0.75, "gps_distance_m": gps,
         "gps_ok": ok, "gps_acc": 6.0, "cadence_avg": 165, "updated_at": 1, "samples": [[1, 120]],
         "step_series": [[1, 2], [2, 5]], "track": [[1, 55.0, 37.0, 5.0], [2, 55.00001, 37.0, 5.0]],
         "segments": [[0, 35.2, 100, 75.0, 82.1, 35.2], [35.2, 70.0, 100, 75.0, None, 34.8]]}
    w.update(kw)
    return w


def test_motion_fields_roundtrip_and_list_strips_series(client):
    r = client.put("/api/workouts/wmotion001", json=wk(1, gps=1700.0))
    assert r.status_code == 200, r.text
    full = client.get("/api/workouts/wmotion001").json()
    assert full["moving_s"] == 1100 and full["stops"] == 2 and full["gps_ok"] is True
    assert full["track"][0] == [1, 55.0, 37.0, 5.0] and full["step_series"][1] == [2, 5]
    assert full["segments"][1][4] is None
    lst = client.get("/api/workouts").json()
    assert "track" not in lst[0] and "step_series" not in lst[0] and "samples" not in lst[0]
    assert lst[0]["gps_distance_m"] == 1700


def test_old_client_without_new_fields_still_works(client):
    w = {"id": "woldclient1", "type": "run", "date": "2026-11-02", "started_at": 1_790_100_000_000, "duration_s": 600,
         "steps": 1000, "distance_m": 750, "updated_at": 1}
    assert client.put("/api/workouts/woldclient1", json=w).status_code == 200
    runs = client.get("/api/stats/runs").json()
    r = [x for x in runs if x["id"] == "woldclient1"][0]
    assert r["moving_s"] == 600 and r["pace_s_km"] == 800 and r["step_distance_m"] == 750


def test_runs_trend_pace(client):
    for i in range(1, 4):
        client.put(f"/api/workouts/wmotion{i:03d}", json=wk(i, gps=2200.0))
    client.put("/api/workouts/wmotion009", json=wk(9, typ="walk", gps=900.0))
    runs = client.get("/api/stats/runs?type=run").json()
    assert [r["id"] for r in runs] == ["wmotion001", "wmotion002", "wmotion003"]
    assert runs[0]["pace_s_km"] == round(1100 / 2.2) and runs[0]["speed_kmh"] == round(2200 / 1100 * 3.6, 2)
    assert len(client.get("/api/stats/runs?type=all").json()) == 4


def test_calibration_filters_and_estimates(client):
    data = [(1, 1700.0, 2000, True), (2, 1800.0, 2000, True), (3, 1760.0, 2000, True),
            (4, 3000.0, 2000, True),   # outlier (1.5 m stride)
            (5, 1750.0, 2000, False),  # bad GPS
            (6, 500.0, 600, True),     # too short
            (7, 1800.0, 300, True)]    # too few steps -> also implausible
    for i, g, st, ok in data:
        client.put(f"/api/workouts/wmotion{i:03d}", json=wk(i, gps=g, steps=st, ok=ok))
    c = client.get("/api/stats/calibration").json()
    run = c["run"]
    assert run["n"] == 3 and run["stride_m"] == round((1700 + 1800 + 1760) / 6000, 3)
    by = {r["id"]: r for r in run["runs"]}
    assert by["wmotion004"]["reason"] == "выброс" and not by["wmotion004"]["used"]
    assert "плохой GPS" in by["wmotion005"]["reason"] and "короткая" in by["wmotion006"]["reason"]
    assert "мало шагов" in by["wmotion007"]["reason"]
    assert c["walk"]["stride_m"] is None


def test_validation_rejects_bad_track(client):
    w = wk(1, gps=1000.0, track=[[1, 55.0]])
    assert client.put("/api/workouts/wmotion001", json=w).status_code == 422


def test_trimmed_client_copy_does_not_erase_series(client):
    client.put("/api/workouts/wmotion001", json=wk(1, gps=1700.0))
    w = wk(1, gps=1700.0, updated_at=5, deleted=True, samples=[], track=[], step_series=[], segments=[])
    assert client.put("/api/workouts/wmotion001", json=w).json()["applied"]
    full = [x for x in client.post("/api/sync", json={"since": 0}).json()["workouts"] if x["id"] == "wmotion001"][0]
    assert full["deleted"] and len(full["track"]) == 2 and full["samples"] == [[1, 120]]
