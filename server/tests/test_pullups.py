"""v1.17: pull-up sets from the phone accelerometer, with the raw block kept apart."""
import base64
import struct
import time
import zlib


def _raw(n=300):
    b = b"".join(struct.pack("<4h", 0 if i == 0 else 10, 3, 7, 978) for i in range(n))
    return base64.b64encode(zlib.compress(b)).decode()


def _s(i, reps=8, raw=True):
    d = {"id": f"pl-{i}", "t": int(time.time() * 1000) - i * 1000, "reps": reps, "duration_s": 14.2, "armed_s": 30.5,
         "source": "accel", "device": "test", "close": "landed", "rep_ms": [1200 * k for k in range(reps)], "params": "v1",
         "sensor": {"name": "acc", "resolution": 0.0024, "min_delay_us": 2500, "wakeup": False},
         "raw_fmt": "pullraw1", "raw_t0": int(time.time() * 1000), "raw_n": 300, "raw_go_ms": 8000, "raw_truncated": False}
    if raw:
        d["raw"] = _raw()
    return d


def test_pullups_roundtrip_raw_apart(client):
    assert client.post("/api/pullups", json={"items": [_s(1), _s(2, 5, raw=False)]}).json() == {"added": 2}
    assert client.post("/api/pullups", json={"items": [_s(1)]}).json() == {"added": 0}
    got = {x["id"]: x for x in client.get("/api/pullups?days=7").json()["items"]}
    assert got["pl-1"]["reps"] == 8 and got["pl-1"]["close"] == "landed" and got["pl-1"]["has_raw"] is True
    assert "raw" not in got["pl-1"] and got["pl-2"]["has_raw"] is False and got["pl-1"]["sensor"]["name"] == "acc"
    r = client.get("/api/pullups/pl-1/raw").json()
    assert r["fmt"] == "pullraw1"
    data = zlib.decompress(base64.b64decode(r["data"]))
    assert len(data) == 300 * 8 and struct.unpack("<4h", data[8:16]) == (10, 3, 7, 978)
    assert client.get("/api/pullups/pl-2/raw").status_code == 404
    assert client.delete("/api/pullups/pl-2").status_code == 200
    assert [x["id"] for x in client.get("/api/pullups").json()["items"]] == ["pl-1"]
    # push-ups are a separate list
    assert client.get("/api/pushups").json()["items"] == []


def test_pullup_validation(client):
    assert client.post("/api/pullups", json={"items": [dict(_s(3), id="bad id!")]}).status_code == 422
    assert client.post("/api/pullups", json={"items": [dict(_s(3), reps=0)]}).status_code == 422
    assert client.post("/api/pullups", json={"items": [dict(_s(3), raw="not base64 !")]}).status_code == 422
