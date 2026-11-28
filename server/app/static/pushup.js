/* v1.10: push-up counter. The phone lies screen-up under the chest; the proximity sensor (native side) counts reps and says every
   number aloud. v1.18.1: the native side also runs the same 8 s voice countdown and ready beep as pull-ups; reps before the ready
   signal are ignored. Here: the set screen (countdown → big counter → hold to finish), putting finished sets on the day board with
   their real reps, sending them to the server, and the site section (today, trend, delete). */
(function () {
  'use strict';
  const { api, Store, isNative, localDate } = window.FT;
  const $ = (id) => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const WR = isNative && P.WorkoutRecorder ? P.WorkoutRecorder : null;
  const K_PEND = 'ft.pushPending', K_APPLIED = 'ft.pushApplied', K_CACHE = 'ft.pushSets';
  const COUNTDOWN_S = 8;
  let state = 'idle', locked = false, nativeBound = false, finishing = false, syncing = false, sessionSets = [], data = null, chart = null;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const plural = (n, a, b, c) => { const x = Math.abs(n) % 100, y = x % 10; return x >= 11 && x <= 14 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };

  // ---------- the day board ----------
  function pushExercise() { return Store.exercises().find((e) => e.id === 'pushups'); }
  function applyToBoard(set) {
    if (!pushExercise()) return;
    const applied = load(K_APPLIED, []);
    if (applied.includes(set.id)) return;
    // v1.11: every counted set fills the next free cell; a new empty one appears below it
    if (!Store.addCell(localDate(new Date(set.t)), 'pushups', set.reps, { id: set.id, src: 'auto' })) return;
    applied.push(set.id); save(K_APPLIED, applied.slice(-500));
  }
  function removeFromBoard(id, date) {
    if (!pushExercise()) return;
    Store.removeCellById(date, 'pushups', id);
  }

  // ---------- phone → server ----------
  function queue(sets) {
    const pend = load(K_PEND, []);
    for (const w of sets || []) if (!pend.some((x) => x.id === w.id)) pend.push(w);
    save(K_PEND, pend.slice(-300));
    return pend.length;
  }
  async function collect() {
    if (!WR || !WR.takePushupSets) return 0;
    try {
      const r = await WR.takePushupSets();
      for (const w of r.sets || []) applyToBoard(w);
      return queue(r.sets || []);
    } catch (e) { return load(K_PEND, []).length; }
  }
  let sending = null;
  function flush() {
    if (sending) return sending;
    sending = (async () => {
      await collect();
      const pend = load(K_PEND, []);
      if (!pend.length) return;
      try {
        await api('api/pushups', { method: 'POST', body: { items: pend } });
        const left = load(K_PEND, []).filter((x) => !pend.some((p) => p.id === x.id));
        save(K_PEND, left);
      } catch (e) { /* offline: stays queued */ }
    })().finally(() => { sending = null; });
    return sending;
  }

  // ---------- the set screen (native only) ----------
  function overlay(show) { $('pushOverlay').classList.toggle('hidden', !show); }
  function setCount(n, wait) { const el = $('pushCount'); el.textContent = n; el.classList.toggle('wait', !!wait); }
  // v1.12: the native side swallows every touch until a volume key is pressed
  function setLocked(on) {
    locked = !!on;
    $('pushOverlay').classList.toggle('locked', locked);
    $('pushHint').classList.toggle('lock', locked);
    hint();
  }
  function hint() {
    if (state === 'countdown') $('pushHint').textContent = locked ? 'Экран заблокирован — нажми громкость' : 'Начну считать через…';
    else if (state === 'armed') $('pushHint').textContent = locked ? 'Экран заблокирован — нажми громкость' : 'Опускайся к телефону. Закончил — держи «Закончить».';
  }
  async function guard(on, lock) { if (WR && WR.setPushupGuard) { try { await WR.setPushupGuard({ on: !!on, locked: lock !== false }); } catch (e) { /* ignore */ } } }
  function renderSession() {
    const box = $('pushSession'); if (!box) return;
    if (!sessionSets.length) { box.innerHTML = ''; return; }
    const total = sessionSets.reduce((x, s) => x + s.reps, 0);
    box.innerHTML = `<h4 class="sub">Эта серия: ${total} ${plural(total, 'раз', 'раза', 'раз')}, ${sessionSets.length} ${plural(sessionSets.length, 'подход', 'подхода', 'подходов')}</h4>` +
      sessionSets.map((s, i) => `<div class="push-set"><span>${i + 1}. ${hm(s.t)}</span><b>${s.reps}</b><span class="muted">${dur(s.duration_s)}</span></div>`).join('');
  }
  /** Capacitor's native addListener returns a plain {remove} handle on this build (no .then/.catch), older ones a promise: accept both, never throw */
  function listen(name, cb) {
    try {
      const r = WR.addListener(name, cb);
      if (r && typeof r.then === 'function') r.then(null, () => {});
      return true;
    } catch (e) { return false; }
  }
  function bindNative() {
    if (nativeBound || !WR || !WR.addListener) return;
    const ok = [
      listen('pushup', (e) => applyNativeState(e)),
      listen('pushupFinished', (e) => finished(e.set, e.reason)),
      listen('pushupUnlocked', () => setLocked(false)),
      listen('pushupResumed', (e) => onResumed(e)),
    ].every(Boolean);
    nativeBound = ok;
  }
  /** the native side owns the lock: the screen shows whatever it says (`lock`), it never locks itself */
  function showCountdown(n) {
    state = 'countdown';
    overlay(true);
    $('pushPhase').textContent = 'Ложись, телефон экраном вверх под грудь';
    setCount(n == null ? COUNTDOWN_S : n, true);
    hint();
  }
  function showArmed(n, lock) {
    state = 'armed';
    overlay(true);
    $('pushPhase').textContent = 'Считаю';
    setCount(n || 0);
    if (lock !== undefined) setLocked(lock !== false);
    else hint();
  }
  /** native countdown ticks, the ready signal (counting=true), or a counted rep */
  function applyNativeState(e) {
    if (!e) return;
    if (e.counting || e.undo != null) {
      if (state === 'countdown' || state === 'idle') showArmed(e.reps || 0);
      else if (state === 'armed' && e.reps != null) setCount(e.reps);
    } else if (e.active !== false && (state === 'countdown' || state === 'idle' || e.countdown > 0)) {
      showCountdown(e.countdown || 0);
    }
  }
  function onResumed(e) {
    const lock = !(e && e.locked === false);
    if (e && e.counting === false) { showCountdown(e.countdown || 0); setLocked(lock); }
    else showArmed(e && e.reps ? e.reps : 0, lock);
  }
  /** v1.14.1: the native session is the truth. Called on every return to the app and every 2 s while the set screen is up. */
  async function sync() {
    if (!WR || syncing || finishing) return;
    syncing = true;
    try {
      const info = await WR.pushupInfo();
      if (!info) return;
      if (info.active && !info.recording) {
        if (info.counting) {
          if (state !== 'armed') showArmed(info.reps || 0, info.guard === 'locked');
          else { setCount(info.reps || 0); if (info.guard && info.guard !== 'off') setLocked(info.guard === 'locked'); else if (locked) setLocked(false); }
        } else {
          showCountdown(info.countdown || 0);
          if (info.guard && info.guard !== 'off') setLocked(info.guard === 'locked');
        }
      } else if (state === 'armed' || state === 'countdown') {
        cleanup(); flush().then(refresh);          // closed natively (power button, idle): nothing may stay locked
      } else if (state === 'idle' && !overlayHidden()) { cleanup(); }
    } catch (e) { /* ignore */ } finally { syncing = false; }
  }
  function overlayHidden() { return $('pushOverlay').classList.contains('hidden'); }
  /** after Recents / Home / a killed activity: pick the open set back up (no new countdown if already counting) */
  async function rejoin() { await sync(); return state === 'armed' || state === 'countdown'; }
  async function startSet() {
    if (!WR || state !== 'idle') return;
    $('pushMsg').textContent = '';
    bindNative();
    if (await rejoin()) return;
    let info = null;
    try { info = await WR.pushupInfo(); } catch (e) { /* ignore */ }
    if (info && info.recording) { $('pushMsg').textContent = 'Идёт запись тренировки: отжимания считать нельзя, пока она не закончится.'; return; }
    if (info && !info.present) { $('pushMsg').textContent = 'В телефоне нет датчика приближения.'; return; }
    showCountdown(COUNTDOWN_S);
    setLocked(true);
    await guard(true);
    try {
      await WR.pushupStart({ countdown: COUNTDOWN_S });
    } catch (e) {
      cleanup();
      $('pushMsg').textContent = e && e.code === 'recording' ? 'Идёт запись тренировки.' : e && e.code === 'no-sensor' ? 'В телефоне нет датчика приближения.' : 'Не удалось запустить счёт: ' + ((e && e.message) || e);
    }
  }
  function cleanup() {
    state = 'idle';
    setLocked(false);
    guard(false);
    overlay(false);
  }
  async function finishSet() {
    if (locked) return;
    if (state === 'countdown') {
      finishing = true;
      try { if (WR) await WR.pushupFinish(); } catch (e) { /* ignore */ }
      finishing = false;
      cleanup();
      return;
    }
    if (state !== 'armed') return;
    let set = null;
    finishing = true;
    try { set = (await WR.pushupFinish()).set || null; } catch (e) { /* ignore */ }
    finishing = false;
    finished(set, 'user');
  }
  function finished(set, reason) {
    const wasOpen = state !== 'idle';
    cleanup();
    if (set) {
      applyToBoard(set); queue([set]);
      if (!sessionSets.some((s) => s.id === set.id)) sessionSets.push(set);
      $('pushMsg').textContent = `Записан подход: ${set.reps} ${plural(set.reps, 'раз', 'раза', 'раз')}.` + (reason === 'idle' ? ' (закрыт сам: 2 минуты без отжиманий)' : '');
    } else if (wasOpen) $('pushMsg').textContent = reason === 'empty' ? 'Отжиманий не было, подход не записан.' : 'Отжиманий не насчитано, подход не записан.';
    renderSession();
    flush().then(refresh);
  }
  // a button that acts only after being held: a chest touching the screen must not end the set or drop a rep by accident
  function hold(btn, ms, fn) {
    const fill = btn.querySelector('.hold-fill');
    let t0 = 0, raf = 0;
    const stop = () => { t0 = 0; cancelAnimationFrame(raf); fill.style.width = '0'; };
    const step = () => {
      if (!t0) return;
      const p = Math.min(1, (performance.now() - t0) / ms);
      fill.style.width = (p * 100) + '%';
      if (p >= 1) { stop(); fn(); } else raf = requestAnimationFrame(step);
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); t0 = performance.now(); raf = requestAnimationFrame(step); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((n) => btn.addEventListener(n, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- site section ----------
  /** filled push-up cells of a day from the day board (the source of truth: manual, auto, corrected) */
  function boardCells(date) {
    try {
      const s = Store.view(date).sets.pushups;
      return (s && s.cells) ? s.cells.slice() : [];
    } catch (e) { return []; }
  }
  function groupByDate(items) {
    const m = new Map();
    for (const w of items) { const d = m.get(w.date) || { date: w.date, total: 0, best: 0, sets: 0 }; d.total += w.reps; d.best = Math.max(d.best, w.reps); d.sets += 1; m.set(w.date, d); }
    return m;
  }
  /** last `n` calendar dates, today first */
  function lastDates(n) {
    const out = [];
    for (let i = 0; i < n; i++) { const d = new Date(); d.setDate(d.getDate() - i); out.push(localDate(d)); }
    return out;
  }
  /**
   * per-day totals: the day board wins on any date that has push-up cells; dates that exist only
   * in the detector log (older records, or the board not yet loaded) fill the gaps
   */
  function mergedByDate(items) {
    const by = groupByDate(items);
    for (const date of Object.keys(Store.days())) {
      const cells = boardCells(date);
      if (!cells.length) continue;
      by.set(date, { date, total: cells.reduce((a, c) => a + c.reps, 0), best: Math.max(...cells.map((c) => c.reps)), sets: cells.length });
    }
    return by;
  }
  function render(r) {
    const items = (r && r.items) || [];
    const by = mergedByDate(items);
    const today = localDate();
    const todayCells = boardCells(today);
    const hasToday = todayCells.length > 0;
    const hasHist = by.size > 0;
    $('pushEmpty').classList.toggle('hidden', hasToday || hasHist);
    $('pushData').classList.toggle('hidden', !(hasToday || hasHist));
    if (!(hasToday || hasHist)) return;
    const td = by.get(today) || { total: 0, sets: 0, best: 0 };
    const week = lastDates(7).reduce((s, d) => s + ((by.get(d) || {}).total || 0), 0);
    const best = lastDates(60).reduce((s, d) => Math.max(s, (by.get(d) || {}).best || 0), 0);
    const card = (v, k) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`;
    $('pushCards').innerHTML = '<div class="cards">' + card(td.total, 'отжиманий сегодня') + card(td.sets, 'подходов сегодня') +
      card(td.best, 'лучший подход сегодня') + card(week, 'за 7 дней') + card(best, 'рекорд подхода (60 дней)') + '</div>';
    const autoById = new Map();
    for (const w of items) if (w.id) autoById.set(w.id, w);
    // today: the board, in order; auto rows can show the detector's time and pace, always with the board's reps
    $('pushToday').innerHTML = todayCells.length ? '<div class="table-wrap"><table class="calib-table"><tr><th></th><th>Раз</th><th>Время</th><th>Время подхода</th><th>Темп, раз/мин</th><th></th></tr>' +
      todayCells.map((c, i) => {
        const w = c.id ? autoById.get(c.id) : null;
        const mark = c.src === 'auto' ? ' 📲' : '';
        const when = w ? hm(w.t) : (c.src === 'auto' ? '📲' : 'вручную');
        const d = w ? dur(w.duration_s) : '—';
        const pace = w && w.duration_s >= 5 ? Math.round((c.reps - 1) * 60 / w.duration_s) : '—';
        return `<tr><td class="muted">${i + 1}${mark}</td><td><b>${c.reps}</b></td><td>${when}</td><td>${d}</td><td>${pace}</td><td><button class="btn small-btn push-del" data-i="${i}" data-id="${esc(c.id || '')}" data-date="${esc(today)}" title="Удалить подход">✕</button></td></tr>`;
      }).join('') + '</table></div>' : '';
    document.querySelectorAll('.push-del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Удалить этот подход?')) return;
      const date = b.dataset.date, id = b.dataset.id, i = Number(b.dataset.i);
      if (id) {
        try { await api('api/pushups/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) { /* offline: the board is enough */ }
        if (!Store.removeCellById(date, 'pushups', id)) {
          const x = Store.view(date); if (x.sets.pushups) { x.sets.pushups.cells.splice(i, 1); Store.put(x); }
        }
      } else {
        const x = Store.view(date); if (x.sets.pushups) { x.sets.pushups.cells.splice(i, 1); Store.put(x); }
      }
      if (window.FT && typeof window.FT.refreshToday === 'function') window.FT.refreshToday();
      refresh();
    }));
    drawChart(by);
  }
  function drawChart(by) {
    if (!window.Chart) return;
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localDate(d)); }
    const labels = days.map((d) => d.slice(8) + '.' + d.slice(5, 7));
    if (chart) chart.destroy();
    chart = new Chart($('pushChart'), { type: 'bar',
      data: { labels, datasets: [
        { type: 'bar', label: 'всего за день', data: days.map((d) => (by.get(d) ? by.get(d).total : 0)), backgroundColor: 'rgba(57,211,83,.6)', yAxisID: 'y', order: 2 },
        { type: 'line', label: 'лучший подход', data: days.map((d) => (by.get(d) ? by.get(d).best : null)), borderColor: '#ffb020', backgroundColor: '#ffb020', yAxisID: 'y', spanGaps: true, tension: 0.2, order: 1 },
      ] },
      options: { maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'раз' }, ticks: { precision: 0 } } } } });
  }
  async function refresh() {
    await flush();
    try { data = await api('api/pushups?days=60'); save(K_CACHE, data); $('pushOffline').classList.add('hidden'); }
    catch (e) { data = load(K_CACHE, null); $('pushOffline').classList.remove('hidden'); }
    render(data);
    const pend = load(K_PEND, []).length;
    if ($('pushPending')) $('pushPending').textContent = pend ? `Не отправлено на сервер: ${pend}` : '';
  }

  function init() {
    if ($('pushStart')) $('pushStart').addEventListener('click', startSet);
    if ($('pushFinish')) hold($('pushFinish'), 1200, finishSet);
    if ($('pushUndo')) hold($('pushUndo'), 600, () => { if (!locked && state === 'armed' && WR) WR.pushupUndo().catch(() => {}); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) return; flush(); sync(); });
    try { bindNative(); } catch (e) { /* listeners retried on the next set */ }
    setInterval(() => { if (state === 'armed' || !overlayHidden()) sync(); }, 2000);
    setTimeout(flush, 5000);
    setTimeout(sync, 400);
  }
  init();
  window.FTPush = { refresh, onShow: () => { refresh(); rejoin(); }, flush, _applyToBoard: applyToBoard, _removeFromBoard: removeFromBoard, _rejoin: rejoin };
})();
