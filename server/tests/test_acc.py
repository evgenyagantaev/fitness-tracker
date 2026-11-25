import base64, math, os, random, struct, sys, zlib

sys.path.insert(0, os.path.dirname(__file__))
from app import dynamics as D  # noqa: E402
from app import stats  # noqa: E402


def synth(T=60 / 170, tc=0.25, dur=120, fs=203.8, rest=10, seed=1):
    random.seed(seed)
    n = int(dur * fs); out = []
    fmax = math.pi * T / (2 * tc)
    for i in range(n):
        t = i / fs
        if t < rest:
            v = 1.0 + random.gauss(0, 0.01); lat = 0
        else:
            ph = (t - rest) % T
            v = (fmax * math.sin(math.pi * ph / tc) if ph < tc else 0.0) + random.gauss(0, 0.03)
            lat = 0.15 * math.sin(2 * math.pi * (t - rest) / (2 * T))
        out.append((int(-v * 1000), int(lat * 1000), int(random.gauss(0, 0.02) * 1000)))
    data = b"".join(struct.pack("<hhh", *o) for o in out)
    t0 = 1795515945678
    fr = [f"{k},{int((k - 1) / fs * 1000) + 5000},{t0 + int((k - 1) / fs * 1000) + random.randint(20, 120)}" for k in range(36, n + 1, 36)]
    return data, "\n".join(fr) + "\n", n - n % 36


def test_dynamics_synthetic():
    d, f, _ = synth()
    r = D.analyze(d, f, {"fs": 200}, {"type": "run", "distance_m": 330, "moving_s": 110})
    assert r["ok"]
    assert abs(r["cadence"]["med"] - 170) <= 1
    assert abs(r["gct_ms"]["med"] - 250) <= 10
    assert abs(r["flight_ms"]["med"] - (60000 / 170 - 250)) <= 12
    assert 300 <= r["steps_h10"] <= 320
    assert 2 < r["vo_cm"]["med"] < 15 and r["sway_cm"]["med"] > 0
    assert 1.8 < r["impact_g"]["med"] < 2.8
    assert abs(r["balance_l_pct"] - 50) < 3
    assert r["step_len_m"] and r["vratio_pct"]
    assert abs(r["fs"] - 203.8) < 0.5 and r["series"]


def test_dynamics_at_rest_is_not_ok():
    random.seed(2)
    d = b"".join(struct.pack("<hhh", -667 + random.randint(-20, 20), -134, 733) for _ in range(6000))
    f = "\n".join(f"{k},{int(k * 4.9)},{1000 + int(k * 4.9)}" for k in range(36, 6001, 36))
    r = D.analyze(d, f, {"fs": 200}, {"type": "run"})
    assert r["ok"] is False


def test_acc_upload_finish_and_dynamics(client):
    d, f, n = synth()
    d = d[: n * 6]
    f = "\n".join(l for l in f.splitlines() if int(l.split(",")[0]) <= n) + "\n"
    w = {"id": "wtest1", "type": "run", "date": "2026-11-24", "started_at": 1795515945000, "duration_s": 120,
         "distance_m": 330, "moving_s": 110, "steps": 300, "updated_at": 5}
    assert client.put("/api/workouts/wtest1", json=w).status_code == 200
    aid = "awtest1"
    assert client.get(f"/api/acc/{aid}").json()["sizes"] == {"data": 0, "frames": 0}
    step = 60000
    for off in range(0, len(d), step):
        b64 = base64.b64encode(zlib.compress(d[off:off + step])).decode()
        r = client.put(f"/api/acc/{aid}/chunk?file=data&offset={off}", json={"b64": b64})
        assert r.status_code == 200
    # resend of a chunk (retry after a network error) is idempotent
    b64 = base64.b64encode(zlib.compress(d[:step])).decode()
    client.put(f"/api/acc/{aid}/chunk?file=data&offset=0", json={"b64": b64})
    assert client.put(f"/api/acc/{aid}/chunk?file=data&offset={len(d) + 10}", json={"b64": b64}).status_code == 409
    client.put(f"/api/acc/{aid}/chunk?file=data&offset={step}", json={"b64": base64.b64encode(zlib.compress(d[step:])).decode()})
    fb = f.encode()
    client.put(f"/api/acc/{aid}/chunk?file=frames&offset=0", json={"b64": base64.b64encode(zlib.compress(fb)).decode()})
    assert client.get(f"/api/acc/{aid}").json()["sizes"] == {"data": len(d), "frames": len(fb)}
    assert client.post(f"/api/acc/{aid}/finish", json={"samples": n + 1, "fs": 200}).status_code == 409
    r = client.post(f"/api/acc/{aid}/finish", json={"samples": n, "fs": 200, "workout_id": "wtest1", "started_at": 1795515945000})
    assert r.status_code == 200 and r.json()["result"]["ok"]
    dyn = client.get("/api/workouts/wtest1/dynamics").json()["result"]
    assert abs(dyn["gct_ms"]["med"] - 250) <= 10 and dyn["step_len_m"]
    runs = client.get("/api/stats/runs?type=run").json()
    assert runs[-1]["dyn"]["cadence"] == dyn["cadence"]["med"]
    assert client.get("/api/workouts/nope/dynamics").status_code == 404
    assert client.get("/api/acc/BAD..id").status_code == 422


def test_strap_battery(client):
    H = 3600_000
    rs = []
    t = 1_700_000_000_000
    lvl = 100.0
    for i in range(6 * 10):          # 10 h of use, a reading every 10 min, 1 %/h
        rs.append({"t": t, "level": int(lvl), "device": "Polar H10 1", "acc": i % 2 == 0}); t += H // 6; lvl -= 1 / 6
        if i % 6 == 5:
            t += 20 * H              # off between sessions (not counted as use)
    assert client.post("/api/strap-battery", json={"readings": rs}).json()["added"] == len(rs)
    assert client.post("/api/strap-battery", json={"readings": rs[:3]}).json()["added"] == 0   # duplicates ignored
    b = client.get("/api/stats/strap-battery").json()
    c = b["current"]
    assert 8 <= c["use_h"] <= 10.5 and c["rate_pct_h"] and 0.7 <= c["rate_pct_h"] <= 1.3 and c["left_h"] > 50
    # a new battery (jump up) → new epoch, compared with the previous one
    rs2 = [{"t": t + i * H // 6, "level": 100 - i // 3, "device": "Polar H10 1"} for i in range(30)]
    client.post("/api/strap-battery", json={"readings": rs2})
    b = client.get("/api/stats/strap-battery").json()
    assert len(b["batteries"]) == 2 and b["current"]["vs_prev"] and b["current"]["vs_prev"] > 1.5


def test_battery_summary_empty():
    assert stats.strap_battery([])["current"] is None


def test_gps_stride_over_running_stretches_and_shape_contact():
    d, f, _ = synth(dur=130)
    t0 = 1795515945678
    # 170 spm, 1.0 m/step → 2.833 m/s; GPS track from the workout start (t_s, lat, lon, acc), one bad fix (acc 50 m)
    v = 170 / 60 * 1.0
    track = []
    for s in range(0, 131):
        dist = max(0.0, s - 10) * v
        track.append([s, 55.0 + dist / 111320.0, 37.0, 50 if s == 60 else 5])
    track[60][1] += 0.01
    r = D.analyze(d, f, {"fs": 200}, {"type": "run", "started_at": t0, "track": track, "distance_m": 340, "moving_s": 120})
    assert r["ok"] and r["step_len_src"] == "gps"
    assert abs(r["step_len_m"] - 1.0) < 0.06, r["step_len_m"]
    assert r["vratio_pct"] and r["gct_conf"] in ("high", "medium")
    assert r["gct_clear_pct"] >= 80


def _put(client, aid, file, off, raw, **extra):
    return client.put(f"/api/acc/{aid}/chunk?file={file}&offset={off}",
                      json={"b64": base64.b64encode(zlib.compress(raw)).decode(), **extra})


def test_chunk_crc_and_whole_file_sha(client):
    import hashlib
    d, f, n = synth(dur=120)
    d = d[: n * 6]
    fb = f.encode()
    aid = "acrc1"
    assert _put(client, aid, "data", 0, d[:100000], crc32=zlib.crc32(d[:100000]) ^ 1, len=100000).status_code == 422
    assert _put(client, aid, "data", 0, d[:100000], crc32=zlib.crc32(d[:100000]), len=99999).status_code == 422
    assert _put(client, aid, "data", 0, d[:100000], crc32=zlib.crc32(d[:100000]), len=100000).status_code == 200
    # the v1.6 bug: second chunk read from offset 0 instead of 100000 → crc is of what the phone read, so it passes,
    # but the whole-file hash at finish catches it
    assert _put(client, aid, "data", 100000, d[:len(d) - 100000], crc32=zlib.crc32(d[:len(d) - 100000])).status_code == 200
    _put(client, aid, "frames", 0, fb)
    meta = {"samples": n, "fs": 200, "sha256_data": hashlib.sha256(d).hexdigest(), "sha256_frames": hashlib.sha256(fb).hexdigest()}
    r = client.post(f"/api/acc/{aid}/finish", json=meta)
    assert r.status_code == 409 and "sha256" in r.text
    _put(client, aid, "data", 100000, d[100000:], crc32=zlib.crc32(d[100000:]), len=len(d) - 100000)
    r = client.post(f"/api/acc/{aid}/finish", json={**meta, "partial": "частичная запись, первые 2 мин"})
    assert r.status_code == 200 and r.json()["sha256_data"] == meta["sha256_data"]
    rec = client.get(f"/api/acc/{aid}").json()["record"]
    assert rec["meta"]["verified"] is True
    assert rec["result"]["partial"].startswith("частичная запись")


# ---------------- v1.7: phone accelerometer (beltless), segmentation-aware dynamics ----------------
def synth_phone(dur=240, fs=50.0, steps_per_s=2.8, still=(100, 130), seed=3, h2=0.25):
    """|a| rhythm at the step rate while running, nothing during `still`; arbitrary orientation (gravity on y)."""
    random.seed(seed)
    n = int(dur * fs); out = []
    for i in range(n):
        t = i / fs
        if still[0] <= t < still[1]:
            amp = 0.0
        else:
            amp = 0.8 * math.sin(2 * math.pi * steps_per_s * t) + h2 * math.sin(2 * math.pi * steps_per_s * t * 2 + 1)
        a = 1.0 + amp
        out.append((int(random.gauss(0, 0.01) * 1000), int(a * 1000 + random.gauss(0, 8)), int(random.gauss(0, 0.01) * 1000)))
    data = b"".join(struct.pack("<hhh", *o) for o in out)
    t0 = 1795515945678
    fr = [f"{k},{int((k - 1) / fs * 1000) + 5000},{t0 + int((k - 1) / fs * 1000) + random.randint(5, 60)}" for k in range(50, n + 1, 50)]
    return data, "\n".join(fr) + "\n", n


def test_phone_motion_cadence_and_stillness():
    from app import phone_motion as PM
    d, f, n = synth_phone()
    r = PM.analyze(d, f, {"fs": 50, "started_at": 1795515945678 + 5000 - 5000}, {"started_at": 1795515945678})
    assert r["ok"] and r["kind"] == "phone"
    rows = r["motion"]
    run = [x for x in rows if 20 < x[0] < 90]
    assert run and all(abs(x[1] - 168) <= 4 for x in run), run[:3]
    still = [x for x in rows if 106 < x[0] < 124]
    assert still and all(x[1] == 0 and x[2] < 0.04 for x in still), still
    assert 160 <= r["cad_med"] <= 176


def test_phone_motion_folds_half_rate_arm_swing():
    from app import phone_motion as PM
    d, f, n = synth_phone(steps_per_s=1.4, still=(0, 0), h2=0.6)      # only the stride rhythm (+ its 2nd harmonic in synth)
    r = PM.analyze(d, f, {"fs": 50}, {"started_at": 1795515945678})
    assert 160 <= r["cad_med"] <= 176


def test_dynamics_only_inside_run_and_away_from_pauses():
    d, f, _ = synth(dur=130)
    t0 = 1795515945678
    seg = {"src": "auto", "t0": 40.0, "t1": 120.0, "pauses": [[70.0, 80.0]]}
    w = {"type": "run", "started_at": t0 - 2000, "seg": seg}
    r_all = D.analyze(d, f, {"fs": 200}, {"type": "run", "started_at": t0 - 2000})
    r = D.analyze(d, f, {"fs": 200}, w)
    assert r["ok"] and r["steps_used"] < r_all["steps_used"]
    assert r["steps_used"] <= (120 - 40 - 10 - 14) * 170 / 60 + 8      # run − pause − 7 s each side
    # no step inside the excluded zone: the series never has a minute-bucket for those seconds beyond the run window
    assert abs(r["cadence"]["med"] - 170) <= 1


def test_series_cadence_is_steps_over_time_not_median_interval():
    """A minute that is half rest, half 170 spm must not be reported as 170."""
    d, f, _ = synth(dur=60, rest=30)
    t0 = 1795515945678
    r = D.analyze(d, f, {"fs": 200}, {"type": "run", "started_at": t0, "seg": {"src": "auto", "t0": 0, "t1": 60, "pauses": []}})
    assert r["ok"] and r["series"], r
    # ~30 s × 170 / 60 ≈ 85 steps in a 60 s bucket (ACC starts ~with the file)
    cad = r["series"][0][1]
    assert 70 <= cad <= 110, cad
    # the typical-running cadence on the card stays near 170
    assert abs(r["cadence"]["med"] - 170) <= 2
