"""SQLite storage layer (plain sqlite3, one file, WAL mode)."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any, Iterator

DEFAULT_EXERCISES = [
    {"id": "pullups", "name": "Подтягивания", "kind": "sets", "sets": 5, "reps": 3, "unit": "раз", "position": 0, "active": True},
    {"id": "pushups", "name": "Отжимания", "kind": "sets", "sets": 5, "reps": 15, "unit": "раз", "position": 1, "active": True},
    {"id": "run", "name": "Бег", "kind": "distance", "sets": 1, "reps": 0, "unit": "км", "position": 2, "active": True},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sets','distance')),
    sets INTEGER NOT NULL DEFAULT 1,
    reps INTEGER NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD (client local date)
    data TEXT NOT NULL,              -- JSON: {"sets": {...}, "distance": {...}}
    updated_at INTEGER NOT NULL,     -- client timestamp, ms since epoch (LWW key)
    rev INTEGER NOT NULL             -- server change counter (sync cursor)
);
CREATE INDEX IF NOT EXISTS days_rev ON days(rev);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- v2: recorded workouts (added without touching existing tables; safe on old volumes)
CREATE TABLE IF NOT EXISTS workouts (
    id TEXT PRIMARY KEY,             -- client-generated id
    started_at INTEGER NOT NULL,     -- ms since epoch
    data TEXT NOT NULL,              -- JSON: summary + samples
    updated_at INTEGER NOT NULL,     -- client timestamp, LWW key
    deleted INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workouts_rev ON workouts(rev);
CREATE INDEX IF NOT EXISTS workouts_started ON workouts(started_at);
-- v1.4: raw ECG recordings (Polar H10), synced directly (not through /api/sync)
CREATE TABLE IF NOT EXISTS ecg (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    data TEXT NOT NULL,              -- JSON: metadata + samples_b64 (int16 LE, µV)
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ecg_started ON ecg(started_at);
-- v1.6: raw H10 accelerometer of a run (files on disk next to the DB) + offline running dynamics
CREATE TABLE IF NOT EXISTS acc (
    id TEXT PRIMARY KEY,
    workout_id TEXT,
    started_at INTEGER NOT NULL,
    meta TEXT NOT NULL,              -- JSON from the phone (fs, range, device, samples, ...)
    complete INTEGER NOT NULL DEFAULT 0,
    result TEXT,                     -- JSON: running dynamics (dynamics.analyze)
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acc_workout ON acc(workout_id);
-- v1.6: strap battery readings (the H10 reports % only)
CREATE TABLE IF NOT EXISTS strap_battery (
    t INTEGER NOT NULL,
    device TEXT NOT NULL,
    level INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (t, device)
);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        if path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        with self.tx() as c:
            if c.execute("SELECT COUNT(*) FROM exercises").fetchone()[0] == 0 and \
               c.execute("SELECT value FROM meta WHERE key='seeded'").fetchone() is None:
                for e in DEFAULT_EXERCISES:
                    self._insert_exercise(c, e)
                c.execute("INSERT OR REPLACE INTO meta VALUES ('seeded','1')")
            # v1.5: daily "Ходьба" (km) right after "Бег" — added once; if the user removes it later it stays removed
            if c.execute("SELECT value FROM meta WHERE key='walk_added'").fetchone() is None:
                if c.execute("SELECT 1 FROM exercises WHERE id='walk'").fetchone() is None:
                    run = c.execute("SELECT position FROM exercises WHERE id='run'").fetchone()
                    pos = (int(run[0]) + 1) if run else (c.execute("SELECT COALESCE(MAX(position),-1)+1 FROM exercises").fetchone()[0])
                    c.execute("UPDATE exercises SET position=position+1 WHERE position>=?", (pos,))
                    self._insert_exercise(c, {"id": "walk", "name": "Ходьба", "kind": "distance", "sets": 1, "reps": 0,
                                              "unit": "км", "position": pos, "active": True})
                # days before this date are not penalised for the new item (streaks / "full days" stay intact)
                import datetime as _dt
                from zoneinfo import ZoneInfo as _Z
                c.execute("INSERT OR REPLACE INTO meta VALUES ('walk_added',?)", (_dt.datetime.now(_Z("Europe/Moscow")).date().isoformat(),))

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def close(self) -> None:
        self._conn.close()

    # ---- exercises -------------------------------------------------------
    @staticmethod
    def _insert_exercise(c: sqlite3.Connection, e: dict[str, Any]) -> None:
        c.execute(
            "INSERT OR REPLACE INTO exercises (id,name,kind,sets,reps,unit,position,active) VALUES (?,?,?,?,?,?,?,?)",
            (e["id"], e["name"], e["kind"], int(e.get("sets", 1)), int(e.get("reps", 0)),
             e.get("unit", ""), int(e.get("position", 0)), 1 if e.get("active", True) else 0),
        )

    def exercise_since(self) -> dict[str, str]:
        """Exercises added after the start: id -> first date they count for completion."""
        with self._lock:
            r = self._conn.execute("SELECT value FROM meta WHERE key='walk_added'").fetchone()
        return {"walk": r[0]} if r and len(r[0]) == 10 else {}

    def list_exercises(self, include_inactive: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            q = "SELECT * FROM exercises" + ("" if include_inactive else " WHERE active=1") + " ORDER BY position, id"
            rows = self._conn.execute(q).fetchall()
        return [self._ex_row(r) for r in rows]

    @staticmethod
    def _ex_row(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        d["active"] = bool(d["active"])
        return d

    def replace_exercises(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Replace the configured list. Exercises missing from the new list are
        deactivated (not deleted) so historical stats keep their names."""
        with self.tx() as c:
            c.execute("UPDATE exercises SET active=0")
            for i, e in enumerate(items):
                e = {**e, "position": i if e.get("position") is None else e["position"]}
                self._insert_exercise(c, e)
        return self.list_exercises()

    # ---- days ------------------------------------------------------------
    def _next_rev(self, c: sqlite3.Connection) -> int:
        row = c.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
        rev = (int(row[0]) if row else 0) + 1
        c.execute("INSERT OR REPLACE INTO meta VALUES ('rev', ?)", (str(rev),))
        return rev

    def current_rev(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT value FROM meta WHERE key='rev'").fetchone()
        return int(row[0]) if row else 0

    @staticmethod
    def _day_row(r: sqlite3.Row) -> dict[str, Any]:
        data = json.loads(r["data"])
        return {"date": r["date"], "sets": data.get("sets", {}), "distance": data.get("distance", {}),
                "updated_at": r["updated_at"], "rev": r["rev"]}

    def get_day(self, date: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM days WHERE date=?", (date,)).fetchone()
        return self._day_row(r) if r else None

    def list_days(self, date_from: str | None = None, date_to: str | None = None) -> list[dict[str, Any]]:
        q, args = "SELECT * FROM days WHERE 1=1", []
        if date_from:
            q += " AND date>=?"; args.append(date_from)
        if date_to:
            q += " AND date<=?"; args.append(date_to)
        with self._lock:
            rows = self._conn.execute(q + " ORDER BY date", args).fetchall()
        return [self._day_row(r) for r in rows]

    def days_since(self, rev: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM days WHERE rev>? ORDER BY rev", (rev,)).fetchall()
        return [self._day_row(r) for r in rows]

    def upsert_day(self, rec: dict[str, Any], force: bool = False) -> tuple[bool, dict[str, Any]]:
        """Last-write-wins per day by client `updated_at`. Returns (applied, stored)."""
        with self.tx() as c:
            cur = c.execute("SELECT * FROM days WHERE date=?", (rec["date"],)).fetchone()
            if cur is not None and not force and int(cur["updated_at"]) >= int(rec["updated_at"]):
                return False, self._day_row(cur)
            rev = self._next_rev(c)
            data = json.dumps({"sets": rec.get("sets", {}), "distance": rec.get("distance", {})}, ensure_ascii=False)
            c.execute("INSERT OR REPLACE INTO days (date,data,updated_at,rev) VALUES (?,?,?,?)",
                      (rec["date"], data, int(rec["updated_at"]), rev))
            row = c.execute("SELECT * FROM days WHERE date=?", (rec["date"],)).fetchone()
            return True, self._day_row(row)

    # ---- workouts --------------------------------------------------------
    @staticmethod
    def _wk_row(r: sqlite3.Row, with_samples: bool = True) -> dict[str, Any]:
        d = json.loads(r["data"])
        d.update({"id": r["id"], "started_at": r["started_at"], "updated_at": r["updated_at"],
                  "deleted": bool(r["deleted"]), "rev": r["rev"]})
        if not with_samples:
            for k in ("samples", "step_series", "track", "segments", "session_samples", "session_rr", "motion", "tail"):
                d.pop(k, None)
        return d

    def upsert_workout(self, w: dict[str, Any], force: bool = False) -> tuple[bool, dict[str, Any]]:
        with self.tx() as c:
            cur = c.execute("SELECT * FROM workouts WHERE id=?", (w["id"],)).fetchone()
            if cur is not None and not force and int(cur["updated_at"]) >= int(w["updated_at"]):
                return False, self._wk_row(cur)
            rev = self._next_rev(c)
            data = {k: v for k, v in w.items() if k not in ("id", "started_at", "updated_at", "deleted", "rev")}
            if cur is not None:   # clients trim old series locally; an empty series never erases the stored one
                old = json.loads(cur["data"])
                for k in ("samples", "step_series", "track", "segments", "session_samples", "session_rr", "motion", "tail"):
                    if not data.get(k) and old.get(k):
                        data[k] = old[k]
            c.execute("INSERT OR REPLACE INTO workouts (id,started_at,data,updated_at,deleted,rev) VALUES (?,?,?,?,?,?)",
                      (w["id"], int(w["started_at"]), json.dumps(data, ensure_ascii=False),
                       int(w["updated_at"]), 1 if w.get("deleted") else 0, rev))
            return True, self._wk_row(c.execute("SELECT * FROM workouts WHERE id=?", (w["id"],)).fetchone())

    def get_workout(self, wid: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM workouts WHERE id=?", (wid,)).fetchone()
        return self._wk_row(r) if r else None

    def list_workouts(self, limit: int = 100, include_deleted: bool = False,
                      from_ms: int | None = None) -> list[dict[str, Any]]:
        q, args = "SELECT * FROM workouts WHERE 1=1", []
        if not include_deleted:
            q += " AND deleted=0"
        if from_ms is not None:
            q += " AND started_at>=?"; args.append(from_ms)
        q += " ORDER BY started_at DESC LIMIT ?"; args.append(limit)
        with self._lock:
            rows = self._conn.execute(q, args).fetchall()
        return [self._wk_row(r, with_samples=False) for r in rows]

    def workouts_with_session(self, limit: int) -> list[dict[str, Any]]:
        """Newest workouts that carry an HR session (full rows)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM workouts WHERE deleted=0 AND data LIKE '%\"session_samples\": [[%' "
                "ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._wk_row(r) for r in rows]

    # ---- ECG ----------------------------------------------------------------
    @staticmethod
    def _ecg_row(r: sqlite3.Row, full: bool) -> dict[str, Any]:
        d = json.loads(r["data"])
        d.update({"id": r["id"], "started_at": r["started_at"], "updated_at": r["updated_at"], "deleted": bool(r["deleted"])})
        if not full:
            d.pop("samples_b64", None)
        return d

    def upsert_ecg(self, e: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        with self.tx() as c:
            cur = c.execute("SELECT * FROM ecg WHERE id=?", (e["id"],)).fetchone()
            if cur is not None and int(cur["updated_at"]) >= int(e["updated_at"]):
                return False, self._ecg_row(cur, False)
            data = {k: v for k, v in e.items() if k not in ("id", "started_at", "updated_at", "deleted")}
            if cur is not None and not data.get("samples_b64"):
                data["samples_b64"] = json.loads(cur["data"]).get("samples_b64")
            c.execute("INSERT OR REPLACE INTO ecg (id,started_at,data,updated_at,deleted) VALUES (?,?,?,?,?)",
                      (e["id"], int(e["started_at"]), json.dumps(data, ensure_ascii=False), int(e["updated_at"]),
                       1 if e.get("deleted") else 0))
            return True, self._ecg_row(c.execute("SELECT * FROM ecg WHERE id=?", (e["id"],)).fetchone(), False)

    def get_ecg(self, eid: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM ecg WHERE id=?", (eid,)).fetchone()
        return self._ecg_row(r, True) if r else None

    def list_ecg(self, limit: int = 100, include_deleted: bool = False) -> list[dict[str, Any]]:
        q = "SELECT * FROM ecg" + ("" if include_deleted else " WHERE deleted=0") + " ORDER BY started_at DESC LIMIT ?"
        with self._lock:
            rows = self._conn.execute(q, (limit,)).fetchall()
        return [self._ecg_row(r, False) for r in rows]

    # ---- ACC (raw accelerometer) -------------------------------------------
    @staticmethod
    def _acc_row(r: sqlite3.Row) -> dict[str, Any]:
        d = {"id": r["id"], "workout_id": r["workout_id"], "started_at": r["started_at"], "complete": bool(r["complete"]),
             "updated_at": r["updated_at"], "meta": json.loads(r["meta"])}
        d["result"] = json.loads(r["result"]) if r["result"] else None
        return d

    def get_acc(self, aid: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM acc WHERE id=?", (aid,)).fetchone()
        return self._acc_row(r) if r else None

    def acc_for_workout(self, wid: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._conn.execute("SELECT * FROM acc WHERE workout_id=? AND complete=1 ORDER BY updated_at DESC LIMIT 1", (wid,)).fetchone()
        return self._acc_row(r) if r else None

    def list_acc(self, limit: int = 1000) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM acc ORDER BY started_at DESC LIMIT ?", (limit,)).fetchall()
        return [self._acc_row(r) for r in rows]

    def upsert_acc(self, a: dict[str, Any]) -> dict[str, Any]:
        import time as _t
        with self.tx() as c:
            c.execute("INSERT OR REPLACE INTO acc (id,workout_id,started_at,meta,complete,result,updated_at) VALUES (?,?,?,?,?,?,?)",
                      (a["id"], a.get("workout_id"), int(a.get("started_at") or 0), json.dumps(a.get("meta") or {}, ensure_ascii=False),
                       1 if a.get("complete") else 0, json.dumps(a["result"], ensure_ascii=False) if a.get("result") is not None else None,
                       int(_t.time() * 1000)))
            return self._acc_row(c.execute("SELECT * FROM acc WHERE id=?", (a["id"],)).fetchone())

    # ---- strap battery --------------------------------------------------------
    def add_battery(self, readings: list[dict[str, Any]]) -> int:
        k = 0
        with self.tx() as c:
            for r in readings:
                cur = c.execute("INSERT OR IGNORE INTO strap_battery (t,device,level,data) VALUES (?,?,?,?)",
                                (int(r["t"]), str(r.get("device") or ""), int(r["level"]), json.dumps(r, ensure_ascii=False)))
                k += cur.rowcount
        return k

    def list_battery(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT data FROM strap_battery ORDER BY t").fetchall()
        return [json.loads(r[0]) for r in rows]

    def workouts_since(self, rev: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM workouts WHERE rev>? ORDER BY rev", (rev,)).fetchall()
        return [self._wk_row(r) for r in rows]
