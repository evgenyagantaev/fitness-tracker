/* Фитнес-трекер: offline-first store + sync. Shared by the web page and the Android app. */
(function () {
  'use strict';
  const LS = window.localStorage;
  const K = { workouts: 'ft.workouts', wdirty: 'ft.wdirty', config: 'ft.config', exercises: 'ft.exercises', days: 'ft.days', dirty: 'ft.dirty', rev: 'ft.rev', lastSync: 'ft.lastSync' };

  const DEFAULT_EXERCISES = [
    { id: 'pullups', name: 'Подтягивания', kind: 'sets', sets: 5, reps: 3, unit: 'раз' },
    { id: 'pushups', name: 'Отжимания', kind: 'sets', sets: 5, reps: 15, unit: 'раз' },
    { id: 'run', name: 'Бег', kind: 'distance', sets: 1, reps: 0, unit: 'км' },
    { id: 'walk', name: 'Ходьба', kind: 'distance', sets: 1, reps: 0, unit: 'км' },
  ];
  const DEFAULT_CONFIG = { serverUrl: '', token: '', notif: { enabled: true, start: 9, end: 21, every: 1 } };

  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function load(key, fallback) {
    try { const v = LS.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function save(key, value) { LS.setItem(key, JSON.stringify(value)); }

  function localDate(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** Filled cells of a rep exercise (mirrors server stats.cells_of). Legacy done[]/counted[] are read, never rewritten. */
  function cellsOf(e, plannedReps) {
    if (!e) return [];
    if (Array.isArray(e.cells)) return e.cells.filter((c) => c && c.reps > 0).map((c) => Object.assign({}, c));
    const per = e.reps != null ? e.reps : (plannedReps || 0), out = [];
    (e.done || []).forEach((d, i) => {
      if (!d) return;
      const c = e.counted && e.counted[i];
      const reps = c ? c.reps : per;
      if (reps > 0) out.push(c ? { reps, id: c.id, src: 'auto' } : { reps, src: 'manual' });
    });
    return out;
  }

  const Store = {
    config() { return Object.assign({}, DEFAULT_CONFIG, load(K.config, {}), { notif: Object.assign({}, DEFAULT_CONFIG.notif, (load(K.config, {}) || {}).notif) }); },
    setConfig(patch) { save(K.config, Object.assign(this.config(), patch)); },
    exercises() { return load(K.exercises, DEFAULT_EXERCISES); },
    setExercises(list) { save(K.exercises, list); },
    days() { return load(K.days, {}); },
    day(date) { return this.days()[date] || null; },
    dirty() { return load(K.dirty, []); },
    rev() { return load(K.rev, 0); },
    lastSync() { return load(K.lastSync, null); },

    /** Empty record: no cells yet (the board shows one empty cell per rep exercise) and no distance. */
    blank(date) {
      const rec = { date, sets: {}, distance: {}, updated_at: 0 };
      for (const e of this.exercises()) {
        if (e.kind === 'sets') rec.sets[e.id] = { cells: [] };
        else rec.distance[e.id] = { done: false, km: 0 };
      }
      return rec;
    },
    /**
     * Record for a date in the v1.11 shape: sets[id] = { cells: [{reps, id?, src?}] } (filled cells only).
     * Records saved by older versions (done[] + planned reps, counted[]) are converted on read; the stored
     * history is not rewritten until that day is edited.
     */
    view(date) {
      const base = this.blank(date), cur = this.day(date);
      if (!cur) return base;
      const cfg = {}; for (const e of this.exercises()) cfg[e.id] = e;
      for (const id in (cur.sets || {})) base.sets[id] = { cells: cellsOf(cur.sets[id], cfg[id] ? cfg[id].reps : 0) };
      for (const id in (cur.distance || {})) base.distance[id] = Object.assign({}, cur.distance[id]);
      base.updated_at = cur.updated_at;
      return base;
    },
    /** Append a filled cell (manual or auto). Returns false when the day is full. */
    addCell(date, exId, reps, meta) {
      reps = Math.round(reps);
      if (!(reps >= 1)) return false;
      const r = this.view(date), s = r.sets[exId] || (r.sets[exId] = { cells: [] });
      if (s.cells.length >= 200) return false;
      s.cells.push(Object.assign({ reps }, meta || {}));
      this.put(r);
      return true;
    },
    /** Remove the cell that carries a phone-counted set id. */
    removeCellById(date, exId, setId) {
      const r = this.view(date), s = r.sets[exId];
      if (!s) return false;
      const i = s.cells.findIndex((c) => c.id === setId);
      if (i < 0) return false;
      s.cells.splice(i, 1); this.put(r); return true;
    },
    /** The day's result: plain sums, no norm. */
    summary(date) {
      const v = this.view(date), out = { sets: {}, km: {}, active: false };
      for (const id in v.sets) { const c = v.sets[id].cells; out.sets[id] = { n: c.length, reps: c.reduce((a, x) => a + x.reps, 0) }; if (c.length) out.active = true; }
      for (const id in v.distance) { const d = v.distance[id]; out.km[id] = d.km || 0; if (d.km > 0 || d.done) out.active = true; }
      return out;
    },
    put(rec) {
      const days = this.days();
      rec.updated_at = Math.max(Date.now(), (days[rec.date] && days[rec.date].updated_at + 1) || 0);
      days[rec.date] = rec;
      save(K.days, days);
      const d = new Set(this.dirty()); d.add(rec.date); save(K.dirty, [...d]);
      Sync.schedule();
    },
    // ---- recorded workouts (offline-first, LWW by updated_at) ----
    workouts() { return load(K.workouts, {}); },
    workoutList() { return Object.values(this.workouts()).filter((w) => !w.deleted).sort((a, b) => b.started_at - a.started_at); },
    putWorkout(w) {
      const all = this.workouts();
      w.updated_at = Math.max(Date.now(), (all[w.id] && all[w.id].updated_at + 1) || 0);
      all[w.id] = w;
      this._saveWorkouts(all);
      const d = new Set(load(K.wdirty, [])); d.add(w.id); save(K.wdirty, [...d]);
      Sync.schedule();
    },
    deleteWorkout(id) { const w = this.workouts()[id]; if (w) this.putWorkout(Object.assign({}, w, { deleted: true })); },
    wdirty() { return load(K.wdirty, []); },
    _saveWorkouts(all) {
      // keep HR samples locally only for the 30 newest workouts (localStorage is small); the server keeps all
      const keep = new Set(Object.values(all).sort((a, b) => b.started_at - a.started_at).slice(0, 30).map((w) => w.id));
      const dirty = new Set(load(K.wdirty, []));
      // GPS tracks / step series are bigger: only the 10 newest stay on the device
      const keepSeries = new Set(Object.values(all).sort((a, b) => b.started_at - a.started_at).slice(0, 10).map((w) => w.id));
      const trim = (w, series) => {
        if (w.samples && w.samples.length) { w.samples = []; w.samples_trimmed = true; }
        if (w.session_samples && w.session_samples.length) { w.session_samples = []; w.samples_trimmed = true; }
        if (series) for (const k of ['track', 'step_series', 'segments', 'session_rr', 'motion', 'tail']) if (w[k] && w[k].length) { w[k] = []; w.samples_trimmed = true; }
      };
      // RR intervals (HRV) are the heaviest per minute: only the 3 newest workouts keep them locally
      const keepRR = new Set(Object.values(all).sort((a, b) => b.started_at - a.started_at).slice(0, 3).map((w) => w.id));
      for (const id in all) {
        if (dirty.has(id)) continue;
        const w = all[id];
        if (!keepRR.has(id) && w.session_rr && w.session_rr.length) { w.session_rr = []; w.samples_trimmed = true; }
        if (!keep.has(id)) trim(w, true);
        else if (!keepSeries.has(id)) for (const k of ['track', 'step_series']) if (w[k] && w[k].length) { w[k] = []; w.samples_trimmed = true; }
      }
      try { save(K.workouts, all); }
      catch (e) { for (const id in all) if (!dirty.has(id)) trim(all[id], true); save(K.workouts, all); }
    },
    /** No daily norm any more: `done` = filled cells, `complete` = something was done today (stops the reminders). */
    progress(date) {
      const m = this.summary(date);
      let done = Object.values(m.sets).reduce((a, x) => a + x.n, 0);
      for (const id in m.km) if (m.km[id] > 0) done += 1;
      return { total: done, done, complete: m.active };
    },
  };

  function apiBase() {
    if (!isNative) return new URL('./', window.location.href).href;  // works under any subpath, e.g. /fitness/
    let u = (Store.config().serverUrl || '').trim();
    if (!u) return null;
    if (!/^https?:\/\//.test(u)) u = 'https://' + u;
    return u.endsWith('/') ? u : u + '/';
  }

  async function api(path, opts) {
    const base = apiBase();
    if (!base) throw Object.assign(new Error('Сервер не настроен'), { code: 'noserver' });
    const token = Store.config().token;
    if (!token) throw Object.assign(new Error('Нет токена'), { code: 'notoken' });
    opts = opts || {};
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(base + path, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'Authorization': 'Bearer ' + token }, opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (res.status === 401) throw Object.assign(new Error('Неверный токен'), { code: 'auth' });
      if (!res.ok) throw Object.assign(new Error('Ошибка сервера ' + res.status), { code: 'http', status: res.status });
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('Сервер не отвечает'), { code: 'net' });
      if (e instanceof TypeError) throw Object.assign(new Error('Нет связи с сервером'), { code: 'net' });
      throw e;
    } finally { clearTimeout(t); }
  }

  const listeners = [];
  const Sync = {
    state: 'idle', error: null, timer: null, running: null,
    pulled: false, _retries: 0,
    on(fn) { listeners.push(fn); },
    emit() { listeners.forEach((fn) => { try { fn(this); } catch (e) { console.error(e); } }); },
    // 800 ms debounce after a board/workout write; 0 = now (visibility, online, rev poll)
    schedule(delay) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), delay == null ? 800 : delay); },
    async run() {
      if (this.running) return this.running;
      this.running = this._run().finally(() => { this.running = null; });
      return this.running;
    },
    async _run() {
      const days = Store.days();
      const dirty = Store.dirty();
      const records = dirty.filter((d) => days[d]).map((d) => days[d]);
      const wall = Store.workouts();
      const wdirty = Store.wdirty();
      // nginx accepts ≤ 2 MB per request: send big workouts (tracks, RR) in several rounds
      const workouts = []; let bytes = 0, more = false;
      for (const id of wdirty) {
        if (!wall[id]) continue;
        const w = Object.assign({}, wall[id]); delete w.samples_trimmed; delete w.rev;
        const sz = JSON.stringify(w).length;
        if (workouts.length && bytes + sz > 1200000) { more = true; break; }
        workouts.push(w); bytes += sz;
      }
      this.state = 'syncing'; this.emit();
      try {
        const prevRev = Store.rev();
        const res = await api('api/sync', { method: 'POST', body: { since: prevRev, records, workouts } });
        const now = Store.days();
        const stillDirty = new Set(Store.dirty());
        const sent = new Map(records.map((r) => [r.date, r.updated_at]));
        for (const d of res.applied.concat(res.rejected)) {
          // only clear if not edited again while the request was in flight
          if (now[d] && now[d].updated_at === sent.get(d)) stillDirty.delete(d);
        }
        for (const r of res.records) {
          const local = now[r.date];
          if (!local || !stillDirty.has(r.date) || r.updated_at >= local.updated_at) {
            now[r.date] = { date: r.date, sets: r.sets, distance: r.distance, updated_at: r.updated_at };
            stillDirty.delete(r.date);
          }
        }
        // Rejected = the server holds a newer (or equal) version we might not have seen.
        for (const d of res.rejected) {
          if (!res.records.some((r) => r.date === d)) {
            try { const r = await api('api/days/' + d); now[d] = { date: d, sets: r.sets, distance: r.distance, updated_at: r.updated_at }; } catch (e) { /* ignore */ }
          }
        }
        // workouts
        if (Array.isArray(res.workouts)) {
          const wnow = Store.workouts();
          const wStill = new Set(Store.wdirty());
          const wsent = new Map(workouts.map((w) => [w.id, w.updated_at]));
          for (const id of (res.workouts_applied || []).concat(res.workouts_rejected || [])) {
            if (wnow[id] && wnow[id].updated_at === wsent.get(id)) wStill.delete(id);
          }
          for (const w of res.workouts) {
            const local = wnow[w.id];
            if (!local || !wStill.has(w.id) || w.updated_at >= local.updated_at) { wnow[w.id] = w; wStill.delete(w.id); }
          }
          Store._saveWorkouts(wnow); save(K.wdirty, [...wStill]);
        }
        save(K.days, now); save(K.dirty, [...stillDirty]); save(K.rev, res.rev);
        if (Array.isArray(res.exercises) && res.exercises.length) Store.setExercises(res.exercises);
        save(K.lastSync, Date.now());
        this.pulled = (res.rev !== prevRev)
          || (res.records && res.records.length > 0)
          || (res.workouts && res.workouts.length > 0);
        this.state = 'ok'; this.error = null; this._retries = 0;
        if (more) this.schedule(50);
      } catch (e) {
        this.pulled = false;
        this.state = 'error'; this.error = e;
        // retry network errors; auth / missing server URL need a user action
        const code = e && e.code;
        if (code !== 'auth' && code !== 'noserver' && code !== 'notoken') {
          this._retries = (this._retries || 0) + 1;
          this.schedule(Math.min(30000, 2000 * this._retries));
        }
      }
      this.emit();
      return this.state;
    },
  };

  window.FT = { cellsOf, Store, Sync, api, apiBase, localDate, isNative, DEFAULT_EXERCISES, DEFAULT_CONFIG };
})();
