import time

from app import stats


def _s(i, reps=20, t=None, dur=30):
    return {"id": f"pu-{i}", "t": t or int(time.time() * 1000) - i * 1000, "reps": reps, "duration_s": dur, "armed_s": dur + 8}


def test_pushup_sets_idempotent_and_delete(client):
    items = [_s(1, 21), _s(2, 18)]
    assert client.post("/api/pushups", json={"items": items}).json() == {"added": 2}
    assert client.post("/api/pushups", json={"items": items}).json() == {"added": 0}
    got = client.get("/api/pushups?days=7").json()["items"]
    assert sorted(x["reps"] for x in got) == [18, 21] and all(len(x["date"]) == 10 for x in got)
    assert client.delete("/api/pushups/pu-1").status_code == 200
    assert client.delete("/api/pushups/nope").status_code == 404
    assert [x["id"] for x in client.get("/api/pushups").json()["items"]] == ["pu-2"]
    # a deleted set sent again by a phone that did not know is not resurrected
    assert client.post("/api/pushups", json={"items": [_s(1, 21)]}).json() == {"added": 0}
    assert [x["id"] for x in client.get("/api/pushups").json()["items"]] == ["pu-2"]


def test_pushup_validation(client):
    assert client.post("/api/pushups", json={"items": [dict(_s(3), id="bad id!")]}).status_code == 422
    assert client.post("/api/pushups", json={"items": [dict(_s(3), reps=0)]}).status_code == 422
    assert client.post("/api/pushups", json={"items": [dict(_s(3), t=5)]}).status_code == 422


def test_counted_reps_in_day_stats(client):
    ex = [{"id": "pushups", "name": "Отжимания", "kind": "sets", "sets": 3, "reps": 15}]
    rec = {"date": "2026-11-26", "distance": {}, "sets": {"pushups": {
        "reps": 15, "done": [True, True, True, True, False],
        "counted": [{"id": "pu-a", "reps": 22}, None, {"id": "pu-b", "reps": 9}, {"id": "pu-c", "reps": 31}, None]}}}
    m = stats.day_metrics(rec, ex)
    assert m["reps"]["pushups"] == 22 + 15 + 9 + 31 and m["sets"]["pushups"] == 4   # the plain tick keeps the planned 15
    assert m["active"] and m["complete"] is True      # only one exercise kind is configured here, and it is touched
    # without `counted` nothing changes (old records)
    old = {"date": "2026-11-25", "distance": {}, "sets": {"pushups": {"reps": 15, "done": [True, True, False]}}}
    assert stats.day_metrics(old, ex)["reps"]["pushups"] == 30


def test_counted_roundtrip_through_api(client):
    rec = {"sets": {"pushups": {"reps": 15, "done": [True, False, False, False, False],
                                "counted": [{"id": "pu-x", "reps": 27}, None, None, None, None]}}, "distance": {}, "updated_at": 5}
    assert client.put("/api/days/2026-11-26", json=rec).status_code == 200
    got = client.get("/api/days/2026-11-26").json()
    assert got["sets"]["pushups"]["counted"][0] == {"id": "pu-x", "reps": 27}
    d = [x for x in client.get("/api/stats/daily").json() if x["date"] == "2026-11-26"][0]
    assert d["reps"]["pushups"] == 27
