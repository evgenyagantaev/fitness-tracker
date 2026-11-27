"""Fitness tracker API + web UI (FastAPI)."""
from __future__ import annotations

import base64
import os
import re
import secrets
import datetime as _dt
from datetime import date as Date, datetime
from pathlib import Path
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
import hashlib
import json

from . import body, dynamics, phone_motion, stats
from .db import Database

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
STATIC_DIR = Path(os.environ.get("FITNESS_STATIC_DIR", Path(__file__).parent / "static"))
_ASSET_RE = re.compile(
    r'(?P<pre>(?:src|href)=")(?P<path>(?:vendor/)?[A-Za-z0-9_./-]+\.(?:js|css))"'
)


def web_build(static_dir: Path | None = None) -> str:
    """Short content hash of JS/CSS, used to cache-bust the web UI."""
    root = static_dir or STATIC_DIR
    h = hashlib.sha256()
    if root.is_dir():
        for pth in sorted(root.rglob("*")):
            if pth.is_file() and pth.suffix.lower() in {".js", ".css"}:
                h.update(pth.relative_to(root).as_posix().encode())
                h.update(b"\0")
                h.update(pth.read_bytes())
    return h.hexdigest()[:8]


def render_index_html(static_dir: Path, build: str) -> str:
    html = (static_dir / "index.html").read_text(encoding="utf-8")
    html = _ASSET_RE.sub(rf'\g<pre>\g<path>?v={build}"', html)
    boot = (
        f'<script>window.FT_BUILD={json.dumps(build)};'
        'document.addEventListener("DOMContentLoaded",function(){'
        'var b=window.FT_BUILD;if(!b)return;'
        'var f=document.getElementById("webBuildFoot");'
        'if(f){f.hidden=false;f.textContent="сборка "+b;}'
        'var s=document.getElementById("webBuild");'
        'if(s){s.hidden=false;s.textContent="Сборка сайта: "+b;}'
        '});</script>\n'
    )
    html = html.replace("<body>", "<body>\n  " + boot, 1)
    return html


class VersionedStaticFiles(StaticFiles):
    """Cache-Control: no-cache for HTML and unversioned JS/CSS; long cache when ?v= is present."""

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code >= 400:
            return resp
        qs = (scope.get("query_string") or b"").decode("latin-1")
        lowered = (path or "").lower()
        if lowered.endswith(".html") or lowered in ("", ".", "/"):
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        elif "v=" in qs and lowered.endswith((".js", ".css", ".png", ".svg", ".woff", ".woff2", ".webmanifest")):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif lowered.endswith((".js", ".css")):
            # Yandex Browser caches unversioned scripts aggressively
            resp.headers["Cache-Control"] = "no-cache"
        else:
            resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp


def _check_date(v: str) -> str:
    if not DATE_RE.match(v):
        raise ValueError("date must be YYYY-MM-DD")
    Date.fromisoformat(v)
    return v


class CountedSet(BaseModel):
    """v1.10: a set counted by the phone (proximity sensor): real reps instead of the board's planned `reps`."""
    id: str = Field(max_length=64)
    reps: int = Field(ge=0, le=1000)


class Cell(BaseModel):
    """v1.11 board: one filled cell (a set) with its own reps; `id` is the phone-counted set's id (src="auto")."""
    reps: int = Field(ge=1, le=10000)
    id: str | None = Field(default=None, max_length=64)
    src: Literal["manual", "auto"] | None = None


class SetsEntry(BaseModel):
    reps: int = Field(default=0, ge=0, le=10000)           # legacy: planned reps of the old fixed sets
    done: list[bool] = Field(default=[], max_length=50)     # legacy
    counted: list[CountedSet | None] | None = Field(default=None, max_length=50)   # legacy (v1.10), aligned with `done`
    cells: list[Cell] | None = Field(default=None, max_length=200)   # v1.11: filled cells only; wins over the legacy fields


class DistanceEntry(BaseModel):
    done: bool = False
    km: float = Field(default=0, ge=0, le=1000)


class DayRecord(BaseModel):
    date: str
    sets: dict[str, SetsEntry] = {}
    distance: dict[str, DistanceEntry] = {}
    updated_at: int = Field(ge=0, description="client timestamp, ms since epoch (last-write-wins key)")

    @field_validator("date")
    @classmethod
    def _v_date(cls, v: str) -> str:
        return _check_date(v)


class DayBody(BaseModel):
    sets: dict[str, SetsEntry] = {}
    distance: dict[str, DistanceEntry] = {}
    updated_at: int | None = None


class Exercise(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["sets", "distance"]
    sets: int = Field(default=1, ge=1, le=50)
    reps: int = Field(default=0, ge=0, le=10000)
    unit: str = Field(default="", max_length=10)
    position: int | None = None
    active: bool = True

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError("id: a-z, 0-9, _ or -, up to 32 chars")
        return v


class HrStats(BaseModel):
    avg: float | None = Field(default=None, ge=0, le=300)
    max: int | None = Field(default=None, ge=0, le=300)
    min: int | None = Field(default=None, ge=0, le=300)


class Quality(BaseModel):
    """HR signal quality of a workout: stretches masked as cadence lock / double-counted beats."""
    mask: list[tuple[float, float]] = Field(default=[], max_length=2000)
    masked_s: float = Field(default=0, ge=0, le=7 * 86400)
    masked_pct: float = Field(default=0, ge=0, le=100)
    rr_artifacts_pct: float | None = Field(default=None, ge=0, le=100)
    label: Literal["good", "fair", "poor"] = "good"


class Inherit(BaseModel):
    """Back-to-back run: baseline / pre-run HRV taken from the first run of the same HR session."""
    of: str = Field(max_length=64)
    baseline: float | None = None
    hrv_pre: dict[str, float | None] | None = Field(default=None, max_length=10)


class Workout(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{6,64}$")
    type: Literal["run", "workout", "walk"] = "run"
    date: str
    started_at: int = Field(ge=0)
    ended_at: int | None = Field(default=None, ge=0)
    duration_s: float = Field(default=0, ge=0, le=7 * 86400)
    steps: int = Field(default=0, ge=0, le=1_000_000)
    stride_m: float = Field(default=0.75, gt=0, le=3)
    distance_m: float = Field(default=0, ge=0, le=1_000_000)
    hr: HrStats = HrStats()
    samples: list[tuple[float, int]] = Field(default=[], max_length=200_000,
                                             description="[seconds since start, bpm]")
    device: str | None = Field(default=None, max_length=80)
    note: str | None = Field(default=None, max_length=500)
    # v1.3: motion analytics (all optional, older clients simply omit them)
    step_distance_m: float | None = Field(default=None, ge=0, le=1_000_000)
    moving_s: float | None = Field(default=None, ge=0, le=7 * 86400)
    stop_s: float = Field(default=0, ge=0, le=7 * 86400)
    stops: int = Field(default=0, ge=0, le=100_000)
    cadence_avg: float | None = Field(default=None, ge=0, le=400)
    gps_distance_m: float | None = Field(default=None, ge=0, le=1_000_000)
    gps_ok: bool = False
    gps_acc: float | None = Field(default=None, ge=0, le=10_000)
    gps_coverage: float | None = Field(default=None, ge=0, le=1)
    gps_stride_m: float | None = Field(default=None, ge=0, le=5)
    stride_source: Literal["manual", "auto"] | None = None
    step_series: list[tuple[float, int]] = Field(default=[], max_length=200_000,
                                                 description="[seconds since start, cumulative steps]")
    track: list[tuple[float, float, float, float]] = Field(default=[], max_length=200_000,
                                                          description="[seconds, lat, lon, accuracy m]")
    # v1.4: HR session around the workout (pre-run monitoring + post-run recovery)
    session_start: int | None = Field(default=None, ge=0)
    session_end: int | None = Field(default=None, ge=0)
    session_samples: list[tuple[float, int]] = Field(default=[], max_length=200_000,
                                                     description="[sec relative to workout start (negative = before), bpm]")
    recovery: dict[str, float | int | None] | None = Field(default=None, max_length=40)
    session_rr: list[tuple[float, int]] = Field(default=[], max_length=400_000,
                                                description="RR intervals: [beat time, sec relative to workout start; rr ms]")
    segments: list[tuple[float, float, int, float, float | None, float]] = Field(
        default=[], max_length=20_000,
        description="100-step segments: [t_start, t_end, steps, dist_by_steps_m, dist_gps_m, moving_s]")
    # v1.5.2: derived analytics (re-computable from the raw data above; raw is never altered)
    analysis_v: int | None = Field(default=None, ge=0, le=100)
    quality: Quality | None = None
    hr_raw: HrStats | None = None
    steps_start_missed: int | None = Field(default=None, ge=0, le=100_000)
    cal_steps: int | None = Field(default=None, ge=0, le=1_000_000)
    cal_gps_m: float | None = Field(default=None, ge=0, le=1_000_000)
    tail_cut: float | None = Field(default=None, ge=-7 * 86400, le=7 * 86400)
    inherit: Inherit | None = None
    # v1.7: run segmentation (derived; raw data above is never altered). seg = {t0, t1, pauses, approach_s, cooldown_s, …} in
    # seconds from «Старт»; run_override = [t0|null, t1|null] set by hand; pause_override = [[t0,t1],…] replaces auto pauses
    # (including an empty list: no pauses). motion = phone-accelerometer profile [t, cadence, energy g]
    beltless: bool | None = None
    seg: dict[str, Any] | None = Field(default=None, max_length=40)
    run_override: list[float | None] | None = Field(default=None, max_length=2)
    pause_override: list[tuple[float, float]] | None = Field(default=None, max_length=500)
    motion: list[tuple[float, int | None, float | None]] = Field(default=[], max_length=50_000)
    tail: dict[str, Any] | None = Field(default=None, max_length=10)   # raw steps/track recorded after an automatic end
    auto_end: dict[str, Any] | None = Field(default=None, max_length=10)
    # v1.16: the pauses the phone's live detector saw ([start_s, end_s] since «Старт»; when present they are the run's stops) and its
    # decision log (timestamps of pause/resume decisions, strap data staleness and voice queue timings; no coordinates)
    phone_pauses: list[tuple[float, float]] | None = Field(default=None, max_length=500)
    live_log: list[Annotated[str, Field(max_length=300)]] | None = Field(default=None, max_length=600)
    updated_at: int = Field(ge=0)
    deleted: bool = False

    @field_validator("date")
    @classmethod
    def _v_date(cls, v: str) -> str:
        return _check_date(v)


class Ecg(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{6,64}$")
    started_at: int = Field(ge=0)
    fs: int = Field(default=130, ge=50, le=1000)
    n: int = Field(ge=1, le=1000 * 1200)
    duration_s: float = Field(ge=0, le=7200)
    samples_b64: str | None = Field(default=None, max_length=4_000_000, description="int16 little-endian µV, base64")
    r_peaks: list[int] = Field(default=[], max_length=50_000)
    hr_avg: float | None = Field(default=None, ge=0, le=300)
    rmssd: float | None = Field(default=None, ge=0, le=1000)
    sdnn: float | None = Field(default=None, ge=0, le=1000)
    device: str | None = Field(default=None, max_length=80)
    note: str | None = Field(default=None, max_length=500)
    session_start: int | None = None
    phase: str | None = Field(default=None, max_length=20)
    workout_id: str | None = Field(default=None, max_length=64)
    updated_at: int = Field(ge=0)
    deleted: bool = False

    @field_validator("samples_b64")
    @classmethod
    def _b64(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            raw = base64.b64decode(v, validate=True)
        except Exception:
            raise ValueError("samples_b64 must be base64")
        if len(raw) % 2:
            raise ValueError("samples_b64 must hold int16 values")
        return v


class SyncRequest(BaseModel):
    since: int = Field(default=0, ge=0, description="last server rev the client has seen")
    records: list[DayRecord] = Field(default=[], max_length=5000)
    workouts: list[Workout] = Field(default=[], max_length=500)



WEIGH_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
BIRTH_RE = re.compile(r"^\d{4}(-\d{2}-\d{2})?$")


class Profile(BaseModel):
    """For body composition: height, birth year or date, sex. Empty = not filled in yet."""
    height_cm: float | None = Field(default=None, ge=100, le=230)
    birth: str | None = None
    sex: Literal["m", "f"] | None = None

    @field_validator("birth")
    @classmethod
    def _v_birth(cls, v: str | None) -> str | None:
        if v in (None, ""):
            return None
        if not BIRTH_RE.match(v):
            raise ValueError("birth: YYYY or YYYY-MM-DD")
        y = int(v[:4])
        if not 1900 <= y <= Date.today().year:
            raise ValueError("birth year out of range")
        if len(v) == 10:
            Date.fromisoformat(v)
        return v


class Weighing(BaseModel):
    id: str
    t: int = Field(ge=1_500_000_000_000, le=4_000_000_000_000)
    weight_kg: float = Field(ge=5, le=250)
    impedance: int | None = Field(default=None, ge=0, le=5000)
    source: str = Field(default="mi-scale-2", max_length=40)
    scale_time: str | None = Field(default=None, max_length=32)
    unit: str | None = Field(default=None, max_length=8)
    device: str | None = Field(default=None, max_length=40)

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not WEIGH_ID_RE.match(v):
            raise ValueError("bad weighing id")
        return v


class PushupSet(BaseModel):
    id: str
    t: int = Field(ge=1_500_000_000_000, le=4_000_000_000_000)
    reps: int = Field(ge=1, le=1000)
    duration_s: float = Field(default=0, ge=0, le=7200)
    armed_s: float | None = Field(default=None, ge=0, le=86400)
    source: str = Field(default="proximity", max_length=40)
    device: str | None = Field(default=None, max_length=40)

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not WEIGH_ID_RE.match(v):
            raise ValueError("bad set id")
        return v


class PushupBatch(BaseModel):
    items: list[PushupSet] = Field(max_length=500)


class WeighingBatch(BaseModel):
    items: list[Weighing] = Field(max_length=500)


def create_app(db_path: str | None = None, token: str | None = None) -> FastAPI:
    db_path = db_path or os.environ.get("FITNESS_DB", "/data/fitness.db")
    token = token if token is not None else os.environ.get("FITNESS_API_TOKEN", "")
    tz = ZoneInfo(os.environ.get("FITNESS_TZ", "Europe/Moscow"))
    origins = [o.strip() for o in os.environ.get(
        "FITNESS_CORS_ORIGINS", "https://localhost,http://localhost,capacitor://localhost").split(",") if o.strip()]

    app = FastAPI(title="Фитнес-трекер API", version="1.0.0",
                  root_path=os.environ.get("FITNESS_ROOT_PATH", ""))
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"],
                       allow_headers=["Authorization", "Content-Type"], allow_credentials=False)
    db = Database(db_path)
    app.state.db = db

    def auth(authorization: Annotated[str | None, Header()] = None) -> None:
        if not token:
            raise HTTPException(503, "Server has no FITNESS_API_TOKEN configured")
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token", headers={"WWW-Authenticate": "Bearer"})
        if not secrets.compare_digest(authorization[7:].strip().encode(), token.encode()):
            raise HTTPException(401, "Invalid token", headers={"WWW-Authenticate": "Bearer"})

    def today(q: str | None) -> Date:
        if q:
            try:
                return Date.fromisoformat(_check_date(q))
            except ValueError:
                raise HTTPException(422, "bad today")
        return datetime.now(tz).date()

    def metrics(date_from: str | None = None, date_to: str | None = None):
        ex = db.list_exercises(include_inactive=True)
        active = [e for e in ex if e["active"]]
        since = db.exercise_since()
        return [stats.day_metrics(r, active, since) for r in db.list_days(date_from, date_to)]

    A = [Depends(auth)]

    @app.get("/api/health")
    def health():
        out = {"ok": True, "rev": db.current_rev()}
        if getattr(app.state, "web_build", None):
            out["web"] = app.state.web_build
        return out

    @app.get("/api/auth/check", dependencies=A)
    def auth_check():
        return {"ok": True}

    # ---- exercises ----
    @app.get("/api/exercises", dependencies=A)
    def get_exercises(include_inactive: bool = False):
        return db.list_exercises(include_inactive)

    @app.put("/api/exercises", dependencies=A)
    def put_exercises(items: list[Exercise]):
        ids = [i.id for i in items]
        if len(set(ids)) != len(ids):
            raise HTTPException(422, "duplicate exercise ids")
        return db.replace_exercises([i.model_dump() for i in items])

    # ---- days ----
    @app.get("/api/days", dependencies=A)
    def list_days(date_from: Annotated[str | None, Query(alias="from")] = None,
                  date_to: Annotated[str | None, Query(alias="to")] = None):
        return db.list_days(date_from, date_to)

    @app.get("/api/days/{day}", dependencies=A)
    def get_day(day: str):
        _validate_path_date(day)
        rec = db.get_day(day)
        if rec is None:
            raise HTTPException(404, "no record")
        return rec

    @app.put("/api/days/{day}", dependencies=A)
    def put_day(day: str, body: DayBody, force: bool = False):
        _validate_path_date(day)
        rec = body.model_dump()
        rec["date"] = day
        if rec["updated_at"] is None:
            rec["updated_at"] = int(datetime.now().timestamp() * 1000)
        applied, stored = db.upsert_day(rec, force=force)
        return {"applied": applied, "record": stored}

    # ---- sync ----
    @app.post("/api/sync", dependencies=A)
    def sync(req: SyncRequest):
        applied, rejected = [], []
        for r in req.records:
            ok, _ = db.upsert_day(r.model_dump())
            (applied if ok else rejected).append(r.date)
        w_applied, w_rejected = [], []
        for w in req.workouts:
            ok, _ = db.upsert_workout(w.model_dump())
            (w_applied if ok else w_rejected).append(w.id)
        # Everything changed since the client's cursor, including what it just pushed
        # (so the client learns the new revs) and any newer server-side versions.
        return {"applied": applied, "rejected": rejected, "records": db.days_since(req.since),
                "workouts_applied": w_applied, "workouts_rejected": w_rejected,
                "workouts": db.workouts_since(req.since),
                "rev": db.current_rev(), "exercises": db.list_exercises()}

    # ---- workouts ----
    @app.get("/api/workouts", dependencies=A)
    def list_workouts(limit: Annotated[int, Query(ge=1, le=1000)] = 100, include_deleted: bool = False):
        return db.list_workouts(limit, include_deleted)

    @app.get("/api/workouts/{wid}", dependencies=A)
    def get_workout(wid: str):
        w = db.get_workout(wid)
        if w is None or w["deleted"]:
            raise HTTPException(404, "no workout")
        return w

    @app.put("/api/workouts/{wid}", dependencies=A)
    def put_workout(wid: str, body: Workout, force: bool = False):
        if body.id != wid:
            raise HTTPException(422, "id mismatch")
        applied, stored = db.upsert_workout(body.model_dump(), force=force)
        stored.pop("samples", None)
        return {"applied": applied, "workout": stored}

    @app.delete("/api/workouts/{wid}", dependencies=A)
    def delete_workout(wid: str):
        w = db.get_workout(wid)
        if w is None:
            raise HTTPException(404, "no workout")
        w.update(deleted=True, updated_at=max(int(datetime.now().timestamp() * 1000), w["updated_at"] + 1))
        db.upsert_workout(w, force=True)
        return {"ok": True}

    # ---- stats ----
    @app.get("/api/stats/streaks", dependencies=A)
    def get_streaks(today_q: Annotated[str | None, Query(alias="today")] = None):
        return stats.streaks(metrics(), today(today_q))

    @app.get("/api/stats/summary", dependencies=A)
    def get_summary(period: Literal["week", "month"] = "week",
                    count: Annotated[int, Query(ge=1, le=120)] = 12,
                    today_q: Annotated[str | None, Query(alias="today")] = None):
        return stats.summary(metrics(), period, count, today(today_q))

    @app.get("/api/stats/daily", dependencies=A)
    def get_daily(date_from: Annotated[str | None, Query(alias="from")] = None,
                  date_to: Annotated[str | None, Query(alias="to")] = None):
        return metrics(date_from, date_to)

    @app.get("/api/stats/runs", dependencies=A)
    def get_runs(type_q: Annotated[Literal["run", "walk", "workout", "all"], Query(alias="type")] = "run",
                 limit: Annotated[int, Query(ge=1, le=1000)] = 50):
        ws = db.list_workouts(limit=100000)
        out = stats.runs(ws, type_q, limit)
        dyn = {a["workout_id"]: a["result"] for a in db.list_acc(100000) if a.get("workout_id") and (a.get("result") or {}).get("ok") and (a.get("result") or {}).get("kind") != "phone"}
        for r in out:
            d = dyn.get(r["id"])
            if d:
                r["dyn"] = {k: (d[k]["med"] if isinstance(d.get(k), dict) else d.get(k))
                            for k in ("cadence", "vo_cm", "gct_ms", "flight_ms", "impact_g", "sway_cm", "vratio_pct", "balance_l_pct", "step_len_m")}
        return out

    # ---- ECG (Polar H10) ----
    @app.get("/api/ecg", dependencies=A)
    def list_ecg(limit: Annotated[int, Query(ge=1, le=1000)] = 100):
        return db.list_ecg(limit)

    @app.get("/api/ecg/{eid}", dependencies=A)
    def get_ecg(eid: str):
        e = db.get_ecg(eid)
        if e is None or e.get("deleted"):
            raise HTTPException(404, "no ecg")
        return e

    @app.put("/api/ecg/{eid}", dependencies=A)
    def put_ecg(eid: str, body: Ecg):
        if body.id != eid:
            raise HTTPException(422, "id mismatch")
        if body.samples_b64 is not None and len(base64.b64decode(body.samples_b64)) != body.n * 2:
            raise HTTPException(422, "n does not match samples")
        applied, stored = db.upsert_ecg(body.model_dump())
        return {"applied": applied, "ecg": stored}

    @app.delete("/api/ecg/{eid}", dependencies=A)
    def delete_ecg(eid: str):
        e = db.get_ecg(eid)
        if e is None:
            raise HTTPException(404, "no ecg")
        e.update(deleted=True, updated_at=int(e["updated_at"]) + 1)
        db.upsert_ecg(e)
        return {"ok": True}

    # ---- raw accelerometer (Polar H10) → running dynamics ----
    acc_root = Path(db_path).parent / "acc" if db_path != ":memory:" else Path(os.environ.get("TMPDIR", "/tmp")) / "fitness-acc"

    def acc_dir(aid: str) -> Path:
        if not re.match(r"^[A-Za-z0-9_-]{1,80}$", aid):
            raise HTTPException(422, "bad id")
        return acc_root / aid

    def acc_sizes(aid: str) -> dict:
        d = acc_dir(aid)
        return {"data": (d / "data.bin").stat().st_size if (d / "data.bin").exists() else 0,
                "frames": (d / "frames.csv").stat().st_size if (d / "frames.csv").exists() else 0}

    def _seg_key(w: dict | None) -> str:
        sg = (w or {}).get("seg") or {}
        ps = ",".join(f"{x[0]}-{x[1]}" for x in (sg.get("pauses") or []) if isinstance(x, (list, tuple)) and len(x) >= 2)
        return f"{sg.get('t0')}:{sg.get('t1')}:{ps}:{sg.get('src')}"

    def analyze_acc(aid: str, meta: dict, workout_id: str | None) -> dict:
        d = acc_dir(aid)
        w = db.get_workout(workout_id) if workout_id else None
        try:
            if meta.get("source") == "phone":
                return phone_motion.analyze((d / "data.bin").read_bytes(), (d / "frames.csv").read_text(), meta, w)
            res = dynamics.analyze((d / "data.bin").read_bytes(), (d / "frames.csv").read_text(), meta, w)
            if meta.get("partial"):
                res["partial"] = meta["partial"]
            res["seg_key"] = _seg_key(w)
            return res
        except Exception as e:  # noqa: BLE001
            return {"v": dynamics.DYN_V, "ok": False, "reason": f"ошибка анализа: {e}"}

    @app.get("/api/acc", dependencies=A)
    def list_acc():
        out = db.list_acc()
        for a in out:
            if a.get("result"):
                a["result"].pop("series", None)
        return out

    @app.get("/api/acc/{aid}", dependencies=A)
    def get_acc(aid: str):
        a = db.get_acc(aid)
        return {"record": a, "sizes": acc_sizes(aid)}

    @app.put("/api/acc/{aid}/chunk", dependencies=A)
    async def put_acc_chunk(aid: str, request: Request, file: Literal["data", "frames"] = "data",
                            offset: Annotated[int, Query(ge=0)] = 0):
        import zlib
        body = await request.json()
        try:
            raw = zlib.decompress(base64.b64decode(body["b64"]))
        except Exception:  # noqa: BLE001
            raise HTTPException(422, "bad chunk")
        # v1.6.1: the phone sends CRC32 of the raw slice it read → a corrupted transfer is rejected
        if body.get("crc32") is not None and (zlib.crc32(raw) & 0xFFFFFFFF) != int(body["crc32"]) & 0xFFFFFFFF:
            raise HTTPException(422, "chunk crc32 mismatch")
        if body.get("len") is not None and int(body["len"]) != len(raw):
            raise HTTPException(422, "chunk length mismatch")
        d = acc_dir(aid)
        d.mkdir(parents=True, exist_ok=True)
        f = d / ("data.bin" if file == "data" else "frames.csv")
        size = f.stat().st_size if f.exists() else 0
        if offset > size:
            raise HTTPException(409, f"offset {offset} > size {size}")
        with open(f, "r+b" if f.exists() else "wb") as fh:
            fh.seek(offset); fh.write(raw); fh.truncate(offset + len(raw))
        return acc_sizes(aid)

    @app.post("/api/acc/{aid}/finish", dependencies=A)
    def finish_acc(aid: str, meta: dict):
        import hashlib
        sz = acc_sizes(aid)
        n = int(meta.get("samples") or 0)
        if sz["data"] != n * 6:
            raise HTTPException(409, f"data size {sz['data']} != samples*6 ({n * 6})")
        # v1.6.1: whole-file SHA-256 computed on the phone over its own file; the phone deletes its copy only after this OK
        d = acc_dir(aid)
        got = {"data": hashlib.sha256((d / "data.bin").read_bytes()).hexdigest(),
               "frames": hashlib.sha256((d / "frames.csv").read_bytes()).hexdigest() if (d / "frames.csv").exists() else None}
        for k in ("data", "frames"):
            want = meta.get("sha256_" + k)
            if want and want != got[k]:
                raise HTTPException(409, f"{k} sha256 mismatch")
        meta = {**meta, "verified": bool(meta.get("sha256_data"))}
        wid = meta.get("workout_id")
        base = {"id": aid, "workout_id": wid, "started_at": meta.get("started_at") or 0, "meta": meta, "complete": True}
        if n > 200 * 60 * 15 and not os.environ.get("FITNESS_SYNC_ANALYSIS"):
            # long runs: answer at once (the phone's request times out after 15 s), analyse in the background
            import threading
            rec = db.upsert_acc({**base, "result": None})
            threading.Thread(target=lambda: db.upsert_acc({**base, "result": analyze_acc(aid, meta, wid)}), daemon=True).start()
            rec["sha256_data"] = got["data"]
            return rec
        rec = db.upsert_acc({**base, "result": analyze_acc(aid, meta, wid)})
        rec["sha256_data"] = got["data"]
        return rec

    @app.get("/api/workouts/{wid}/dynamics", dependencies=A)
    def get_dynamics(wid: str, reanalyze: bool = False):
        a = db.acc_for_workout(wid)
        if a is None:
            raise HTTPException(404, "no acc")
        r = a.get("result") or {}
        if not r:
            a = db.upsert_acc({**a, "result": analyze_acc(a["id"], a["meta"], wid)})
            r = a["result"]
        phone = a["meta"].get("source") == "phone"
        w_now = db.get_workout(wid) or {}
        seg_key = _seg_key(w_now)
        if phone:
            if reanalyze or r.get("v") != phone_motion.PHONE_V:
                a = db.upsert_acc({**a, "result": analyze_acc(a["id"], a["meta"], wid)})
            return a
        if reanalyze or r.get("v") != dynamics.DYN_V or r.get("seg_key", seg_key) != seg_key or (
                r.get("ok") and "step_len_m" not in r and (db.get_workout(wid) or {}).get("distance_m")):
            a = db.upsert_acc({**a, "result": analyze_acc(a["id"], a["meta"], wid)})
        return a

    @app.post("/api/strap-battery", dependencies=A)
    def post_battery(body: dict):
        rs = [r for r in body.get("readings", []) if isinstance(r, dict) and "t" in r and "level" in r
              and 0 <= int(r["level"]) <= 100]
        return {"added": db.add_battery(rs)}

    @app.get("/api/stats/strap-battery", dependencies=A)
    def get_battery():
        return stats.strap_battery(db.list_battery())

    @app.get("/api/stats/recovery", dependencies=A)
    def get_recovery(limit: Annotated[int, Query(ge=1, le=200)] = 40,
                     bin_s: Annotated[int, Query(ge=1, le=30)] = 3):
        return stats.recovery_curves(db.workouts_with_session(limit), bin_s)

    @app.get("/api/stats/calibration", dependencies=A)
    def get_calibration():
        return stats.calibration(db.list_workouts(limit=100000))

    @app.get("/api/stats/totals", dependencies=A)
    def get_totals():
        t = stats.totals(metrics())
        ws = db.list_workouts(limit=100000)
        t["workouts"] = {"count": len(ws),
                         "duration_s": round(sum(w.get("duration_s", 0) for w in ws)),
                         "distance_m": round(sum(w.get("distance_m", 0) for w in ws)),
                         "steps": sum(w.get("steps", 0) for w in ws),
                         "moving_s": round(sum(w.get("moving_s") or w.get("duration_s", 0) for w in ws))}
        return t

    # ---- v1.9: smart scale --------------------------------------------------------
    def _with_comp(w: dict, prof: dict) -> dict:
        when = _dt.datetime.fromtimestamp(w["t"] / 1000, ZoneInfo(os.environ.get("FITNESS_TZ", "Europe/Moscow"))).date()
        return {**w, "comp": body.compose(w["weight_kg"], w.get("impedance"), prof, when)}

    @app.get("/api/profile", dependencies=A)
    def get_profile():
        return {**db.get_profile(), "complete": body.profile_ok(db.get_profile())}

    @app.put("/api/profile", dependencies=A)
    def put_profile(p: Profile):
        d = p.model_dump()
        db.put_profile(d)
        return {**d, "complete": body.profile_ok(d)}

    @app.post("/api/weighings", dependencies=A)
    def post_weighings(body_: WeighingBatch):
        return db.add_weighings([w.model_dump() for w in body_.items])

    @app.get("/api/weighings", dependencies=A)
    def list_weighings():
        prof = db.get_profile()
        return {"profile": {**prof, "complete": body.profile_ok(prof)},
                "items": [_with_comp(w, prof) for w in db.list_weighings()]}

    @app.delete("/api/weighings/{wid}", dependencies=A)
    def delete_weighing(wid: str):
        if not db.delete_weighing(wid):
            raise HTTPException(404, "not found")
        return {"ok": True}

    # ---- v1.10: push-up sets counted by the proximity sensor ----
    @app.post("/api/pushups", dependencies=A)
    def post_pushups(b: PushupBatch):
        return db.add_pushup_sets([x.model_dump() for x in b.items])

    @app.get("/api/pushups", dependencies=A)
    def list_pushups(days: Annotated[int, Query(ge=1, le=3650)] = 60):
        now = datetime.now(tz)
        since = int((now - _dt.timedelta(days=days)).timestamp() * 1000)
        out = []
        for w in db.list_pushup_sets(since):
            out.append({**w, "date": datetime.fromtimestamp(w["t"] / 1000, tz).date().isoformat()})
        return {"items": out}

    @app.delete("/api/pushups/{sid}", dependencies=A)
    def delete_pushup(sid: str):
        if not db.delete_pushup_set(sid):
            raise HTTPException(404, "not found")
        return {"ok": True}

    if STATIC_DIR.is_dir():
        build = web_build(STATIC_DIR)
        app.state.web_build = build

        def index_page():
            return HTMLResponse(
                render_index_html(STATIC_DIR, build),
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )

        app.add_api_route("/", index_page, methods=["GET", "HEAD"], include_in_schema=False)
        app.add_api_route("/index.html", index_page, methods=["GET", "HEAD"], include_in_schema=False)
        app.mount("/", VersionedStaticFiles(directory=STATIC_DIR, html=False), name="web")

    return app


def _validate_path_date(day: str) -> None:
    try:
        _check_date(day)
    except ValueError:
        raise HTTPException(422, "date must be YYYY-MM-DD")


app = create_app() if os.environ.get("FITNESS_NO_AUTOAPP") != "1" else None
