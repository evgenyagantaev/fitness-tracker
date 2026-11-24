"""v1.4: RR intervals on workouts and ECG records."""
import base64
import struct

from tests.test_recovery import wk


def test_session_rr_roundtrip_strip_keep(client):
    rr = [[-300 + i * 0.9, 900] for i in range(300)]
    assert client.put("/api/workouts/wrecov010", json=wk(10, session_rr=rr)).status_code == 200
    full = client.get("/api/workouts/wrecov010").json()
    assert len(full["session_rr"]) == 300 and full["session_rr"][0] == [-300, 900]
    assert "session_rr" not in client.get("/api/workouts").json()[0]
    # a trimmed local copy (empty series) must not erase the stored RR
    client.put("/api/workouts/wrecov010", json=wk(10, session_rr=[], updated_at=2))
    assert len(client.get("/api/workouts/wrecov010").json()["session_rr"]) == 300
    r = client.get("/api/stats/recovery").json()
    assert r[0]["rr_count"] == 300 and "rr" not in r[0]


def ecg(i=1, n=1300, **kw):
    raw = struct.pack("<%dh" % n, *[(j % 130 == 0) * 1500 - 100 for j in range(n)])
    e = {"id": f"eecg{i:04d}", "started_at": 1_790_000_000_000 + i, "fs": 130, "n": n, "duration_s": n / 130,
         "samples_b64": base64.b64encode(raw).decode(), "r_peaks": list(range(0, n, 130)), "hr_avg": 60, "rmssd": 0,
         "device": "Polar H10 ABC", "phase": "pre", "updated_at": 10}
    e.update(kw)
    return e


def test_ecg_put_get_list_delete(client):
    assert client.put("/api/ecg/eecg0001", json=ecg()).json()["applied"] is True
    lst = client.get("/api/ecg").json()
    assert len(lst) == 1 and "samples_b64" not in lst[0] and lst[0]["hr_avg"] == 60
    full = client.get("/api/ecg/eecg0001").json()
    assert len(base64.b64decode(full["samples_b64"])) == 2600 and full["r_peaks"][1] == 130
    # LWW: older update ignored
    assert client.put("/api/ecg/eecg0001", json=ecg(hr_avg=99, updated_at=5)).json()["applied"] is False
    # metadata-only update keeps samples
    assert client.put("/api/ecg/eecg0001", json=ecg(samples_b64=None, note="после бега", updated_at=11)).json()["applied"]
    full = client.get("/api/ecg/eecg0001").json()
    assert full["note"] == "после бега" and full["samples_b64"]
    assert client.delete("/api/ecg/eecg0001").status_code == 200
    assert client.get("/api/ecg").json() == []
    assert client.get("/api/ecg/eecg0001").status_code == 404


def test_ecg_validation_and_auth(client):
    assert client.put("/api/ecg/eecg0002", json=ecg(2, samples_b64="!!notb64")).status_code == 422
    bad = ecg(2); bad["n"] = 1299
    assert client.put("/api/ecg/eecg0002", json=bad).status_code == 422
    assert client.put("/api/ecg/eecgXXXX", json=ecg(2)).status_code == 422
    r = client.get("/api/ecg", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_walk_added_once_and_not_penalising_old_days(client):
    ex = client.get("/api/exercises").json()
    ids = [e["id"] for e in ex]
    assert ids.index("walk") == ids.index("run") + 1 and ex[ids.index("walk")]["kind"] == "distance"
    db = client.app.state.db
    since = db.exercise_since()["walk"]
    old = {"date": "2020-01-01", "sets": {"pullups": {"reps": 3, "done": [True] * 5}, "pushups": {"reps": 15, "done": [True] * 5}},
           "distance": {"run": {"km": 3, "done": True}}, "updated_at": 1}
    client.put("/api/days/2020-01-01", json=old)
    d = client.get("/api/stats/daily?from=2020-01-01&to=2020-01-01").json()
    assert d[0]["complete"] is True and since > "2020-01-01"
    new = dict(old, date=since, distance={"run": {"km": 3, "done": True}, "walk": {"km": 2.5, "done": True}})
    client.put(f"/api/days/{since}", json=new)
    t = client.get("/api/stats/totals").json()
    assert t["km_by"]["walk"] == 2.5 and t["km_by"]["run"] == 6
