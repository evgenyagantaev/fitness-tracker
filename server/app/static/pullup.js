/* v1.17: pull-up counter on the phone accelerometer. The phone is in a pocket or on the neck; the native side does the countdown
   (voice 5…1, beep), counts every rep aloud with the screen off and closes the set by itself after 8 s without a new rep.
   Here: the set screen (shows the native state), finished sets → day board (📲 cell) and server (with the raw accelerometer, for
   tuning), and the section (today from the board, trend). */
(function () {
  'use strict';
  const { api, Store, isNative, localDate } = window.FT;
  const $ = (id) => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const WR = isNative && P.WorkoutRecorder ? P.WorkoutRecorder : null;
  const K_PEND = 'ft.pullPending', K_APPLIED = 'ft.pullApplied', K_CACHE = 'ft.pullSets';
  const COUNTDOWN_S = 8;
  let open = false, nativeBound = false, syncing = false, sending = null, sessionSets = [], data = null, chart = null, poll = null;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const plural = (n, a, b, c) => { const x = Math.abs(n) % 100, y = x % 10; return x >= 11 && x <= 14 ? c : y === 1 ? a : y >= 2 && y <= 4 ? b : c; };
  const REASON = { landed: 'закрыт сам: спрыгнул', idle: 'закрыт сам: 8 с без повторов', empty: 'закрыт сам: повторов не было', limit: 'закрыт сам: 10 минут', button: 'закрыт кнопкой в уведомлении', recovered: 'восстановлен после закрытия приложения' };

  // ---------- the day board ----------
  function pullExercise() { return Store.exercises().find((e) => e.id === 'pullups'); }
  function applyToBoard(set) {
    if (!pullExercise()) return;
    const applied = load(K_APPLIED, []);
    if (applied.includes(set.id)) return;
    if (!Store.addCell(localDate(new Date(set.t)), 'pullups', set.reps, { id: set.id, src: 'auto' })) return;
    applied.push(set.id); save(K_APPLIED, applied.slice(-500));
  }

  // ---------- phone → server (one set per request: a set carries ~50–300 KB of raw accelerometer) ----------
  function queue(sets) {
    const pend = load(K_PEND, []);
    for (const w of sets || []) {
      const i = pend.findIndex((x) => x.id === w.id);
      if (i < 0) pend.push(w); else if (w.raw && !pend[i].raw) pend[i] = w;
    }
    let keep = pend.slice(-60);
    // localStorage is small: if it does not fit, the oldest sets go without their raw block (the count is what matters)
    for (let i = 0; !save(K_PEND, keep) && i < keep.length; i++) { const c = Object.assign({}, keep[i]); delete c.raw; keep[i] = c; }
    return keep.length;
  }
  async function collect() {
    if (!WR || !WR.takePullupSets) return 0;
    try {
      const r = await WR.takePullupSets();
      for (const w of r.sets || []) applyToBoard(w);
      return queue(r.sets || []);
    } catch (e) { return load(K_PEND, []).length; }
  }
  function flush() {
    if (sending) return sending;
    sending = (async () => {
      await collect();
      for (const w of load(K_PEND, [])) {
        try { await api('api/pullups', { method: 'POST', body: { items: [w] } }); }
        catch (e) { if (e && e.status === 422 && w.raw) { try { const c = Object.assign({}, w); delete c.raw; await api('api/pullups', { method: 'POST', body: { items: [c] } }); } catch (e2) { break; } } else break; }
        save(K_PEND, load(K_PEND, []).filter((x) => x.id !== w.id));
      }
    })().finally(() => { sending = null; });
    return sending;
  }

  // ---------- the set screen ----------
  function overlay(show) { open = !!show; $('pullOverlay').classList.toggle('hidden', !show); }
  function show(st) {
    if (!st || !st.active) return;
    if (!open) overlay(true);
    const cd = st.countdown || 0;
    $('pullPhase').textContent = cd > 0 ? 'Убери телефон в карман или повесь на шею и повисни на перекладине' : 'Считаю';
    const el = $('pullCount'); el.textContent = cd > 0 ? cd : (st.reps || 0); el.classList.toggle('wait', cd > 0);
    $('pullHint').textContent = cd > 0 ? 'Старт после сигнала. Экран можно выключить кнопкой питания.'
      : (st.sensorOk === false ? 'Нет данных акселерометра…' : 'Повисишь 8 секунд без повторов — подход закроется сам. Можно и кнопкой.');
  }
  function listen(name, cb) {
    try { const r = WR.addListener(name, cb); if (r && typeof r.then === 'function') r.then(null, () => {}); return true; } catch (e) { return false; }
  }
  function bindNative() {
    if (nativeBound || !WR || !WR.addListener) return;
    nativeBound = [listen('pullup', (e) => show(e)), listen('pullupFinished', (e) => finished(e.set, e.reason))].every(Boolean);
  }
  async function sync() {
    if (!WR || syncing) return;
    syncing = true;
    try {
      const info = await WR.pullupInfo();
      if (info && info.active) { show(info); startPoll(); }
      else if (open) { overlay(false); stopPoll(); flush().then(refresh); }
    } catch (e) { /* ignore */ } finally { syncing = false; }
  }
  function startPoll() { if (!poll) poll = setInterval(sync, 1000); }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
  async function startSet() {
    if (!WR) return;
    $('pullMsg').textContent = '';
    bindNative();
    let info = null;
    try { info = await WR.pullupInfo(); } catch (e) { /* ignore */ }
    if (info && info.active) { show(info); startPoll(); return; }
    if (info && info.recording) { $('pullMsg').textContent = 'Идёт запись тренировки: подтягивания считать нельзя, пока она не закончится.'; return; }
    if (info && info.pushups) { $('pullMsg').textContent = 'Сейчас открыт подход отжиманий.'; return; }
    if (info && info.present === false) { $('pullMsg').textContent = 'В телефоне нет акселерометра.'; return; }
    try { await WR.pullupStart({ countdown: COUNTDOWN_S }); }
    catch (e) {
      $('pullMsg').textContent = e && e.code === 'recording' ? 'Идёт запись тренировки.' : e && e.code === 'pushups' ? 'Сейчас открыт подход отжиманий.' : 'Не удалось запустить счёт: ' + ((e && e.message) || e);
      return;
    }
    show({ active: true, countdown: COUNTDOWN_S, reps: 0 });
    startPoll();
  }
  async function finishSet() {
    if (!WR || !open) return;
    let set = null;
    try { set = (await WR.pullupFinish({ reason: 'app' })).set || null; } catch (e) { /* ignore */ }
    finished(set, 'app');
  }
  function finished(set, reason) {
    const wasOpen = open;
    overlay(false); stopPoll();
    if (set) {
      applyToBoard(set);
      if (!sessionSets.some((s) => s.id === set.id)) sessionSets.push(set);
      $('pullMsg').textContent = `Записан подход: ${set.reps} ${plural(set.reps, 'раз', 'раза', 'раз')}.` + (REASON[reason] ? ` (${REASON[reason]})` : '');
    } else if (wasOpen || reason) $('pullMsg').textContent = 'Подтягиваний не насчитано, подход не записан.';
    renderSession();
    flush().then(refresh);
  }
  function renderSession() {
    const box = $('pullSession'); if (!box) return;
    if (!sessionSets.length) { box.innerHTML = ''; return; }
    const total = sessionSets.reduce((x, s) => x + s.reps, 0);
    box.innerHTML = `<h4 class="sub">Эта серия: ${total} ${plural(total, 'раз', 'раза', 'раз')}, ${sessionSets.length} ${plural(sessionSets.length, 'подход', 'подхода', 'подходов')}</h4>` +
      sessionSets.map((s, i) => `<div class="push-set"><span>${i + 1}. ${hm(s.t)}</span><b>${s.reps}</b><span class="muted">${dur(s.duration_s)}</span></div>`).join('');
  }
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

  // ---------- section ----------
  function boardCells(date) {
    try { const s = Store.view(date).sets.pullups; return (s && s.cells) ? s.cells.slice() : []; } catch (e) { return []; }
  }
  function lastDates(n) { const out = []; for (let i = 0; i < n; i++) { const d = new Date(); d.setDate(d.getDate() - i); out.push(localDate(d)); } return out; }
  /** per-day totals from the day board (manual, auto, corrected); detector-only dates fill the gaps */
  function mergedByDate(items) {
    const by = new Map();
    for (const w of items) { const d = by.get(w.date) || { date: w.date, total: 0, best: 0, sets: 0 }; d.total += w.reps; d.best = Math.max(d.best, w.reps); d.sets += 1; by.set(w.date, d); }
    for (const date of Object.keys(Store.days())) {
      const cells = boardCells(date);
      if (cells.length) by.set(date, { date, total: cells.reduce((a, c) => a + c.reps, 0), best: Math.max(...cells.map((c) => c.reps)), sets: cells.length });
    }
    return by;
  }
  function render(r) {
    const items = (r && r.items) || [];
    const by = mergedByDate(items);
    const today = localDate();
    const todayCells = boardCells(today);
    const any = todayCells.length > 0 || by.size > 0;
    $('pullEmpty').classList.toggle('hidden', any);
    $('pullData').classList.toggle('hidden', !any);
    if (!any) return;
    const td = by.get(today) || { total: 0, sets: 0, best: 0 };
    const week = lastDates(7).reduce((s, d) => s + ((by.get(d) || {}).total || 0), 0);
    const best = lastDates(60).reduce((s, d) => Math.max(s, (by.get(d) || {}).best || 0), 0);
    const card = (v, k) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`;
    $('pullCards').innerHTML = '<div class="cards">' + card(td.total, 'подтягиваний сегодня') + card(td.sets, 'подходов сегодня') +
      card(td.best, 'лучший подход сегодня') + card(week, 'за 7 дней') + card(best, 'рекорд подхода (60 дней)') + '</div>';
    const autoById = new Map();
    for (const w of items) if (w.id) autoById.set(w.id, w);
    $('pullToday').innerHTML = todayCells.length ? '<div class="table-wrap"><table class="calib-table"><tr><th></th><th>Раз</th><th>Время</th><th>Время подхода</th><th>Насчитал датчик</th></tr>' +
      todayCells.map((c, i) => {
        const w = c.id ? autoById.get(c.id) : null;
        const mark = c.src === 'auto' ? ' 📲' : '';
        const when = w ? hm(w.t) : (c.src === 'auto' ? '📲' : 'вручную');
        const det = w ? (w.reps === c.reps ? w.reps : `${w.reps} (исправлено)`) : '—';
        return `<tr><td class="muted">${i + 1}${mark}</td><td><b>${c.reps}</b></td><td>${when}</td><td>${w ? dur(w.duration_s) : '—'}</td><td>${esc(det)}</td></tr>`;
      }).join('') + '</table></div><p class="small muted">Исправить число — в ячейке на доске дня (вкладка «Сегодня»).</p>' : '';
    drawChart(by);
  }
  function drawChart(by) {
    if (!window.Chart) return;
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(localDate(d)); }
    if (chart) chart.destroy();
    chart = new Chart($('pullChart'), { type: 'bar',
      data: { labels: days.map((d) => d.slice(8) + '.' + d.slice(5, 7)), datasets: [
        { type: 'bar', label: 'всего за день', data: days.map((d) => (by.get(d) ? by.get(d).total : 0)), backgroundColor: 'rgba(57,211,83,.6)', yAxisID: 'y', order: 2 },
        { type: 'line', label: 'лучший подход', data: days.map((d) => (by.get(d) ? by.get(d).best : null)), borderColor: '#ffb020', backgroundColor: '#ffb020', yAxisID: 'y', spanGaps: true, tension: 0.2, order: 1 },
      ] },
      options: { maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'раз' }, ticks: { precision: 0 } } } } });
  }
  async function refresh() {
    await flush();
    try { data = await api('api/pullups?days=60'); save(K_CACHE, data); $('pullOffline').classList.add('hidden'); }
    catch (e) { data = load(K_CACHE, null); $('pullOffline').classList.remove('hidden'); }
    render(data);
    const pend = load(K_PEND, []).length;
    if ($('pullPending')) $('pullPending').textContent = pend ? `Не отправлено на сервер: ${pend}` : '';
  }

  function init() {
    if (!$('pullOverlay')) return;
    if ($('pullStart')) $('pullStart').addEventListener('click', startSet);
    if ($('pullFinish')) hold($('pullFinish'), 1000, finishSet);
    if ($('pullUndo')) hold($('pullUndo'), 600, () => { if (open && WR) WR.pullupUndo().catch(() => {}); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) return; flush(); sync(); });
    try { bindNative(); } catch (e) { /* retried on start */ }
    setTimeout(flush, 6000);
    setTimeout(sync, 500);
  }
  init();
  window.FTPull = { refresh, onShow: () => { refresh(); sync(); }, flush, _applyToBoard: applyToBoard };
})();
