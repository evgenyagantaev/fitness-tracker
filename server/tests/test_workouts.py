import sqlite3

from .conftest import rec


def wk(wid="w_abc123", ts=1000, start=1795400000000, **kw):
    base = {"id": wid, "type": "run", "date": "2026-11-23", "started_at": start, "ended_at": start + 600_000,
            "duration_s": 600, "steps": 1600, "stride_m": 0.75, "distance_m": 1200,
            "hr": {"avg": 142.5, "max": 171, "min": 98},
            "samples": [[0, 98], [1, 101], [2, 105], [599, 171]], "device": "Xiaomi Smart Band 8",
            "updated_at": ts}
    base.update(kw)
    return base


def test_sync_workouts_lww_and_cursor(client):
    r = client.post("/api/sync", json={"since": 0, "workouts": [wk()]}).json()
    assert r["workouts_applied"] == ["w_abc123"] and len(r["workouts"]) == 1
    assert r["workouts"][0]["samples"][1] == [1, 101]
    cur = r["rev"]
    # stale version rejected, newer accepted
    r = client.post("/api/sync", json={"since": cur, "workouts": [wk(ts=500, steps=1)]}).json()
    assert r["workouts_rejected"] == ["w_abc123"] and r["workouts"] == []
    r = client.post("/api/sync", json={"since": cur, "workouts": [wk(ts=2000, steps=2000)]}).json()
    assert r["workouts_applied"] == ["w_abc123"] and r["workouts"][0]["steps"] == 2000


def test_old_clients_still_work(client):
    # a v1 client sends no "workouts" key and ignores the new response keys
    r = client.post("/api/sync", json={"since": 0, "records": [rec("2026-11-20", pull={0})]})
    assert r.status_code == 200 and r.json()["applied"] == ["2026-11-20"]


def test_list_get_delete(client):
    client.post("/api/sync", json={"workouts": [wk("w_aaaaaa", start=1), wk("w_bbbbbb", start=2)]})
    lst = client.get("/api/workouts").json()
    assert [w["id"] for w in lst] == ["w_bbbbbb", "w_aaaaaa"] and "samples" not in lst[0]
    full = client.get("/api/workouts/w_aaaaaa").json()
    assert full["hr"]["max"] == 171 and len(full["samples"]) == 4
    assert client.delete("/api/workouts/w_aaaaaa").json()["ok"]
    assert client.get("/api/workouts/w_aaaaaa").status_code == 404
    assert [w["id"] for w in client.get("/api/workouts").json()] == ["w_bbbbbb"]
    # the deletion is propagated through sync to other devices
    r = client.post("/api/sync", json={"since": 0}).json()
    assert {w["id"]: w["deleted"] for w in r["workouts"]}["w_aaaaaa"] is True
    t = client.get("/api/stats/totals").json()
    assert t["workouts"]["count"] == 1 and t["workouts"]["distance_m"] == 1200


def test_put_workout_and_validation(client):
    assert client.put("/api/workouts/w_cccccc", json=wk("w_cccccc")).json()["applied"]
    assert client.put("/api/workouts/w_dddddd", json=wk("w_cccccc")).status_code == 422
    assert client.post("/api/sync", json={"workouts": [wk("bad id!")]}).status_code == 422
    assert client.post("/api/sync", json={"workouts": [wk(hr={"avg": 500})]}).status_code == 422
    assert client.post("/api/sync", json={"workouts": [wk(date="2026-02-30")]}).status_code == 422


def test_migration_keeps_v1_data(tmp_path):
    """A database created by v1 (no workouts table) opens fine and keeps its rows/rev."""
    path = tmp_path / "v1.db"
    c = sqlite3.connect(path)
    c.executescript("""
    CREATE TABLE exercises (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, sets INTEGER NOT NULL DEFAULT 1,
      reps INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE days (date TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO exercises VALUES ('pullups','Подтягивания','sets',5,3,'раз',0,1);
    INSERT INTO days VALUES ('2026-11-23','{"sets":{"pullups":{"reps":3,"done":[true]}},"distance":{}}',5,7);
    INSERT INTO meta VALUES ('seeded','1'),('rev','7');
    """)
    c.commit(); c.close()
    from fastapi.testclient import TestClient
    from app.main import create_app
    cl = TestClient(create_app(db_path=str(path), token="t"))
    cl.headers["Authorization"] = "Bearer t"
    assert cl.get("/api/days/2026-11-23").json()["rev"] == 7
    assert [e["id"] for e in cl.get("/api/exercises").json()] == ["pullups", "walk"]
    r = cl.post("/api/sync", json={"since": 7, "workouts": [wk()]}).json()
    assert r["rev"] == 8 and r["records"] == [] and len(r["workouts"]) == 1
