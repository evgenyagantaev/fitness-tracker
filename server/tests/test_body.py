import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from app import body  # noqa: E402

D = dt.date(2026, 11, 26)
P = {"height_cm": 180, "birth": "1991", "sex": "m"}   # 35 on D


def test_formulas_hand_checked():
    # lean coefficient = 1.8²·9.058 + 80·0.32 + 12.226 − 500·0.0068 − 35·0.0542 = 61.877
    c = body.compose(80, 500, P, D)
    assert c["age"] == 35 and c["bmi"] == 24.7
    assert abs(c["fat_pct"] - 23.7) <= 0.1          # (1 − (61.877 − 0.8)/80)·100
    assert abs(c["bone_kg"] - (61.877 * 0.05158 - 0.18016894 + 0.1)) < 0.01
    assert abs(c["muscle_kg"] - (80 - 80 * c["fat_pct"] / 100 - c["bone_kg"])) < 0.15
    assert 50 <= c["water_pct"] <= 56
    assert c["bmr_kcal"] == round(877.8 + 80 * 14.916 - 180 * 0.726 - 35 * 8.976)
    assert 5 <= c["visceral"] <= 15


def test_more_impedance_means_more_fat():
    a = body.compose(80, 420, P, D)["fat_pct"]
    b = body.compose(80, 560, P, D)["fat_pct"]
    assert b > a


def test_missing_inputs():
    assert body.compose(80, 500, {}, D) == {}
    only_h = body.compose(80, 500, {"height_cm": 180}, D)
    assert only_h == {"bmi": 24.7}
    no_imp = body.compose(80, None, P, D)
    assert "fat_pct" not in no_imp and "bmr_kcal" in no_imp
    assert "fat_pct" not in body.compose(80, 3500, P, D)    # out-of-range impedance = invalid frame


def test_age_from_birth_date():
    assert body.age_at("1991-12-01", D) == 34 and body.age_at("1991-11-26", D) == 35
    assert body.age_at("bad", D) is None and body.age_at(None, D) is None


def test_profile_and_weighings_api(client):
    assert client.get("/api/profile").json()["complete"] is False
    assert client.put("/api/profile", json={"height_cm": 180, "birth": "1991", "sex": "m"}).json()["complete"] is True
    assert client.put("/api/profile", json={"height_cm": 180, "birth": "91", "sex": "m"}).status_code == 422
    t = 1795700000000
    w0 = {"id": "mi-20261126T080000-16000", "t": t, "weight_kg": 80.0, "impedance": None, "scale_time": "2026-11-26T08:00:00"}
    assert client.post("/api/weighings", json={"items": [w0]}).json() == {"added": 1, "updated": 0}
    # the scale repeats the frame, then sends it again with impedance → only the impedance is filled in
    assert client.post("/api/weighings", json={"items": [w0, {**w0, "impedance": 500, "t": t + 3000}]}).json() == {"added": 0, "updated": 1}
    r = client.get("/api/weighings").json()
    assert r["profile"]["complete"] and len(r["items"]) == 1
    it = r["items"][0]
    assert it["impedance"] == 500 and it["t"] == t and abs(it["comp"]["fat_pct"] - 23.7) <= 0.1
    assert client.delete(f"/api/weighings/{it['id']}").json()["ok"]
    assert client.get("/api/weighings").json()["items"] == []
    # a deleted weighing does not come back when the phone resends it
    client.post("/api/weighings", json={"items": [w0]})
    assert client.get("/api/weighings").json()["items"] == []
    assert client.delete("/api/weighings/nope").status_code == 404
    assert client.post("/api/weighings", json={"items": [{**w0, "id": "bad id!"}]}).status_code == 422
