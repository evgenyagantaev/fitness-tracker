"""v1.4: HR session around workouts and the recovery endpoint."""
import json


def wk(i, session=True, **kw):
    D = 1200
    ss = [[t, 75] for t in range(-300, 0)] + [[t, 150] for t in range(0, D + 1)] + [[D + t, 100] for t in range(1, 1800)]
    w = {"id": f"wrecov{i:03d}", "type": "run", "date": f"2026-11-{i:02d}", "started_at": 1_790_000_000_000 + i * 86_400_000,
         "duration_s": D, "steps": 3000, "distance_m": 3000, "updated_at": 1, "samples": [[1, 150]],
         "session_start": 1_790_000_000_000 + i * 86_400_000 - 300_000, "session_end": 1_790_000_000_000 + i * 86_400_000 + 3_000_000,
         "session_samples": ss if session else [], "recovery": {"hrr1": 30.5, "tau": 80, "hr_end": 165, "gaps": 0}}
    w.update(kw)
    return w


def test_session_roundtrip_and_strip(client):
    assert client.put("/api/workouts/wrecov001", json=wk(1)).status_code == 200
    full = client.get("/api/workouts/wrecov001").json()
    assert full["session_samples"][0] == [-300, 75] and full["recovery"]["hrr1"] == 30.5
    lst = client.get("/api/workouts").json()
    assert "session_samples" not in lst[0] and lst[0]["recovery"]["tau"] == 80


def test_recovery_endpoint_bins_and_filters(client):
    client.put("/api/workouts/wrecov001", json=wk(1))
    client.put("/api/workouts/wrecov002", json=wk(2))
    client.put("/api/workouts/wrecov003", json=wk(3, session=False))
    client.put("/api/workouts/wrecov004", json=wk(4, deleted=True))
    r = client.get("/api/stats/recovery?bin_s=5").json()
    assert [x["id"] for x in r] == ["wrecov002", "wrecov001"]
    c = r[0]["curve"]
    assert c[0] == [-297.5, 75.0] and all(b[0] > a[0] for a, b in zip(c, c[1:]))
    assert len(c) <= (300 + 1200 + 1800) // 5 + 2
    assert r[0]["duration_s"] == 1200 and r[0]["recovery"]["hrr1"] == 30.5


def test_post_update_keeps_session_when_client_trimmed(client):
    client.put("/api/workouts/wrecov001", json=wk(1))
    w = wk(1, updated_at=9, session_samples=[], note="x")
    assert client.put("/api/workouts/wrecov001", json=w).json()["applied"]
    assert len(client.get("/api/workouts/wrecov001").json()["session_samples"]) > 1000


def test_recovery_validation(client):
    bad = wk(1, recovery={"x": [1, 2]})
    assert client.put("/api/workouts/wrecov001", json=bad).status_code == 422
