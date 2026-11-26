"""v1.11 day board: free cells (no norm), legacy records read as-is."""
from app import stats

EX = [{"id": "pullups", "name": "Подтягивания", "kind": "sets", "sets": 5, "reps": 3},
      {"id": "pushups", "name": "Отжимания", "kind": "sets", "sets": 5, "reps": 15},
      {"id": "run", "name": "Бег", "kind": "distance", "sets": 1, "reps": 0},
      {"id": "walk", "name": "Ходьба", "kind": "distance", "sets": 1, "reps": 0}]


def test_cells_sum_without_norm():
    rec = {"date": "2026-11-27", "distance": {"run": {"done": True, "km": 4.2}, "walk": {"done": False, "km": 0}},
           "sets": {"pullups": {"cells": [{"reps": 7}, {"reps": 5, "src": "manual"}]},
                    "pushups": {"cells": [{"reps": 31, "id": "pu-1", "src": "auto"}, {"reps": 12}, {"reps": 3}, {"reps": 40}, {"reps": 1}, {"reps": 9}, {"reps": 8}]}}}
    m = stats.day_metrics(rec, EX)
    assert m["reps"] == {"pullups": 12, "pushups": 104} and m["sets"] == {"pullups": 2, "pushups": 7}   # more than the old 5 sets
    assert m["km"]["run"] == 4.2 and m["active"] and m["completion"] == 0.75 and m["complete"] is False


def test_empty_day_is_inactive():
    m = stats.day_metrics({"date": "2026-11-27", "sets": {"pullups": {"cells": []}}, "distance": {}}, EX)
    assert not m["active"] and m["reps"]["pullups"] == 0 and m["completion"] == 0


def test_legacy_record_unchanged_in_stats():
    rec = {"date": "2026-11-01", "distance": {}, "sets": {"pullups": {"reps": 3, "done": [True, True, False, True, False]}}}
    m = stats.day_metrics(rec, EX)
    assert m["reps"]["pullups"] == 9 and m["sets"]["pullups"] == 3
    assert stats.cells_of(rec["sets"]["pullups"]) == [{"reps": 3}] * 3


def test_api_cells_round_trip(client):
    body = {"records": [{"date": "2026-11-27", "updated_at": 5, "distance": {},
                         "sets": {"pushups": {"cells": [{"reps": 20, "id": "pu-9", "src": "auto"}, {"reps": 10, "src": "manual"}]}}}]}
    r = client.post("/api/sync", json=body)
    assert r.status_code == 200 and "2026-11-27" in r.json()["applied"]
    d = client.get("/api/days/2026-11-27").json()
    assert d["sets"]["pushups"]["cells"][0]["reps"] == 20
    day = client.get("/api/stats/daily", params={"from": "2026-11-27"}).json()[0]
    assert day["reps"]["pushups"] == 30 and day["sets"]["pushups"] == 2
    bad = {"records": [{"date": "2026-11-28", "updated_at": 5, "sets": {"pushups": {"cells": [{"reps": 0}]}}}]}
    assert client.post("/api/sync", json=bad).status_code == 422
