from fastapi.testclient import TestClient

from .conftest import TOKEN, rec

ALL = range(5)


def test_health_is_public(client):
    r = TestClient(client.app).get("/api/health")
    assert r.status_code == 200 and r.json()["ok"]


def test_auth_required(client):
    raw = TestClient(client.app)
    assert raw.get("/api/exercises").status_code == 401
    assert raw.get("/api/exercises", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert raw.get("/api/exercises", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_no_token_configured_rejects(tmp_path):
    from app.main import create_app
    c = TestClient(create_app(db_path=str(tmp_path / "x.db"), token=""))
    assert c.get("/api/exercises", headers={"Authorization": "Bearer "}).status_code == 503


def test_default_exercises(client):
    ex = client.get("/api/exercises").json()
    assert [e["id"] for e in ex] == ["pullups", "pushups", "run", "walk"]
    assert ex[0]["name"] == "Подтягивания" and ex[0]["sets"] == 5 and ex[0]["reps"] == 3
    assert ex[1]["reps"] == 15 and ex[2]["kind"] == "distance"


def test_replace_exercises_deactivates_missing(client):
    new = [{"id": "squats", "name": "Приседания", "kind": "sets", "sets": 3, "reps": 20},
           {"id": "run", "name": "Бег", "kind": "distance", "unit": "км"}]
    r = client.put("/api/exercises", json=new)
    assert r.status_code == 200
    assert [e["id"] for e in r.json()] == ["squats", "run"]
    allx = client.get("/api/exercises", params={"include_inactive": True}).json()
    assert {e["id"]: e["active"] for e in allx}["pullups"] is False
    assert client.put("/api/exercises", json=[new[0], new[0]]).status_code == 422
    bad = [{"id": "Bad Id", "name": "x", "kind": "sets"}]
    assert client.put("/api/exercises", json=bad).status_code == 422


def test_put_get_day_and_lww(client):
    body = rec("2026-11-20", pull={0, 1}, ts=2000)
    body.pop("date")
    r = client.put("/api/days/2026-11-20", json=body)
    assert r.json()["applied"] is True
    older = {**body, "updated_at": 1000, "sets": {}}
    r = client.put("/api/days/2026-11-20", json=older)
    assert r.json()["applied"] is False
    got = client.get("/api/days/2026-11-20").json()
    assert got["sets"]["pullups"]["done"][:2] == [True, True]
    # force overrides LWW
    assert client.put("/api/days/2026-11-20?force=true", json=older).json()["applied"] is True
    assert client.get("/api/days/2026-11-20").json()["sets"] == {}
    assert client.get("/api/days/2026-11-21").status_code == 404
    assert client.get("/api/days/20261121").status_code == 422
    assert client.put("/api/days/2026-13-01", json=body).status_code == 422


def test_validation(client):
    bad = rec("2026-11-20", km=-1)
    assert client.post("/api/sync", json={"records": [bad]}).status_code == 422
    bad = rec("2026-02-30")
    assert client.post("/api/sync", json={"records": [bad]}).status_code == 422


def test_sync_offline_first_lww(client):
    # device A pushes two days
    r = client.post("/api/sync", json={"since": 0, "records": [
        rec("2026-11-20", pull=ALL, ts=100), rec("2026-11-21", push={0}, ts=100)]}).json()
    assert sorted(r["applied"]) == ["2026-11-20", "2026-11-21"] and r["rejected"] == []
    cursor_a = r["rev"]
    assert len(r["records"]) == 2 and r["exercises"]

    # device B edits 2026-11-21 later, and sends a stale version of 2026-11-20
    r = client.post("/api/sync", json={"since": 0, "records": [
        rec("2026-11-21", push={0, 1, 2}, ts=200), rec("2026-11-20", ts=50)]}).json()
    assert r["applied"] == ["2026-11-21"] and r["rejected"] == ["2026-11-20"]

    # device A pulls with its cursor and only gets the changed day, B's version
    r = client.post("/api/sync", json={"since": cursor_a, "records": []}).json()
    assert [x["date"] for x in r["records"]] == ["2026-11-21"]
    assert r["records"][0]["sets"]["pushups"]["done"][:3] == [True, True, True]
    assert r["records"][0]["updated_at"] == 200

    # nothing new since the latest cursor
    r2 = client.post("/api/sync", json={"since": r["rev"], "records": []}).json()
    assert r2["records"] == []

    # equal timestamp does not overwrite (deterministic)
    r = client.post("/api/sync", json={"records": [rec("2026-11-21", ts=200)]}).json()
    assert r["rejected"] == ["2026-11-21"]


def test_list_days_range(client):
    client.post("/api/sync", json={"records": [rec(f"2026-11-{d:02d}", pull={0}) for d in range(1, 11)]})
    r = client.get("/api/days", params={"from": "2026-11-03", "to": "2026-11-05"}).json()
    assert [x["date"] for x in r] == ["2026-11-03", "2026-11-04", "2026-11-05"]


def test_streaks(client):
    days = [rec("2026-11-10", pull=ALL, push=ALL, km=3, ts=1),          # full
            rec("2026-11-11", pull=ALL, push=ALL, run_done=True, ts=1),  # full
            rec("2026-11-12", pull={0}, ts=1),                           # active
            rec("2026-11-14", push={0}, ts=1),
            rec("2026-11-15", km=2.5, ts=1),
            rec("2026-11-16", ts=1)]                                     # empty -> not active
    client.post("/api/sync", json={"records": days})
    s = client.get("/api/stats/streaks", params={"today": "2026-11-16"}).json()
    assert s["current"] == 2           # 14, 15 (today empty, yesterday counts)
    assert s["longest"] == 3           # 10..12
    assert s["longest_full"] == 2 and s["current_full"] == 0
    assert s["active_days"] == 5 and s["full_days"] == 2
    s = client.get("/api/stats/streaks", params={"today": "2026-11-18"}).json()
    assert s["current"] == 0


def test_summary_week_and_month(client):
    client.post("/api/sync", json={"records": [
        rec("2026-11-16", pull=ALL, push={0, 1}, km=5, ts=1),   # Monday
        rec("2026-11-22", pull={0}, km=1.5, ts=1),              # Sunday same week
        rec("2026-11-23", push=ALL, ts=1),                      # next Monday
        rec("2026-10-31", pull={0, 1}, ts=1),
    ]})
    w = client.get("/api/stats/summary", params={"period": "week", "count": 3, "today": "2026-11-23"}).json()
    assert [b["start"] for b in w] == ["2026-11-09", "2026-11-16", "2026-11-23"]
    assert w[1]["reps"] == {"pullups": 18, "pushups": 30} and w[1]["km"] == 6.5
    assert w[1]["active_days"] == 2 and w[2]["reps"]["pushups"] == 75
    assert w[0]["reps"] == {} and w[0]["km"] == 0
    m = client.get("/api/stats/summary", params={"period": "month", "count": 2, "today": "2026-11-23"}).json()
    assert [b["label"] for b in m] == ["окт 2026", "ноя 2026"]
    assert m[0]["reps"]["pullups"] == 6 and m[1]["reps"]["pullups"] == 18
    assert client.get("/api/stats/summary", params={"period": "year"}).status_code == 422


def test_month_buckets_across_year(client):
    m = client.get("/api/stats/summary", params={"period": "month", "count": 14, "today": "2026-01-15"}).json()
    assert m[0]["start"] == "2024-12-01" and m[-1]["start"] == "2026-01-01" and len(m) == 14


def test_daily_and_totals(client):
    client.post("/api/sync", json={"records": [
        rec("2026-11-20", pull=ALL, push=ALL, km=3, ts=1), rec("2026-11-21", pull={0}, ts=1)]})
    d = client.get("/api/stats/daily", params={"from": "2026-11-01"}).json()
    assert d[0]["complete"] is True and d[0]["completion"] == 1.0
    assert d[1]["completion"] == round(1 / 11, 4) and d[1]["reps"]["pullups"] == 3
    t = client.get("/api/stats/totals").json()
    assert t["reps"] == {"pullups": 18, "pushups": 75} and t["km"] == 3 and t["days_recorded"] == 2


def test_reps_snapshot_survives_config_change(client):
    client.post("/api/sync", json={"records": [rec("2026-11-20", push=ALL, ts=1)]})
    client.put("/api/exercises", json=[{"id": "pushups", "name": "Отжимания", "kind": "sets", "sets": 5, "reps": 20}])
    t = client.get("/api/stats/totals").json()
    assert t["reps"]["pushups"] == 75   # historical reps use the per-day snapshot


def test_cors_preflight_for_capacitor(client):
    r = client.options("/api/sync", headers={"Origin": "https://localhost",
                                             "Access-Control-Request-Method": "POST",
                                             "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://localhost"


def test_web_ui_served(client):
    r = TestClient(client.app).get("/")
    assert r.status_code == 200 and "Фитнес-трекер" in r.text
