from fastapi.testclient import TestClient

from app.main import web_build, STATIC_DIR
from .conftest import TOKEN


def test_index_is_not_cached_and_assets_are_versioned(client):
    build = web_build(STATIC_DIR)
    raw = TestClient(client.app)
    r = raw.get("/")
    assert r.status_code == 200
    assert "Фитнес-трекер" in r.text
    assert f"workout.js?v={build}" in r.text
    assert f"app.css?v={build}" in r.text
    assert f"core.js?v={build}" in r.text
    assert f"vendor/chart.umd.min.js?v={build}" in r.text
    assert f'window.FT_BUILD="{build}"' in r.text
    assert 'src="workout.js"' not in r.text
    cc = r.headers.get("cache-control", "").lower()
    assert "no-cache" in cc or "no-store" in cc
    r2 = raw.get("/index.html")
    assert r2.status_code == 200 and f"workout.js?v={build}" in r2.text
    assert "no-cache" in r2.headers.get("cache-control", "").lower()
    head = raw.head("/")
    assert head.status_code == 200
    assert "no-cache" in head.headers.get("cache-control", "").lower()


def test_versioned_assets_are_cached_unversioned_js_is_not(client):
    build = web_build(STATIC_DIR)
    raw = TestClient(client.app)
    ver = raw.get(f"/workout.js?v={build}")
    assert ver.status_code == 200
    assert "initChartEditor" in ver.text or "function" in ver.text
    assert "immutable" in ver.headers.get("cache-control", "").lower()
    assert "max-age=31536000" in ver.headers.get("cache-control", "").lower()
    bare = raw.get("/workout.js")
    assert bare.status_code == 200
    assert "no-cache" in bare.headers.get("cache-control", "").lower()
    css = raw.get(f"/app.css?v={build}")
    assert css.status_code == 200
    assert "immutable" in css.headers.get("cache-control", "").lower()


def test_health_includes_web_build(client):
    build = web_build(STATIC_DIR)
    r = TestClient(client.app).get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["web"] == build
