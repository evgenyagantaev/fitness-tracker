/* Workout recording: BLE heart-rate monitor (0x180D/0x2A37) + phone step counter. List + HR chart (web & app). */
(function () {
  'use strict';
  const { Store, Sync, api, localDate, isNative } = window.FT;
  const $ = (id) => document.getElementById(id);
  const HRS = '0000180d-0000-1000-8000-00805f9b34fb';
  const HRM = '00002a37-0000-1000-8000-00805f9b34fb';
  const K_ACTIVE = 'ft.activeWorkout';
  const TYPES = { run: 'Бег', walk: 'Ходьба', workout: 'Тренировка' };
  const P = (isNative && window.Capacitor && window.Capacitor.Plugins) || {};
  const BLE = isNative && window.capacitorCommunityBluetoothLe ? window.capacitorCommunityBluetoothLe.BleClient : null;
  const WR = P.WorkoutRecorder || null;   // native foreground service (background recording)
  let pollTimer = null;
  // HR session in the service (pre-run monitoring → workout → post-run recovery)
  let svc = null, sess = { start: 0, buf: [], rr: [] }, lastPostSave = 0, monStarting = false, recovLiveChart = null;
  const K_PEND = 'ft.pendingSessions';

  const hr = { id: null, name: '', connected: false, connecting: false, bpm: null, at: 0, want: false, retry: null, inited: false };
  let active = load(K_ACTIVE);
  let wkType = 'run';
  let liveChart = null, detailChart = null, detailId = null, tickTimer = null, stepsListener = null;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function cfg() { return Store.config(); }
  function manualStride() { const s = parseFloat(cfg().stride); return s > 0 ? s : 0.75; }
  function strideFor(type) {
    const c = cfg(), cal = c.calib && c.calib[type === 'walk' ? 'walk' : 'run'];
    if ((c.strideMode || 'auto') === 'auto' && cal && cal.stride_m) return { v: cal.stride_m, src: 'auto' };
    return { v: manualStride(), src: 'manual' };
  }
  function stride() { return strideFor(active ? active.type : wkType).v; }
  const A = window.FTAnalysis;
  function fmtPace(sKm) { return sKm ? fmtDur(sKm) : '—'; }
  function msg(id, t) { const el = $(id); if (el) el.textContent = t || ''; }
  function fmtDur(s) { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
  function newId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------------- heart-rate monitor ----------------
  function parseHr(dv) {
    const flags = dv.getUint8(0);
    return (flags & 1) ? dv.getUint16(1, true) : dv.getUint8(1);
  }

  async function bleInit() {
    if (!BLE) throw new Error('Bluetooth недоступен');
    if (!hr.inited) { await BLE.initialize({ androidNeverForLocation: false }); hr.inited = true; }
    if (!(await BLE.isEnabled())) { try { await BLE.requestEnable(); } catch (e) { /* ignore */ } if (!(await BLE.isEnabled())) throw new Error('Включи Bluetooth'); }
    try { if (!(await BLE.isLocationEnabled())) { msg('hrMsg', 'Для поиска устройств Android 11 нужна включённая геолокация'); await BLE.openLocationSettings(); throw new Error('Включи геолокацию и попробуй снова'); } } catch (e) { if (e.message && e.message.startsWith('Включи')) throw e; }
  }

  async function pick(all) {
    try {
      await bleInit();
      msg('hrMsg', all ? 'Выбери устройство в списке…' : 'Ищу пульсометры… (Mi Band: включи «Трансляцию пульса» в Mi Fitness)');
      const dev = await BLE.requestDevice(all ? {} : { services: [HRS] });
      await connect(dev.deviceId, dev.name || dev.deviceId);
    } catch (e) { msg('hrMsg', 'Не получилось: ' + (e.message || e)); renderHr(); }
  }

  async function connect(id, name) {
    if (WR && ((active && active.native) || (svc && svc.running))) {   // the background service owns the BLE link
      hr.id = id; hr.name = name || hr.name;
      Store.setConfig({ hrDevice: { id, name: hr.name } });
      if (active) { active.device = hr.name; persistActive(); }
      await WR.setDevice({ deviceId: id, deviceName: hr.name }).catch(() => {});
      msg('hrMsg', 'Пульсометр передан фоновой записи');
      return;
    }
    if (!BLE || hr.connecting) return;
    hr.connecting = true; hr.id = id; hr.name = name || hr.name; hr.want = true; renderHr();
    try {
      await bleInit();
      try { await BLE.disconnect(id); } catch (e) { /* not connected */ }
      await BLE.connect(id, onDisconnect, { timeout: 15000 });
      try {
        await BLE.startNotifications(id, HRS, HRM, (dv) => onHr(parseHr(dv)));
      } catch (e) {
        await BLE.disconnect(id).catch(() => {});
        throw new Error('у устройства нет пульса по Bluetooth (сервис 0x180D). Для Mi Band включи «Трансляцию пульса»');
      }
      hr.connected = true;
      Store.setConfig({ hrDevice: { id, name: hr.name } });
      msg('hrMsg', 'Подключено, жду данные пульса…');
    } catch (e) {
      hr.connected = false;
      msg('hrMsg', 'Ошибка подключения: ' + (e.message || e));
      if (active) scheduleReconnect();
    } finally { hr.connecting = false; renderHr(); }
  }

  function onDisconnect() {
    hr.connected = false; hr.bpm = null; renderHr();
    if (hr.want) { msg('hrMsg', 'Связь потеряна, переподключаюсь…'); scheduleReconnect(); }
  }
  function scheduleReconnect() {
    clearTimeout(hr.retry);
    hr.retry = setTimeout(() => { if (hr.want && !hr.connected && hr.id) connect(hr.id, hr.name); }, 4000);
  }
  async function disconnect() {
    if (WR && svc && svc.running) {
      if (active) { await WR.setDevice({ deviceId: null, deviceName: null }).catch(() => {}); msg('hrMsg', 'Пульсометр отключён от записи'); return; }
      return endMonitor();
    }
    hr.want = false; clearTimeout(hr.retry);
    if (hr.id && BLE) await BLE.disconnect(hr.id).catch(() => {});
    hr.connected = false; hr.bpm = null; msg('hrMsg', ''); renderHr();
  }

  function onHr(bpm) {
    if (!bpm || bpm < 25 || bpm > 250) return;
    hr.bpm = bpm; hr.at = Date.now();
    if (active) {
      const sec = Math.round((Date.now() - active.started_at) / 1000);
      const s = active.samples, last = s[s.length - 1];
      if (last && last[0] === sec) last[1] = bpm; else s.push([sec, bpm]);
    }
    if (!active) { msg('hrMsg', 'Пульс идёт ✔'); }
    if (!active && WR && !svc && !monStarting && hr.id && cfg().autoMonitor !== false) startMonitor();
    renderLive();
  }

  // "LED" next to every live HR value: green while beats arrive (last sample < 3.5 s), grey otherwise
  function hrFresh() { return !!(hr.bpm && Date.now() - (hr.at || 0) < 3500); }
  function renderLeds() {
    const on = hrFresh();
    document.querySelectorAll('.led').forEach((el) => {
      if (el.classList.contains('on') !== on) { el.classList.toggle('on', on); el.title = on ? 'пульс идёт' : 'нет связи с пульсометром'; }
    });
    const b = $('hrNowBpm'); if (b) b.textContent = on ? hr.bpm : '—';
  }
  setInterval(renderLeds, 500);
  function syncAddLabel() {
    const l = $('wkAddRun') && $('wkAddRun').closest('label'); if (!l) return;
    l.classList.toggle('hidden', wkType === 'workout');
    l.querySelector('span').textContent = `Добавить дистанцию в «${wkType === 'walk' ? 'Ходьба' : 'Бег'}» за сегодня`;
  }
  function renderHr() {
    renderLeds();
    if (!$('hrDevStatus')) return;
    const st = (hr.connecting ? 'подключаюсь…' : hr.connected ? 'подключён ✔' : 'не подключён') +
      (hr.connected && hr.batt != null ? ` · батарея ${hr.batt}%` : '') + (hr.connected && hr.acc ? ` · акселерометр пишется (${hr.acc.steps} шаг.)` : '');
    $('hrDevStatus').textContent = st;
    const saved = cfg().hrDevice;
    $('hrDevName').textContent = (hr.name || (saved && saved.name)) ? 'Устройство: ' + (hr.name || saved.name) : '';
    $('hrDisconnect').classList.toggle('hidden', !hr.connected && !hr.connecting);
  }

  // ---------------- recording ----------------
  function persistActive() { if (active) localStorage.setItem(K_ACTIVE, JSON.stringify(active)); else localStorage.removeItem(K_ACTIVE); }

  async function startSteps() {
    const SC = P.StepCounter; if (!SC) { msg('wkMsg', 'Датчик шагов недоступен'); return; }
    try {
      if (stepsListener) { await stepsListener.remove(); stepsListener = null; }
      stepsListener = await SC.addListener('steps', onSteps);
      const r = await SC.start({ reset: true });
      onSteps(r);
    } catch (e) { msg('wkMsg', 'Шаги не считаются: ' + (e.message || e)); }
  }
  function onSteps(r) {
    if (!active || !r || r.total == null || r.total < 0) return;
    if (active.step0 == null) active.step0 = r.total - (active.steps || 0);   // resume-safe baseline
    if (r.total < active.step0) active.step0 = r.total - (active.steps || 0); // phone rebooted mid-workout
    active.steps = Math.max(active.steps || 0, Math.round(r.total - active.step0));
    active.step_series = active.step_series || [];
    const sec = Math.round((Date.now() - active.started_at) / 1000), ss = active.step_series, lst = ss[ss.length - 1];
    if (lst && lst[0] === sec) lst[1] = active.steps; else ss.push([sec, active.steps]);
    renderLive();
  }

  async function start() {
    if (active) return;
    if (WR) return startNative();
    const sf = strideFor(wkType);
    active = { id: newId(), type: wkType, date: localDate(), started_at: Date.now(), samples: [], steps: 0, step0: null, step_series: [], track: [],
      stride_m: sf.v, stride_source: sf.src, device: hr.name || null, add_run: $('wkAddRun').checked };
    persistActive();
    await afterStart();
    msg('wkMsg', hr.connected ? '' : 'Запись идёт без пульса — подключи пульсометр, данные начнут писаться сразу.');
  }
  async function afterStart() {
    hr.want = true;
    if (!hr.connected && cfg().hrDevice) connect(cfg().hrDevice.id, cfg().hrDevice.name);
    if (P.KeepAwake) P.KeepAwake.keepAwake().catch(() => {});
    await startSteps();
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { renderLive(); persistActive(); }, 1000);
    renderRec();
  }

  // ---------- HR session: monitoring before the run, recovery after it ----------
  function postMin() { const v = parseInt(cfg().postMin, 10); return v >= 10 && v <= 180 ? v : 90; }
  async function startMonitor() {
    if (!WR || svc || monStarting || !hr.id) return;
    monStarting = true;
    try {
      hr.want = false; clearTimeout(hr.retry);
      if (BLE) await BLE.disconnect(hr.id).catch(() => {});
      await WR.monitor({ deviceId: hr.id, deviceName: hr.name, postMin: postMin() });
      svc = { running: true, phase: 'pre', sessionStart: Date.now() };
      sess = { start: 0, buf: [], rr: [] };
      msg('hrMsg', 'Мониторинг пульса начат — пульс до старта тоже сохранится.');
      startPolling();
    } catch (e) { msg('hrMsg', 'Не удалось начать мониторинг: ' + (e.message || e)); }
    finally { monStarting = false; renderSession(); }
  }
  async function endMonitor() {
    if (!WR) return;
    await WR.endSession().catch(() => {});
    svc = null; hr.connected = false; hr.bpm = null;
    await collectFinished();
    renderSession(); renderHr();
  }

  // session samples [sec since session start, bpm] → [sec relative to workout start, bpm] inside [lo, hi] (ms)
  function sessionFor(w, sessStart, samples, lo, hi) {
    const rel = (sessStart - w.started_at) / 1000, out = [];
    for (const p of samples || []) { const abs = sessStart + p[0] * 1000; if (abs >= lo && abs <= hi) out.push([Math.round((p[0] + rel) * 10) / 10, p[1]]); }
    return out;
  }
  // RR [ms since session start (beat time), rr ms] → [sec relative to workout start, rr ms]
  function rrFor(w, sessStart, rr, lo, hi) {
    const out = [];
    for (const p of rr || []) { const abs = sessStart + p[0]; if (abs >= lo && abs <= hi) out.push([Math.round((abs - w.started_at)) / 1000, p[1]]); }
    return out;
  }
  // derived analytics (signal quality, masked HR, cadence, calibration figures, back-to-back baseline, tail cut, recovery + HRV)
  function derived(w) { return A.derive(w, Store.workoutList().filter((x) => x.id !== w.id)); }
  function applySession(id, sessStart, samples, sessEnd, lo, hi, final, rr) {
    const all = Store.workouts(), w = all[id];
    if (!w) { if (final) { const pend = load(K_PEND) || []; pend.push({ id, sessStart, samples, sessEnd, lo, hi, rr }); localStorage.setItem(K_PEND, JSON.stringify(pend.slice(-5))); } return null; }
    const ss = sessionFor(w, sessStart, samples, lo, hi);
    if (!ss.length || (!final && ss.length <= (w.session_samples || []).length)) return null;
    const srr = rr && rr.length ? rrFor(w, sessStart, rr, lo, hi) : (w.session_rr || []);
    const nw = Object.assign({}, w, { session_samples: ss, session_rr: srr, session_start: Math.max(sessStart, lo), session_end: Math.min(sessEnd, hi) });
    Object.assign(nw, derived(nw));
    Store.putWorkout(nw);
    return A.recovery(nw);
  }
  function sessionBounds(list, i, sessStart, sessEnd) {
    return [i > 0 ? list[i - 1].endedAt : sessStart, i + 1 < list.length ? list[i + 1].startedAt : sessEnd];
  }
  // v1.7: the service closed a run by itself (forgotten «Стоп»): build the record from its snapshot, cut at the detected end.
  // Everything recorded after the cut is kept in w.tail (raw data is never thrown away).
  let collectingAuto = false;
  async function collectAutoEnded() {
    if (!WR || !WR.takeAutoEnded || collectingAuto) return false;
    collectingAuto = true;
    try {
      let got = [];
      try { got = (await WR.takeAutoEnded()).workouts || []; } catch (e) { return false; }
      let any = false;
      for (const o of got) {
        if (!o || !o.workoutId || !o.autoEnd) continue;
        if (Store.workouts()[o.workoutId]) continue;
        const a = active && active.id === o.workoutId ? active : null;
        const endedAt = o.autoEnd.endedAt, dur = Math.max(1, Math.round((endedAt - o.startedAt) / 1000));
        const samples = o.samples || [], ss = o.stepSeries || [], tr = o.track || [];
        const stride = (a && a.stride_m) || o.stride || 0.8;
        const pp = Array.isArray(o.phonePauses) ? o.phonePauses.map((x) => [x[0], x[1]]) : undefined;
        const an = A.analyze({ type: o.type, duration_s: dur, steps: o.steps || 0, stride_m: stride, step_series: ss, track: tr, phone_pauses: pp });
        const hrs = samples.map((x) => x[1]).filter((b) => b >= 30);
        const w = { id: o.workoutId, type: o.type || 'run', date: (a && a.date) || localDate(new Date(o.startedAt)), started_at: o.startedAt, ended_at: endedAt, duration_s: dur,
          steps: an.steps, stride_m: stride, stride_source: (a && a.stride_source) || 'auto', distance_m: an.distance_m,
          hr: { avg: hrs.length ? hrs.reduce((p, q) => p + q, 0) / hrs.length : 0, max: hrs.length ? Math.max(...hrs) : 0, min: hrs.length ? Math.min(...hrs) : 0 },
          samples, device: o.deviceName || (a && a.device) || null, deleted: false,
          step_distance_m: an.step_distance_m, moving_s: an.moving_s, stop_s: an.stop_s, stops: an.stops, cadence_avg: an.cadence_avg,
          gps_distance_m: an.gps_distance_m, gps_ok: an.gps_ok, gps_acc: an.gps_acc, gps_coverage: an.gps_coverage, gps_stride_m: an.gps_stride_m,
          step_series: ss, track: tr, segments: an.segments,
          auto_end: { reason: o.autoEnd.reason, detected_at: o.autoEnd.detectedAt, last_run_s: o.autoEnd.lastRunSec } };
        if (o.tail && ((o.tail.step_series || []).length || (o.tail.track || []).length)) w.tail = o.tail;
        if (pp) w.phone_pauses = pp;
        if (Array.isArray(o.liveLog) && o.liveLog.length) w.live_log = o.liveLog.slice(-400);
        Object.assign(w, derived(w));
        if (a) { active = null; persistActive(); if (!(svc && svc.running)) { clearInterval(tickTimer); } }
        Store.putWorkout(w);
        const dayId = w.type === 'walk' ? 'walk' : w.type === 'run' ? 'run' : null;
        if ((a ? a.add_run : true) && dayId && w.distance_m > 0) {
          const today = localDate(), rec = Store.view(today), km = Math.round(w.distance_m / 10) / 100;
          const d = rec.distance[dayId] || (rec.distance[dayId] = { km: 0, done: false });
          d.km = Math.round(((d.km || 0) + km) * 100) / 100; d.done = true; Store.put(rec);
        }
        msg('wkMsg', `Тренировка закрыта автоматически (ты забыл «Стоп»): ${fmtDur(w.duration_s)}, ${(w.distance_m / 1000).toFixed(2)} км. Данные после конца бега сохранены, границы можно поправить в карточке.`);
        any = true;
      }
      if (any) { renderRec(); renderList(); renderSession(); Sync.run(); }
      return any;
    } finally { collectingAuto = false; }
  }
  async function collectFinished() {
    if (!WR || !WR.takeFinishedSessions) return;
    await collectAutoEnded();
    let got = [];
    try { got = (await WR.takeFinishedSessions()).sessions || []; } catch (e) { return; }
    const pend = load(K_PEND) || []; localStorage.removeItem(K_PEND);
    for (const p of pend) applySession(p.id, p.sessStart, p.samples, p.sessEnd, p.lo, p.hi, true, p.rr);
    let last = null;
    for (const s of got) {
      const list = (s.workouts || []).filter((x) => x.id && !x.unfinished);
      list.forEach((x, i) => { const [lo, hi] = sessionBounds(list, i, s.sessionStart, s.sessionEnd); const r = applySession(x.id, s.sessionStart, s.samples, s.sessionEnd, lo, hi, true, s.rr); if (r) last = r; });
    }
    if (last) {
      const parts = [1, 2, 5].filter((k) => last.hrr[k] != null).map((k) => `−${Math.round(last.hrr[k])} за ${k} мин`).concat(last.tau ? [`τ ${last.tau} с`] : []);
      msg('wkMsg', 'Восстановление сохранено' + (parts.length ? ': ' + parts.join(', ') : ' (после финиша записано меньше минуты)') + '. Подробно — во вкладке «Восстановление».');
      renderList();
    }
  }
  function attachLive() {   // save the recovery collected so far (in case the phone dies)
    const list = (svc && svc.sessWorkouts) || []; if (!list.length) return null;
    const i = list.length - 1, x = list[i];
    return applySession(x.id, sess.start, sess.buf, Date.now(), i > 0 ? list[i - 1].endedAt : sess.start, Date.now(), false, sess.rr);
  }
  function liveRecovery() {
    const list = (svc && svc.sessWorkouts) || []; if (!list.length) return null;
    const x = list[list.length - 1], w = Store.workouts()[x.id]; if (!w) return null;
    const lo = list.length > 1 ? list[list.length - 2].endedAt : sess.start;
    const ss = sessionFor(w, sess.start, sess.buf, lo, Date.now());
    const srr = rrFor(w, sess.start, sess.rr, lo, Date.now());
    return { w, ss, r: A.recovery({ duration_s: w.duration_s, session_samples: ss }), h: srr.length ? A.hrv({ duration_s: w.duration_s, session_rr: srr }) : null };
  }
  function renderSession() {
    const el = $('hrSessState'); if (!el) return;
    const ph = svc && svc.running ? svc.phase : null;
    const since = (t) => fmtDur((Date.now() - t) / 1000);
    el.innerHTML = !WR ? '' : ph === 'pre' ? `<b>Мониторинг пульса</b> идёт ${since(svc.sessionStart || Date.now())} — пульс до старта сохранится как исходный.`
      : ph === 'post' ? `<b>Восстановление:</b> ${since(svc.workoutEnd || Date.now())} после финиша. Запись идёт до ${svc.postMin || postMin()} мин или пока пояс не снят.`
      : ph === 'workout' ? 'Пульс пишется вместе с тренировкой.' : (hr.connected || cfg().hrDevice ? 'Мониторинг не идёт.' : '');
    if ($('hrMonStart')) $('hrMonStart').classList.toggle('hidden', !WR || !!ph || !(hr.connected || cfg().hrDevice));
    if ($('hrMonStop')) $('hrMonStop').classList.toggle('hidden', !(ph === 'pre' || ph === 'post'));
    const rp = $('recovLive'); if (!rp) return;
    rp.classList.toggle('hidden', ph !== 'post');
    if (ph !== 'post') return;
    const lr = liveRecovery(); if (!lr || !lr.r) return;
    const r = lr.r, cell = (v, k) => `<div><b>${v}</b><span>${k}</span></div>`;
    $('recovLiveGrid').innerHTML = cell(r.hr_end || '—', 'ЧСС на финише') + cell('<i class="led' + (hrFresh() ? ' on' : '') + '"></i>' + (hrFresh() ? hr.bpm : '—'), 'сейчас') +
      [1, 2, 5].map((k) => cell(r.hrr[k] != null ? '−' + Math.round(r.hrr[k]) : '…', `за ${k} мин`)).join('') + cell(r.tau ? r.tau + ' с' : '…', 'τ (скорость спада)') +
      (lr.h && lr.h.series.length ? cell(Math.round(lr.h.series[lr.h.series.length - 1][1]), 'RMSSD сейчас, мс') : '') +
      (lr.h && lr.h.pre ? cell(Math.round(lr.h.pre.rmssd), 'RMSSD до старта') : '');
    if (window.Chart) {
      const D = lr.w.duration_s, data = lr.ss.filter((p) => p[0] >= D - 120).map((p) => ({ x: (p[0] - D) / 60, y: p[1] }));
      if (recovLiveChart) { recovLiveChart.data.datasets[0].data = data; recovLiveChart.update('none'); }
      else recovLiveChart = new Chart($('recovLiveChart'), { type: 'line', data: { datasets: [{ data, borderColor: '#3fa7ff', backgroundColor: 'rgba(63,167,255,.15)', fill: true, pointRadius: 0, borderWidth: 2 }] },
        options: { maintainAspectRatio: false, animation: false, parsing: false, plugins: { legend: { display: false } }, scales: { x: { type: 'linear', title: { display: true, text: 'мин после финиша' } } } } });
    }
  }

  // ---------- background recording via WorkoutService ----------
  async function startNative() {
    const dev = cfg().hrDevice;
    const sf = strideFor(wkType), useGps = !$('wkGps') || $('wkGps').checked;
    const a = { id: newId(), type: wkType, date: localDate(), started_at: Date.now(), samples: [], steps: 0, step_series: [], track: [],
      stride_m: sf.v, stride_source: sf.src, gps: useGps, device: dev ? dev.name : null, add_run: $('wkAddRun').checked, native: true };
    Store.setConfig({ wkGps: useGps });
    // hand the BLE link over to the service
    hr.want = false; clearTimeout(hr.retry);
    if (hr.id && BLE && hr.connected) { await BLE.disconnect(hr.id).catch(() => {}); hr.connected = false; }
    try {
      const r = await WR.start({ startedAt: a.started_at, type: a.type, stride: a.stride_m, gps: useGps, workoutId: a.id, postMin: postMin(), deviceId: dev ? dev.id : undefined, deviceName: dev ? dev.name : undefined });
      active = a; persistActive();
      msg('wkMsg', (r && r.steps === false ? 'Шаги не считаются: нет разрешения «Физическая активность». ' : '') +
        (useGps && r && r.location === false ? 'GPS не пишется: нет доступа к местоположению. ' : '') +
        (dev ? 'Запись идёт и в фоне — можно выключить экран.' : 'Запись идёт в фоне без пульсометра.'));
    } catch (e) { msg('wkMsg', 'Не удалось начать: ' + (e.message || e)); return; }
    startPolling(); renderRec(); renderBattery();
  }

  function startPolling() {
    clearInterval(pollTimer); clearInterval(tickTimer);
    pollTimer = setInterval(poll, 1000); poll();
  }

  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  async function poll() {
    if (!WR || document.hidden) return;
    const rec = active && active.native;
    if (!rec && !(svc && svc.running)) return;
    try {
      const q = { sinceSess: sess.buf.length, sinceRr: sess.rr.length, since: 1e9, sinceSteps: 1e9, sinceTrack: 1e9 };
      if (rec) { active.step_series = active.step_series || []; active.track = active.track || []; Object.assign(q, { since: active.samples.length, sinceSteps: active.step_series.length, sinceTrack: active.track.length }); }
      const st = await WR.getState(q);
      if (st.running && rec && st.phase === 'post' && st.workoutActive === false) { svc = st; await collectAutoEnded(); return; }   // closed by the service (forgotten «Стоп»); the strap session goes on
      if (st.running) {
        svc = st;
        if (st.sessionStart !== sess.start) { sess = { start: st.sessionStart, buf: st.sinceSess === 0 ? (st.sess || []) : [], rr: st.sinceRr === 0 ? (st.rr || []) : [] }; }
        else {
          if (Array.isArray(st.sess) && st.sinceSess === sess.buf.length) sess.buf.push(...st.sess);
          if (Array.isArray(st.rr) && st.sinceRr === sess.rr.length) sess.rr.push(...st.rr);
        }
        if (rec) mergeState(st);
        if (rec && typeof st.steps === 'number') active.steps = st.steps || 0;
        hr.bpm = st.bpm || null; hr.at = st.bpmAt || 0;
        hr.batt = st.strapBattery != null && st.strapBattery >= 0 ? st.strapBattery : null;
        hr.acc = st.accStatus === 'recording' ? { n: st.accSamples || 0, steps: st.accSteps || 0 } : null;
        hr.connected = st.hrStatus === 'connected'; hr.connecting = st.hrStatus === 'connecting';
        if (st.deviceName) hr.name = st.deviceName;
        msg('hrMsg', st.hrStatus && st.hrStatus.startsWith('error:') ? 'Пульсометр: ' + st.hrStatus.slice(6) : st.hrStatus === 'disconnected' ? 'Связь с пульсометром потеряна, переподключаюсь…' : '');
        if (st.phase === 'post' && Date.now() - lastPostSave > 120000) { lastPostSave = Date.now(); attachLive(); }
        if (rec) persistActive();
        renderHr(); renderLive(); renderSession();
      } else if (st.orphan) {
        msg('wkMsg', 'Запись была прервана системой — продолжаю.');
        await WR.start({ resume: true });
      } else {
        svc = null;
        await collectFinished();
        if (!rec) { stopPolling(); hr.connected = false; hr.bpm = null; renderHr(); renderLive(); }
        renderSession();
      }
    } catch (e) { /* ignore single poll errors */ }
  }

  function mergeState(st) {
    const app = (key, arr, since) => {
      if (!Array.isArray(arr)) return;
      if (since === active[key].length) active[key].push(...arr); else if (since === 0) active[key] = arr;
    };
    active.step_series = active.step_series || []; active.track = active.track || [];
    app('samples', st.samples, st.since);
    app('step_series', st.stepSeries, st.sinceSteps);
    app('track', st.track, st.sinceTrack);
    if (typeof st.steps === 'number') active.steps = Math.max(active.steps || 0, st.steps);
    if (Array.isArray(st.phonePauses)) active.phone_pauses = st.phonePauses;   // v1.16: the pauses the phone itself detected live
    if (Array.isArray(st.liveLog)) active.live_log = st.liveLog;
    active.gps_live = { status: st.gpsStatus, dist: st.gpsDist, acc: st.gpsAcc, at: st.gpsAt };
  }

  async function adoptNative() {
    if (!WR) return;
    await collectAutoEnded();
    const st = await WR.getState({ since: 0, sinceSteps: 0, sinceTrack: 0, sinceSess: 0, sinceRr: 0 }).catch(() => null);
    if (!st) return;
    if (st.running) { svc = st; sess = { start: st.sessionStart, buf: st.sess || [], rr: st.rr || [] }; }
    const recording = (st.running && st.workoutActive !== false) || (st.orphan && st.workoutActive !== false);
    if (recording) {
      if (!active) {   // app storage lost the active workout but the service still records
        active = { id: st.workoutId || newId(), type: st.type || 'run', date: localDate(new Date(st.startedAt)), started_at: st.startedAt, samples: st.samples || [],
          steps: st.steps || 0, stride_m: st.stride || stride(), device: st.deviceName || null, add_run: true, native: true, gps: st.gps !== false,
          samples: [], step_series: [], track: [] };
      } else { active.native = true; }
      active.samples = []; active.step_series = []; active.track = []; mergeState(st);
      persistActive();
      if (st.orphan) await WR.start({ resume: true }).catch(() => {});
      startPolling(); renderRec();
    } else if (st.orphan) {
      await WR.start({ resume: true }).catch(() => {});   // monitoring / recovery interrupted by the system
      svc = { running: true, phase: st.phase || 'post' }; startPolling();
    } else if (st.running) {
      startPolling();
    } else {
      await collectFinished();
      if (active && active.native) { startPolling(); renderRec(); }   // service gone without saved state: user can still press Стоп
    }
    renderSession();
  }

  // ---------- battery / autostart hint ----------
  async function renderBattery() {
    const el = $('batPanel'); if (!el || !WR) return;
    try {
      const b = await WR.batteryStatus();
      el.classList.toggle('hidden', !!b.ignoringOptimizations && !b.miui);
      $('batOptState').textContent = b.ignoringOptimizations ? 'Оптимизация батареи отключена ✔' : 'Оптимизация батареи включена — Android может остановить запись при выключенном экране.';
      $('batOpt').classList.toggle('hidden', !!b.ignoringOptimizations);
      $('batMiui').classList.toggle('hidden', !b.miui);
    } catch (e) { el.classList.add('hidden'); }
  }

  function summary(a) {
    const bpms = a.samples.map((s) => s[1]);
    const dur = (Date.now() - a.started_at) / 1000;
    return {
      duration_s: Math.round(dur),
      hr: bpms.length ? { avg: Math.round(10 * bpms.reduce((x, y) => x + y, 0) / bpms.length) / 10, max: Math.max(...bpms), min: Math.min(...bpms) } : { avg: null, max: null, min: null },
      distance_m: Math.round((a.steps || 0) * a.stride_m),
    };
  }

  async function stop() {
    if (!active) return;
    if (!confirm('Закончить тренировку?')) return;
    let stopRes = null;
    if (active.native && WR) {
      clearInterval(pollTimer);
      try {
        const res = await WR.stop();
        if (res && Array.isArray(res.samples) && res.samples.length >= active.samples.length) active.samples = res.samples;
        if (res && Array.isArray(res.stepSeries) && res.stepSeries.length >= (active.step_series || []).length) active.step_series = res.stepSeries;
        if (res && Array.isArray(res.track) && res.track.length >= (active.track || []).length) active.track = res.track;
        if (res && typeof res.steps === 'number') active.steps = Math.max(active.steps || 0, res.steps);
        if (res && Array.isArray(res.phonePauses)) active.phone_pauses = res.phonePauses;
        if (res && Array.isArray(res.liveLog)) active.live_log = res.liveLog;
        if (res && res.deviceName) active.device = res.deviceName;
        if (res && res.sessionStart) stopRes = res;
      } catch (e) { /* keep what we have */ }
      if (!(stopRes && stopRes.sessionContinues)) { hr.connected = false; hr.bpm = null; }
    }
    const SC = active.native ? null : P.StepCounter;
    if (SC) { try { onSteps(await SC.getSteps()); await SC.stop(); } catch (e) { /* ignore */ } }
    if (stepsListener) { stepsListener.remove().catch(() => {}); stepsListener = null; }
    if (P.KeepAwake) P.KeepAwake.allowSleep().catch(() => {});
    clearInterval(tickTimer);
    const a = active, s = summary(a);
    const an = A.analyze({ type: a.type, duration_s: s.duration_s, steps: a.steps || 0, stride_m: a.stride_m, step_series: a.step_series || [], track: a.track || [], phone_pauses: a.phone_pauses });
    const w = { id: a.id, type: a.type, date: a.date, started_at: a.started_at, ended_at: Date.now(), duration_s: s.duration_s,
      steps: an.steps, stride_m: a.stride_m, stride_source: a.stride_source || 'manual', distance_m: an.distance_m, hr: s.hr, samples: a.samples,
      device: a.device || hr.name || null, deleted: false,
      step_distance_m: an.step_distance_m, moving_s: an.moving_s, stop_s: an.stop_s, stops: an.stops, cadence_avg: an.cadence_avg,
      gps_distance_m: an.gps_distance_m, gps_ok: an.gps_ok, gps_acc: an.gps_acc, gps_coverage: an.gps_coverage, gps_stride_m: an.gps_stride_m,
      step_series: a.step_series || [], track: a.track || [], segments: an.segments };
    if (Array.isArray(a.phone_pauses)) w.phone_pauses = a.phone_pauses.map((x) => [x[0], x[1]]);
    if (Array.isArray(a.live_log) && a.live_log.length) w.live_log = a.live_log.slice(-400);
    if (stopRes && Array.isArray(stopRes.sess)) {   // HR before the start + during the run (recovery is added later)
      const prev = (stopRes.sessWorkouts || []).filter((x) => x.id !== w.id).pop();
      const lo = prev ? prev.endedAt : stopRes.sessionStart, end = stopRes.workoutEndedAt || w.ended_at;
      w.session_samples = sessionFor(w, stopRes.sessionStart, stopRes.sess, lo, end);
      w.session_rr = rrFor(w, stopRes.sessionStart, stopRes.rr || [], lo, end);
      w.session_start = Math.max(stopRes.sessionStart, lo); w.session_end = end;
    }
    Object.assign(w, derived(w));
    active = null; persistActive();
    if (stopRes && stopRes.sessionContinues) {
      svc = { running: true, phase: 'post', sessionStart: stopRes.sessionStart, workoutEnd: stopRes.workoutEndedAt, postMin: postMin(),
        sessWorkouts: (stopRes.sessWorkouts || []).concat([{ id: w.id, startedAt: w.started_at, endedAt: stopRes.workoutEndedAt }]) };
      sess = { start: stopRes.sessionStart, buf: stopRes.sess.slice(), rr: (stopRes.rr || []).slice() };
      lastPostSave = Date.now();
      setTimeout(startPolling, 50);
    } else if (WR) setTimeout(collectFinished, 500);
    if (w.duration_s < 5) { msg('wkMsg', 'Слишком короткая запись — не сохранена.'); renderRec(); return; }
    Store.putWorkout(w);
    const dayId = a.type === 'walk' ? 'walk' : a.type === 'run' ? 'run' : null;
    if (a.add_run && dayId && w.distance_m > 0) {   // add to today's «Бег» / «Ходьба»
      const today = localDate(), rec = Store.view(today), km = Math.round(w.distance_m / 10) / 100;
      const d = rec.distance[dayId] || (rec.distance[dayId] = { km: 0, done: false });
      d.km = Math.round(((d.km || 0) + km) * 100) / 100; d.done = true; Store.put(rec);
    }
    msg('wkMsg', `Сохранено: ${fmtDur(w.duration_s)} (в движении ${fmtDur(w.moving_s)}), ${(w.distance_m / 1000).toFixed(2)} км` +
      (an.pace_s_km ? `, темп ${fmtPace(an.pace_s_km)}/км` : '') + (w.hr.avg ? `, пульс ср. ${Math.round(w.hr.avg)}` : '') +
      (w.gps_distance_m != null ? (w.gps_ok ? ' · GPS ✔' : ' · GPS слабый, дистанция по шагам') : ''));
    if (WR && WR.announceFinish && a.type === 'run') WR.announceFinish({ type: 'run', distance_m: w.distance_m, moving_s: w.moving_s, pace_s_km: an.pace_s_km || 0, hr_avg: w.hr && w.hr.avg ? w.hr.avg : 0 }).catch(() => {});
    if (stopRes && stopRes.sessionContinues) msg('wkMsg', $('wkMsg').textContent + `. Пульс восстановления пишется ещё до ${postMin()} мин — потом сними пояс (или «Завершить мониторинг»).`);
    renderRec(); renderList(); renderSession();
  }

  function renderRec() {
    if (!$('wkStart')) return;
    $('wkStart').classList.toggle('hidden', !!active);
    $('wkStop').classList.toggle('hidden', !active);
    document.querySelectorAll('#wkTypeSeg button').forEach((b) => { b.disabled = !!active; b.classList.toggle('active', b.dataset.type === (active ? active.type : wkType)); });
    $('strideLabel').textContent = (active ? active.stride_m : stride()).toFixed(2);
    renderLive();
  }

  let lastChartAt = 0, lastAnAt = 0, lastAn = null;
  function renderLive() {
    if (!$('liveHr')) return;
    const fresh = hr.bpm && Date.now() - hr.at < 6000;
    $('liveHr').textContent = fresh ? hr.bpm : '—';
    $('liveHr').parentElement.classList.toggle('stale', !fresh);
    if (!active) { return; }
    const s = summary(active), dur = (Date.now() - active.started_at) / 1000;
    $('liveTime').textContent = fmtDur(dur);
    $('liveAvg').textContent = s.hr.avg ? Math.round(s.hr.avg) : '—';
    $('liveMax').textContent = s.hr.max || '—';
    $('liveSteps').textContent = active.steps || 0;
    $('liveDist').textContent = (s.distance_m / 1000).toFixed(2);
    if (Date.now() - lastAnAt > 3000 || !lastAn) {
      lastAnAt = Date.now();
      lastAn = A.analyze({ duration_s: dur, steps: active.steps || 0, stride_m: active.stride_m, step_series: active.step_series || [], track: active.track || [] });
    }
    const an = lastAn, g = active.gps_live || {};
    const gpsKm = g.dist != null && g.dist > 0 ? g.dist / 1000 : (an.gps_distance_m != null ? an.gps_distance_m / 1000 : null);
    const useGps = g.status === 'ok' && gpsKm != null && gpsKm > 0.05;
    const mainKm = useGps ? gpsKm : s.distance_m / 1000, moving = an.moving_s;
    $('livePace').textContent = mainKm > 0.05 && moving > 0 ? fmtDur(moving / mainKm) : '—';
    $('liveMoving').textContent = fmtDur(moving) + (an.stops ? ` (${an.stops} ост.)` : '');
    $('liveGps').textContent = gpsKm != null ? gpsKm.toFixed(2) : '—';
    // live cadence: last ~20 s of the step series (0 when no steps for 10 s)
    const ss = active.step_series || []; let lastCad = null;
    if (ss.length >= 2) {
      const L = ss[ss.length - 1];
      if (dur - L[0] > 10) lastCad = 0;
      else { let j = ss.length - 1; while (j > 0 && L[0] - ss[j][0] < 20) j--; const dt = L[0] - ss[j][0]; if (dt >= 3) lastCad = Math.round((L[1] - ss[j][1]) * 60 / dt); }
    }
    $('liveCad').textContent = lastCad != null ? lastCad : '—';
    const GS = { ok: 'GPS: сигнал есть', searching: 'GPS: ищу спутники…', disabled: 'GPS выключен в настройках телефона', 'no-permission': 'GPS: нет доступа к местоположению', off: 'GPS не используется' };
    msg('liveGpsState', active.native ? (GS[g.status] || '') + (g.status === 'ok' && g.acc ? ` (±${Math.round(g.acc)} м)` : '') + (useGps ? ' · темп по GPS' : ' · темп по шагам') : '');
    if (Date.now() - lastChartAt > 3000) { lastChartAt = Date.now(); drawChart('liveChart', active.samples, true); }
  }

  const fmtSigned = (sec) => { sec = Math.round(sec); return (sec < 0 ? '−' : '') + fmtDur(Math.abs(sec)); };

  function drawChart(canvasId, samples, live, durationS) {
    if (!window.Chart) return;
    const data = samples.map((s) => ({ x: s[0] / 60, y: s[1] }));
    const existing = canvasId === 'liveChart' ? liveChart : detailChart;
    if (existing) { existing.data.datasets[0].data = data; existing.update('none'); return existing; }
    const xmax = live ? undefined : Math.max((durationS || 0) / 60, data.length ? data[data.length - 1].x : 1);
    const plugins = !live && window.FTRecoveryUI && window.FTRecoveryUI.zonesPlugin ? [window.FTRecoveryUI.zonesPlugin] : [];
    const ch = new Chart($(canvasId), {
      type: 'line', plugins,
      data: { datasets: [{ label: 'Пульс', data, borderColor: '#ff4d4d', backgroundColor: 'rgba(255,77,77,.15)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.2 }] },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        interaction: live ? undefined : { mode: 'nearest', axis: 'x', intersect: false },
        plugins: { legend: { display: false },
          ...(live ? {} : {
            tooltip: { callbacks: { title: (items) => items.length ? fmtSigned(items[0].parsed.x * 60) : '', label: (c) => `Пульс: ${Math.round(c.parsed.y)}` } },
            ftZones: { zones: [] },
          }) },
        scales: {
          x: { type: 'linear', ...(live ? {} : { min: 0, max: xmax }), title: { display: !live, text: live ? 'минуты' : 'время от старта' },
            ticks: { callback: (v) => live ? Math.round(v * 10) / 10 : fmtSigned(v * 60) } },
          y: { suggestedMin: 60, suggestedMax: 180 },
        } },
    });
    if (canvasId === 'liveChart') liveChart = ch; else detailChart = ch;
    return ch;
  }

  // ---------------- list & detail ----------------
  function renderList() {
    const el = $('wkList'); if (!el) return;
    const list = Store.workoutList(), pend = new Set(Store.wdirty());
    if (!list.length) { el.innerHTML = '<div class="small muted">Пока нет записанных тренировок.</div>'; return; }
    el.innerHTML = list.slice(0, 100).map((w) => {
      const d = new Date(w.started_at);
      const when = d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const hrTxt = w.hr && w.hr.avg ? ` · ♥ ${Math.round(w.hr.avg)}/${w.hr.max}` : '';
      return `<div class="wk-item" data-id="${w.id}"><div><div class="t">${TYPES[w.type] || w.type} · ${when}</div>` +
        `<div class="small muted">${fmtDur(w.duration_s)} · ${w.steps} шагов${pend.has(w.id) ? ' · <span class="wk-pending">не отправлено</span>' : ''}</div></div>` +
        `<div class="m">${(w.distance_m / 1000).toFixed(2)} км${hrTxt}</div></div>`;
    }).join('');
    el.querySelectorAll('.wk-item').forEach((it) => it.addEventListener('click', () => openDetail(it.dataset.id)));
  }

  let savedChartView = null;   // { id, min, max } — preserved while editing/saving the same workout
  let wkEditor = null;

  async function openDetail(id, opts) {
    let w = Store.workouts()[id]; if (!w) return;
    detailId = id;
    const empty = (k) => !w[k] || !w[k].length;
    if (w.samples_trimmed || (empty('samples') && empty('step_series') && empty('track'))) {
      try {
        const full = await api('api/workouts/' + id);
        if (full) {
          w = Object.assign({}, w, { samples: full.samples || [], step_series: full.step_series || [], track: full.track || [], segments: full.segments || [], session_samples: full.session_samples || [], session_rr: full.session_rr || [], motion: full.motion || [], tail: full.tail || null });
          delete w.samples_trimmed;
        }
      } catch (e) { /* offline */ }
    }
    if ((w.analysis_v || 0) < A.ANALYSIS_V) w = Object.assign({}, w, derived(w));   // older records: derived analytics on the fly
    const an = A.analyze(w);   // recompute profiles (also for workouts recorded before v1.3)
    const q = w.quality || null;
    const QL = { good: ['хорошее', 'q-good'], fair: ['среднее', 'q-fair'], poor: ['плохое', 'q-poor'] };
    const moving = w.moving_s != null ? w.moving_s : an.moving_s, stops = w.moving_s != null ? w.stops : an.stops, stopS = w.moving_s != null ? w.stop_s : an.stop_s;
    const pace = (m) => m > 50 && moving > 0 ? fmtDur(moving / (m / 1000)) + ' мин/км' : '—';
    const stepDist = w.step_distance_m != null ? w.step_distance_m : Math.round((w.steps || 0) * (w.stride_m || 0.75));
    const d = new Date(w.started_at);
    $('wkDetailTitle').textContent = `${TYPES[w.type] || w.type}, ${d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
    const gpsTxt = w.gps_distance_m != null ? (w.gps_distance_m / 1000).toFixed(2) + ' км' + (w.gps_ok ? '' : ' (слабый сигнал)') : '—';
    const seg = w.seg || an.seg, beltless = !!w.beltless;
    const segRu = { auto: 'найден по данным', override: 'поправлен вручную', none: 'бег не найден — вся запись', whole: '' };
    const pauseOvNote = Array.isArray(w.pause_override) && seg.src !== 'override' ? ', паузы вручную' : '';
    const segRows = seg && seg.src !== 'whole' ? [['Подход · бег · отход', `${fmtDur(seg.approach_s)} · <span class="seg-run">${fmtDur(seg.run_s)}</span> · ${fmtDur(seg.cooldown_s)} <span class="muted small">(${segRu[seg.src] || ''}${pauseOvNote}${seg.conf && seg.src === 'auto' ? ', уверенность ' + ({ high: 'высокая', medium: 'средняя', low: 'низкая' }[seg.conf] || seg.conf) : ''})</span>`]] : [];
    $('wkDetailStats').innerHTML = [
      ['Время общее', fmtDur(w.duration_s)], ...segRows, ['В движении', fmtDur(moving)], ['Остановки', stops ? `${stops}, ${fmtDur(stopS)}` : 'нет'],
      ['Дистанция', (w.distance_m / 1000).toFixed(2) + ' км' + (w.gps_ok ? ' (GPS)' : ' (по шагам)')],
      ['Темп (в движении)', pace(w.distance_m)],
      ['По шагам', (stepDist / 1000).toFixed(2) + ' км · ' + pace(stepDist)], ['По GPS', gpsTxt + (w.gps_distance_m ? ' · ' + pace(w.gps_distance_m) : '')],
      ['Шаги', w.steps + (w.steps_start_missed ? ` <span class="muted small">(+≈${w.steps_start_missed} в первые секунды, не посчитаны датчиком)</span>` : '')], ['Каденс средний', (w.cadence_avg || an.cadence_avg || '—') + (w.cadence_avg || an.cadence_avg ? ' шаг/мин' : '')],
      ...(beltless ? [] : [['Пульс средний', w.hr && w.hr.avg ? Math.round(w.hr.avg) + (q && q.masked_s && w.hr_raw && w.hr_raw.avg ? ` <span class="muted small">(с помехами ${Math.round(w.hr_raw.avg)})</span>` : '') : '—'],
      ['Пульс макс / мин', w.hr && w.hr.max ? `${w.hr.max} / ${w.hr.min}` + (q && q.masked_s && w.hr_raw && w.hr_raw.max !== w.hr.max ? ` <span class="muted small">(с помехами ${w.hr_raw.max})</span>` : '') : '—'],
      ['Качество сигнала', q ? `<span class="qbadge ${QL[q.label][1]}" id="wkQuality">${QL[q.label][0]}</span>` + (q.masked_s ? ` <span class="small">помехи ${fmtDur(q.masked_s)} (${Math.round(q.masked_pct)}%) — исключены</span>` : '') : '—']]),
      ['Длина шага', (w.stride_m || 0.75) + ' м' + (w.stride_source === 'auto' ? ' (калибровка)' : '')],
      ['Шаг по GPS', w.gps_stride_m ? w.gps_stride_m.toFixed(2) + ' м' : '—'], ['Устройство', beltless ? 'без пояса (шагомер и акселерометр телефона)' : (w.device || '—')],
    ].map(([k, v]) => `<div>${k}: <b>${v}</b></div>`).join('') + (beltless ? '<div class="small muted">Пробежка без пояса: пульса, восстановления и беговой динамики нет.</div>' : '');
    $('wkDetail').classList.remove('hidden');
    if (detailChart) { detailChart.destroy(); detailChart = null; }
    destroyChartEditor();
    const hasHr = !beltless && ((w.session_samples && w.session_samples.length) || (w.samples && w.samples.length));
    $('wkHrTitle').classList.toggle('hidden', !hasHr); $('wkChartBox').classList.toggle('hidden', !hasHr);
    if (hasHr && w.session_samples && w.session_samples.length) { detailChart = window.FTRecoveryUI.sessionChart($('wkChart'), w); $('wkHrTitle').textContent = 'Пульс: до старта, подход, бег, восстановление'; }
    else if (hasHr) { drawChart('wkChart', w.samples || [], false, w.duration_s); $('wkHrTitle').textContent = 'Пульс'; }
    const rv = !beltless && w.session_samples && w.session_samples.length ? A.recovery(w) : null;
    const hv = rv && w.session_rr && w.session_rr.length ? A.hrv(w) : null;
    $('wkRecovery').innerHTML = rv ? window.FTRecoveryUI.metricsHtml(rv) + (hv && (hv.pre || hv.post5_10) ? '<div class="rec-metrics">' +
      [[hv.pre && hv.pre.rmssd, 'RMSSD до старта, мс'], [hv.pre && hv.pre.sdnn, 'SDNN до старта, мс'], [hv.post5_10 && hv.post5_10.rmssd, 'RMSSD 5–10 мин после'], [hv.post_end && hv.post_end.rmssd, 'RMSSD в конце']]
        .map(([v, k]) => `<div><b>${v != null ? Math.round(v) : '—'}</b>${k}</div>`).join('') + '</div>' : '') : '';
    $('wkRecovery').classList.toggle('hidden', !rv);
    const qn = $('wkQualityNote');
    if (qn) {
      const notes = [];
      if (!beltless && q && q.masked_s) notes.push(`Пульс на участках, отмеченных на графике красным (${fmtDur(q.masked_s)}), похож на «залипание» на каденс: датчик считал шаги вместо ударов (пульс ≈ каденсу, интервалы между ударами чередуются 1:2). Эти участки не входят в средний и максимальный пульс. Обычно помогает смочить электроды перед стартом и затянуть пояс плотнее.`);
      else if (!beltless && q && q.label !== 'good' && q.rr_artifacts_pct != null) notes.push(`Отброшено ${q.rr_artifacts_pct}% межударных интервалов как артефакты — смочи электроды и подтяни пояс.`);
      if (w.inherit) { const p = Store.workouts()[w.inherit.of]; notes.push(`Повторная пробежка в той же сессии: исходный пульс и HRV до старта взяты из записи перед первой пробежкой${p ? ' (' + new Date(p.started_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ')' : ''}, а не из отдыха между пробежками.`); }
      qn.innerHTML = notes.map((t) => `<p class="small">${t}</p>`).join('');
      qn.classList.toggle('hidden', !notes.length);
    }
    drawProfiles(w, an);
    if (cadChart) markSeg(cadChart, seg);
    if (detailChart) {
      if (!isNative) initChartEditor(w, an, detailChart, seg);
      else markSeg(detailChart, seg);
    }
    renderSegControls(w, seg);
    if (window.FTDyn) window.FTDyn.show(w, beltless);
    drawMap(w.track || []);
    if (!(opts && opts.keepScroll)) $('wkDetail').scrollIntoView({ behavior: 'smooth' });
  }

  // ---------------- run boundaries on charts + interactive web editor ----------------
  function drawPill(ctx, text, cx, y, fg, bg, ca) {
    ctx.font = 'bold 11px Arial';
    const padX = 5, h = 16, w = Math.ceil(ctx.measureText(text).width) + padX * 2;
    const x = Math.max(ca.left + 2, Math.min(ca.right - w - 2, Math.round(cx - w / 2)));
    const top = y - h;
    ctx.fillStyle = bg; ctx.strokeStyle = fg; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, top, w, h, 4); else ctx.rect(x, top, w, h);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, top + h / 2 + 0.5);
    return { x, y: top, w, h };
  }

  // Chart.js plugin: marker lines + interactive handles/delete badges/drag preview; pauses are shaded by ftZones when present
  function ensureSegPlugin() {
    if (!window.Chart || window.Chart.registry.plugins.get('ftSegBands')) return;
    window.Chart.register({ id: 'ftSegBands', afterDatasetsDraw(chart) {
      const ed = chart.$editor, sg = ed ? ed.draft : chart.$seg, xs = chart.scales && chart.scales.x;
      if (!sg || !xs) return;
      const { ctx, chartArea: ca } = chart; ctx.save();
      const X = (t) => xs.getPixelForValue(t / 60);
      const hasZones = !!(chart.options && chart.options.plugins && chart.options.plugins.ftZones);
      if (ed) { ed.delHits = []; ed.markerHits = []; }
      const pauses = sg.pauses || [];
      for (let i = 0; i < pauses.length; i++) {
        const [a, b] = pauses[i];
        const rx0 = X(a), rx1 = X(b), x0 = Math.max(ca.left, rx0), x1 = Math.min(ca.right, rx1);
        if (!hasZones && x1 > x0) { ctx.fillStyle = 'rgba(255,170,40,.28)'; ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top); }
        if (ed && ed.canEdit && rx1 >= ca.left - 8 && rx0 <= ca.right + 8) {
          const sel = ed.selectedPause === i;
          const hStart = (ed.hover && ed.hover.type === 'pauseStart' && ed.hover.idx === i) || (ed.drag && ed.drag.kind === 'marker' && ed.drag.target.type === 'pauseStart' && ed.drag.target.idx === i);
          const hEnd = (ed.hover && ed.hover.type === 'pauseEnd' && ed.hover.idx === i) || (ed.drag && ed.drag.kind === 'marker' && ed.drag.target.type === 'pauseEnd' && ed.drag.target.idx === i);
          if (sel && x1 > x0) { ctx.fillStyle = 'rgba(255,209,102,.14)'; ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top); }
          for (const [xp, act] of [[rx0, hStart], [rx1, hEnd]]) {
            if (xp < ca.left - 1 || xp > ca.right + 1) continue;
            ctx.strokeStyle = act || sel ? '#ffd166' : '#ffb020';
            ctx.lineWidth = act ? 2.5 : 1.5;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(xp, ca.top); ctx.lineTo(xp, ca.bottom); ctx.stroke();
            ctx.fillStyle = act || sel ? '#ffd166' : '#ffb020';
            ctx.fillRect(xp - 2.5, (ca.top + ca.bottom) / 2 - 10, 5, 20);
          }
          if (x1 > ca.left + 8 && x0 < ca.right - 8) {
            const bw = 15, bh = 15;
            const bx = x1 - x0 >= 20 ? Math.min(ca.right - bw - 2, x1 - bw - 2) : Math.max(ca.left + 2, Math.min(ca.right - bw - 2, (x0 + x1) / 2 - bw / 2));
            const by = ca.top + 4;
            const hot = ed.hover && ed.hover.type === 'pauseDel' && ed.hover.idx === i;
            ctx.fillStyle = hot ? '#c92a2a' : 'rgba(24,24,24,.88)';
            ctx.strokeStyle = hot ? '#ff8787' : '#ffb020'; ctx.lineWidth = 1;
            ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 3); else ctx.rect(bx, by, bw, bh);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('×', bx + bw / 2, by + bh / 2 + 0.5);
            ed.delHits.push({ idx: i, x: bx, y: by, w: bw, h: bh });
          }
        }
      }
      if (sg.src !== 'whole' && (sg.src !== 'none' || (ed && ed.canEdit))) {
        const xStart = X(sg.t0), xEnd = X(sg.t1);
        const near = Math.abs(xEnd - xStart) < 95;
        const marks = [
          { k: 't0', t: sg.t0, x: xStart, col: '#39d353', hotCol: '#7bff95', txt: ed && ed.drag && ed.drag.kind === 'marker' && ed.drag.target.type === 't0' ? `старт ${fmtDur(sg.t0)}` : 'старт бега', y: ca.bottom - 6 },
          { k: 't1', t: sg.t1, x: xEnd, col: '#ff7a45', hotCol: '#ffaa85', txt: ed && ed.drag && ed.drag.kind === 'marker' && ed.drag.target.type === 't1' ? `финиш ${fmtDur(sg.t1)}` : 'финиш', y: near ? ca.bottom - 26 : ca.bottom - 6 },
        ];
        for (const m of marks) {
          if (m.x < ca.left - 1 || m.x > ca.right + 1) continue;
          const act = ed && ((ed.hover && ed.hover.type === m.k) || (ed.drag && ed.drag.kind === 'marker' && ed.drag.target.type === m.k));
          ctx.strokeStyle = act ? m.hotCol : m.col; ctx.lineWidth = act ? 2.5 : 1.7; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(m.x, ca.top); ctx.lineTo(m.x, ca.bottom); ctx.stroke();
          ctx.setLineDash([]);
          if (ed && ed.canEdit) {
            ctx.fillStyle = act ? m.hotCol : m.col;
            ctx.beginPath(); ctx.moveTo(m.x - 5, ca.top); ctx.lineTo(m.x + 5, ca.top); ctx.lineTo(m.x, ca.top + 7); ctx.closePath(); ctx.fill();
            ed.markerHits.push({ type: m.k, x: m.x - 10, y: ca.top - 4, w: 20, h: 16 });
          }
          const pill = drawPill(ctx, m.txt, m.x, m.y, act ? m.hotCol : m.col, 'rgba(16,16,16,.88)', ca);
          if (ed && ed.canEdit && pill) ed.markerHits.push({ type: m.k, x: pill.x, y: pill.y, w: pill.w, h: pill.h });
        }
      }
      if (ed && ed.drag && ed.drag.kind === 'addPause') {
        const a = Math.min(ed.drag.t0, ed.drag.t1), b = Math.max(ed.drag.t0, ed.drag.t1);
        const x0 = Math.max(ca.left, X(a)), x1 = Math.min(ca.right, X(b));
        if (x1 >= x0) {
          ctx.fillStyle = 'rgba(255,170,40,.38)'; ctx.fillRect(x0, ca.top, Math.max(2, x1 - x0), ca.bottom - ca.top);
          ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.strokeRect(x0, ca.top + 1, Math.max(2, x1 - x0), ca.bottom - ca.top - 2);
          ctx.setLineDash([]);
          drawPill(ctx, `пауза ${fmtDur(a)}–${fmtDur(b)} (${b - a} с)`, (x0 + x1) / 2, ca.top + 26, '#ffd166', 'rgba(16,16,16,.92)', ca);
        }
      } else if (ed && ed.drag && ed.drag.kind === 'zoomBox') {
        const x0 = Math.min(ed.drag.x0, ed.drag.x1), x1 = Math.max(ed.drag.x0, ed.drag.x1);
        ctx.fillStyle = 'rgba(63,167,255,.22)'; ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top);
        ctx.strokeStyle = '#3fa7ff'; ctx.lineWidth = 1.5; ctx.strokeRect(x0, ca.top + 1, x1 - x0, ca.bottom - ca.top - 2);
      } else if (ed && ed.drag && ed.drag.kind === 'marker') {
        const t = ed.drag.target;
        const sec = t.type === 't0' ? sg.t0 : t.type === 't1' ? sg.t1 : t.type === 'pauseStart' ? pauses[t.idx][0] : pauses[t.idx][1];
        const hr = hrAtSec(ed.hrPts, sec);
        const lbl = `${fmtSigned(sec)}${t.type === 't0' && sec === 0 ? ' (начало)' : ''}${hr != null ? ' · ' + Math.round(hr) + ' уд/мин' : ''}`;
        drawPill(ctx, lbl, X(sec), Math.max(ca.top + 22, (ed.drag.py || ca.top + 40) - 10), '#fff', 'rgba(18,18,18,.94)', ca);
      }
      ctx.restore();
    } });
  }
  function markSeg(chart, seg) { if (!chart || !seg) return; ensureSegPlugin(); chart.$seg = seg; chart.update('none'); }

  function hrAtSec(pts, sec) {
    if (!pts || !pts.length) return null;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= sec) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi];
    const p = Math.abs(a[0] - sec) <= Math.abs(b[0] - sec) ? a : b;
    return Math.abs(p[0] - sec) <= 15 ? p[1] : null;
  }

  function destroyChartEditor() {
    const c = $('wkChart');
    if (c && c._edAbort) { c._edAbort.abort(); c._edAbort = null; }
    if (c) c.style.cursor = '';
    const box = $('wkChartBox'); if (box) box.classList.remove('editing');
    const bar = $('wkChartBar'); if (bar) bar.classList.add('hidden');
    const foot = $('wkChartFoot'); if (foot) foot.classList.add('hidden');
    const dbg = $('wkSegDebug'); if (dbg) { dbg.classList.add('hidden'); dbg.textContent = ''; }
    wkEditor = null;
  }

  function initChartEditor(w, an, chart, seg) {
    ensureSegPlugin();
    const canvas = $('wkChart'); if (!canvas || !chart) return;
    destroyChartEditor();
    const bar = $('wkChartBar'), foot = $('wkChartFoot'), box = $('wkChartBox');
    if (bar) bar.classList.remove('hidden');
    if (foot) foot.classList.remove('hidden');
    if (box) box.classList.add('editing');
    const ds0 = chart.data.datasets[0] && chart.data.datasets[0].data || [];
    const xsOpt = chart.options.scales.x;
    const fullMin = xsOpt.min != null ? xsOpt.min : (ds0.length ? Math.min(0, ds0[0].x) : 0);
    const fullMax = Math.max(xsOpt.max != null ? xsOpt.max : (ds0.length ? ds0[ds0.length - 1].x : 1), (w.duration_s || 0) / 60);
    let viewMin = fullMin, viewMax = fullMax;
    if (savedChartView && savedChartView.id === w.id) {
      const sp = savedChartView.max - savedChartView.min;
      if (sp >= 0.2 && sp < fullMax - fullMin - 0.01) {
        viewMin = Math.max(fullMin, Math.min(fullMax - sp, savedChartView.min));
        viewMax = viewMin + sp;
      }
    }
    const cut = w.tail_cut != null ? w.tail_cut : Infinity;
    const hrPts = w.session_samples && w.session_samples.length ? w.session_samples.filter((p) => p[0] < cut) : (w.samples || []);
    const canEdit = w.type === 'run';
    const debugOn = new URLSearchParams(location.search).get('debug') === 'seg';
    const ed = {
      w, an, chart, canvas, canEdit, hrPts,
      fullMin, fullMax, viewMin, viewMax,
      mode: 'pan', drag: null, hover: null, hoverSec: null, selectedPause: null, delHits: [],
      pts: new Map(), pinch: null, saving: false, debugOn, debugLines: [], moveCount: 0,
      draft: {
        t0: Math.round(seg.t0), t1: Math.round(seg.t1),
        pauses: (seg.pauses || []).map(([a, b]) => [Math.round(a), Math.round(b)]),
        src: seg.src, runTouched: false, pausesTouched: false, t0Moved: false, t1Moved: false, dirty: false,
      },
    };
    const dbgEl = $('wkSegDebug');
    if (dbgEl) dbgEl.classList.toggle('hidden', !debugOn);
    function dbg(msg) {
      if (!ed.debugOn) return;
      const t = new Date().toISOString().slice(11, 23);
      ed.debugLines.push(`${t} ${msg}`);
      if (ed.debugLines.length > 25) ed.debugLines.shift();
      if (dbgEl) {
        const r = canvas.getBoundingClientRect();
        const hdr = `build=${window.FT_BUILD || '?'} win=${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio} canvas=${Math.round(r.width)}x${Math.round(r.height)} view=[${ed.viewMin.toFixed(2)},${ed.viewMax.toFixed(2)}] draft={t0:${ed.draft.t0},t1:${ed.draft.t1},p:${JSON.stringify(ed.draft.pauses)}}`;
        dbgEl.textContent = hdr + '\n' + ed.debugLines.join('\n');
      }
    }
    wkEditor = ed;
    chart.$editor = ed;
    xsOpt.min = viewMin; xsOpt.max = viewMax;

    const ac = new AbortController(), sig = { signal: ac.signal };
    canvas._edAbort = ac;

    const setView = (lo, hi) => {
      const span = Math.max(0.25, Math.min(ed.fullMax - ed.fullMin, hi - lo));
      lo = Math.max(ed.fullMin, Math.min(ed.fullMax - span, lo));
      hi = lo + span;
      ed.viewMin = lo; ed.viewMax = hi;
      savedChartView = { id: w.id, min: lo, max: hi };
      chart.options.scales.x.min = lo; chart.options.scales.x.max = hi;
      chart.update('none');
      syncButtons();
    };
    const zoomFactor = (f, anchorFrac) => {
      const span = ed.viewMax - ed.viewMin;
      const frac = anchorFrac == null ? 0.5 : Math.max(0, Math.min(1, anchorFrac));
      const anchor = ed.viewMin + span * frac;
      const ns = Math.max(0.25, Math.min(ed.fullMax - ed.fullMin, span * f));
      setView(anchor - ns * frac, anchor + ns * (1 - frac));
    };
    const secAtPx = (px) => Math.round(chart.scales.x.getValueForPixel(px) * 60);
    const clampSec = (s, lo, hi) => Math.max(lo, Math.min(hi, s));

    function hitTest(px, py) {
      if (!ed.canEdit) return null;
      const ca = chart.chartArea;
      if (!ca || px < ca.left - 16 || px > ca.right + 16 || py < ca.top - 10 || py > ca.bottom + 18) return null;
      const xs = chart.scales.x, X = (t) => xs.getPixelForValue(t / 60);
      const HIT = 16;
      const cands = [];
      const ps = ed.draft.pauses;
      for (let i = 0; i < ps.length; i++) {
        cands.push({ type: 'pauseStart', idx: i, d: Math.abs(px - X(ps[i][0])) });
        cands.push({ type: 'pauseEnd', idx: i, d: Math.abs(px - X(ps[i][1])) });
      }
      cands.push({ type: 't0', d: Math.abs(px - X(ed.draft.t0)) });
      cands.push({ type: 't1', d: Math.abs(px - X(ed.draft.t1)) });
      // pills and top handles are full grab targets, even when the click is far from the hairline
      for (const b of (ed.markerHits || [])) {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          const hit = cands.find((c) => c.type === b.type && (b.idx == null || c.idx === b.idx));
          if (hit) hit.d = Math.min(hit.d, 0);
        }
      }
      const score = (c) => (c.type === 't0' || c.type === 't1') ? c.d - 6 : c.d;
      const pri = (c) => (c.type === 't0' || c.type === 't1') ? 0 : 1;
      cands.sort((a, b) => score(a) - score(b) || pri(a) - pri(b) || a.d - b.d);
      const marker = (cands.length && cands[0].d <= HIT) ? cands[0] : null;
      let del = null;
      for (const b of ed.delHits) {
        if (px >= b.x - 3 && px <= b.x + b.w + 3 && py >= b.y - 3 && py <= b.y + b.h + 3) { del = { type: 'pauseDel', idx: b.idx }; break; }
      }
      // × deletes the pause unless the click is right on t0/t1 (<= 6 px or on its pill/triangle)
      if (del && marker && (marker.type === 't0' || marker.type === 't1') && marker.d <= 6) return marker;
      if (del) return del;
      return marker;
    }

    function updateReadout(sec, prefix, note) {
      const el = $('wkCursorReadout'); if (!el) return;
      if (sec == null) { el.textContent = ''; return; }
      const hr = hrAtSec(ed.hrPts, sec);
      el.textContent = `${prefix ? prefix + ' ' : ''}${fmtSigned(sec)}${note ? ' ' + note : ''}${hr != null ? ' · ' + Math.round(hr) + ' уд/мин' : ''}`;
    }

    function syncButtons() {
      const zOut = $('wkZOut'), zReset = $('wkZReset'), zBox = $('wkZBox'), addP = $('wkAddPause'), zRun = $('wkZRun');
      const zoomed = ed.viewMax - ed.viewMin < (ed.fullMax - ed.fullMin) - 0.02;
      if (zOut) zOut.disabled = !zoomed;
      if (zReset) zReset.disabled = !zoomed;
      if (zRun) zRun.classList.toggle('hidden', !ed.canEdit);
      if (zBox) zBox.classList.toggle('active', ed.mode === 'zoomBox');
      if (addP) { addP.classList.toggle('hidden', !ed.canEdit); addP.classList.toggle('active', ed.mode === 'addPause'); }
      const hasOv = !!(ed.w.run_override || Array.isArray(ed.w.pause_override));
      const saveB = $('wkSegSave'), cancelB = $('wkSegCancel'), resetB = $('wkSegReset'), stEl = $('wkSegStatus');
      if (saveB) { saveB.classList.toggle('hidden', !ed.canEdit || !ed.draft.dirty); saveB.disabled = ed.saving; }
      if (cancelB) { cancelB.classList.toggle('hidden', !ed.canEdit || !ed.draft.dirty); cancelB.disabled = ed.saving; }
      if (resetB) { resetB.classList.toggle('hidden', !ed.canEdit || (!hasOv && !ed.draft.dirty)); resetB.disabled = ed.saving; }
      if (stEl && !ed.saving) stEl.textContent = ed.draft.dirty ? 'Есть несохранённые правки' : (hasOv ? 'Границы поправлены вручную' : '');
      const chipsEl = $('wkPauseChips');
      if (chipsEl) {
        if (!ed.canEdit) chipsEl.innerHTML = '';
        else if (!ed.draft.pauses.length) chipsEl.innerHTML = '<span class="small muted">Паузы: нет</span>';
        else {
          chipsEl.innerHTML = '<span class="small muted">Паузы:</span>' + ed.draft.pauses.map(([a, b], i) =>
            `<span class="pause-chip${ed.selectedPause === i ? ' sel' : ''}" data-i="${i}">${fmtDur(a)}–${fmtDur(b)} (${fmtDur(b - a)}) <button type="button" class="p-del" data-i="${i}" title="Удалить паузу">×</button></span>`).join('');
          chipsEl.querySelectorAll('.pause-chip').forEach((ch) => ch.addEventListener('click', (e) => {
            if (e.target.classList.contains('p-del')) return;
            const i = +ch.dataset.i, p = ed.draft.pauses[i];
            if (!p) return;
            ed.selectedPause = i;
            // pan/zoom gently so the pause is visible if off-screen
            const aM = p[0] / 60, bM = p[1] / 60;
            if (bM < ed.viewMin || aM > ed.viewMax) { const pad = Math.max(1, (ed.viewMax - ed.viewMin) * 0.3); setView((aM + bM) / 2 - pad, (aM + bM) / 2 + pad); }
            else syncVisuals();
          }));
          chipsEl.querySelectorAll('.p-del').forEach((btn) => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = +btn.dataset.i;
            ed.draft.pauses.splice(i, 1);
            ed.draft.pausesTouched = true; ed.draft.dirty = true; ed.selectedPause = null;
            syncVisuals();
          }));
        }
      }
      if ($('wkChartHint')) $('wkChartHint').classList.toggle('hidden', !ed.canEdit);
    }

    function paintChart() {
      if (chart.options.plugins.ftZones && window.FTRecoveryUI && window.FTRecoveryUI.sessionZones) {
        chart.options.plugins.ftZones.zones = window.FTRecoveryUI.sessionZones(ed.w, ed.fullMin, ed.fullMax, ed.draft);
      }
      chart.update('none');
    }
    function syncVisuals() {
      paintChart();
      if (cadChart) {
        cadChart.$seg = Object.assign({}, cadChart.$seg || {}, { t0: ed.draft.t0, t1: ed.draft.t1, pauses: ed.draft.pauses, src: ed.draft.runTouched ? 'override' : ed.draft.src });
        cadChart.update('none');
      }
      // Showing Save/Cancel above the chart mid-drag shrinks the canvas (scrollbar) and
      // Chart.js resize drops pointer capture — the marker then freezes after a tiny move.
      if (!ed.drag) {
        syncButtons();
        renderSegControls(ed.w, { t0: ed.draft.t0, t1: ed.draft.t1, pauses: ed.draft.pauses, src: ed.draft.runTouched ? 'override' : ed.draft.src });
      }
    }
    ed.syncVisuals = syncVisuals;
    ed.syncButtons = syncButtons;
    ed.setView = setView;

    // Toolbar buttons
    if ($('wkZIn')) $('wkZIn').addEventListener('click', () => zoomFactor(0.6), sig);
    if ($('wkZOut')) $('wkZOut').addEventListener('click', () => zoomFactor(1.6), sig);
    if ($('wkZReset')) $('wkZReset').addEventListener('click', () => setView(ed.fullMin, ed.fullMax), sig);
    if ($('wkZRun')) $('wkZRun').addEventListener('click', () => {
      const pad = Math.max(0.5, (ed.draft.t1 - ed.draft.t0) / 60 * 0.06);
      setView(ed.draft.t0 / 60 - pad, ed.draft.t1 / 60 + pad);
    }, sig);
    if ($('wkZBox')) $('wkZBox').addEventListener('click', () => { ed.mode = ed.mode === 'zoomBox' ? 'pan' : 'zoomBox'; syncButtons(); }, sig);
    if ($('wkAddPause')) $('wkAddPause').addEventListener('click', () => { ed.mode = ed.mode === 'addPause' ? 'pan' : 'addPause'; syncButtons(); }, sig);
    if ($('wkSegSave')) $('wkSegSave').addEventListener('click', () => commitEditorDraft(ed), sig);
    if ($('wkSegCancel')) $('wkSegCancel').addEventListener('click', () => openDetail(ed.w.id, { keepScroll: true }), sig);
    if ($('wkSegReset')) $('wkSegReset').addEventListener('click', () => resetEditorToAuto(ed), sig);

    // Canvas pointer & wheel interactions
    canvas.draggable = false;
    canvas.setAttribute('draggable', 'false');
    canvas.addEventListener('dragstart', (e) => e.preventDefault(), sig);
    canvas.addEventListener('selectstart', (e) => e.preventDefault(), sig);
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); }, sig);
    const suspendChartEvents = (on) => {
      if (on) {
        if (ed.origChartEvents === undefined) ed.origChartEvents = chart.options.events;
        chart.options.events = [];
        chart.options.plugins.tooltip.enabled = false;
        if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      } else {
        if (ed.origChartEvents !== undefined) { chart.options.events = ed.origChartEvents; ed.origChartEvents = undefined; }
        chart.options.plugins.tooltip.enabled = true;
      }
    };
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect(), ca = chart.chartArea;
      if (!ca) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey && !e.metaKey) {
        const shift = e.deltaX / Math.max(1, ca.width) * (ed.viewMax - ed.viewMin);
        setView(ed.viewMin + shift, ed.viewMax + shift);
      } else {
        const px = e.clientX - rect.left;
        const frac = Math.max(0, Math.min(1, (px - ca.left) / Math.max(1, ca.width)));
        zoomFactor(e.deltaY > 0 ? 1.25 : 0.8, frac);
      }
    }, { passive: false, signal: ac.signal });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // preventDefault stops Yandex superdrag / smart-scroll from stealing the gesture
      e.preventDefault();
      const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
      ed.pts.set(e.pointerId, { x: px, y: py });
      if (ed.pts.size === 2) {
        const vs = [...ed.pts.values()], ca = chart.chartArea;
        ed.pinch = { d: Math.max(10, Math.hypot(vs[0].x - vs[1].x, vs[0].y - vs[1].y)), viewMin0: ed.viewMin, viewMax0: ed.viewMax,
          midFrac: ca ? Math.max(0, Math.min(1, ((vs[0].x + vs[1].x) / 2 - ca.left) / Math.max(1, ca.width))) : 0.5 };
        ed.drag = null; return;
      }
      if (ed.pts.size > 2) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      const hit = hitTest(px, py);
      dbg(`down ${e.pointerType} b=${e.button} px=${px.toFixed(1)},${py.toFixed(1)} hit=${hit ? hit.type + (hit.idx != null ? '[' + hit.idx + ']' : '') : 'none'} mode=${ed.mode}`);
      if (hit && hit.type === 'pauseDel') {
        ed.draft.pauses.splice(hit.idx, 1);
        ed.draft.pausesTouched = true; ed.draft.dirty = true; ed.selectedPause = null;
        syncVisuals(); return;
      }
      if (hit) {
        ed.drag = { kind: 'marker', target: hit, startPx: px, py, pointerId: e.pointerId, moved: false, mouseFallback: false };
        ed.moveCount = 0;
        ed.suppressDblClick = true;
        if (hit.type === 'pauseStart' || hit.type === 'pauseEnd') ed.selectedPause = hit.idx;
        suspendChartEvents(true);
        paintChart(); return;
      }
      const ca = chart.chartArea;
      if (!ca || px < ca.left || px > ca.right || py < ca.top || py > ca.bottom) return;
      if (ed.canEdit && (ed.mode === 'addPause' || e.shiftKey)) {
        const s = clampSec(secAtPx(px), Math.ceil(ed.draft.t0), Math.floor(ed.draft.t1));
        ed.drag = { kind: 'addPause', t0: s, t1: s, mouseFallback: false };
        suspendChartEvents(true);
        chart.update('none'); return;
      }
      if (ed.mode === 'zoomBox' || e.ctrlKey || e.metaKey) {
        ed.drag = { kind: 'zoomBox', x0: px, x1: px, mouseFallback: false };
        suspendChartEvents(true);
        chart.update('none'); return;
      }
      ed.drag = { kind: 'pan', startPx: px, viewMin0: ed.viewMin, viewMax0: ed.viewMax, moved: false, downSec: secAtPx(px), mouseFallback: false };
      suspendChartEvents(true);
    }, sig);

    const onPtrMove = (e) => {
      if (e._ftEdMove) return; e._ftEdMove = true;
      if (ed.drag) e.preventDefault();
      const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (ed.pts.has(e.pointerId)) ed.pts.set(e.pointerId, { x: px, y: py });
      if (ed.pinch && ed.pts.size >= 2) {
        const vs = [...ed.pts.values()], d = Math.max(10, Math.hypot(vs[0].x - vs[1].x, vs[0].y - vs[1].y));
        const span0 = ed.pinch.viewMax0 - ed.pinch.viewMin0;
        const ns = Math.max(0.25, Math.min(ed.fullMax - ed.fullMin, span0 * ed.pinch.d / d));
        const anchor = ed.pinch.viewMin0 + span0 * ed.pinch.midFrac;
        setView(anchor - ns * ed.pinch.midFrac, anchor + ns * (1 - ed.pinch.midFrac));
        return;
      }
      const ca = chart.chartArea;
      if (ed.drag) {
        const d = ed.drag;
        if (d.kind === 'pan') {
          if (Math.abs(px - d.startPx) > 3) d.moved = true;
          if (d.moved && ca) {
            const shift = -(px - d.startPx) / Math.max(1, ca.width) * (d.viewMax0 - d.viewMin0);
            setView(d.viewMin0 + shift, d.viewMax0 + shift);
          }
          return;
        }
        if (d.kind === 'zoomBox') {
          d.x1 = Math.max(ca.left, Math.min(ca.right, px));
          chart.update('none'); return;
        }
        if (d.kind === 'addPause') {
          d.t1 = clampSec(secAtPx(px), Math.ceil(ed.draft.t0), Math.floor(ed.draft.t1));
          const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
          updateReadout(d.t1, `пауза ${fmtDur(a)}–${fmtDur(b)} (${b - a} с) ·`);
          chart.update('none'); return;
        }
        if (d.kind === 'marker') {
          d.py = py;
          if (Math.abs(px - d.startPx) > 2) { d.moved = true; ed.suppressDblClick = true; }
          const s = secAtPx(px), dur = Math.floor(ed.w.duration_s || ed.fullMax * 60);
          const t = d.target;
          if (t.type === 't0') {
            const clamped0 = s <= 0;
            ed.draft.t0 = clampSec(s, 0, Math.min(dur - 10, ed.draft.t1 - 10));
            ed.draft.t0Moved = true; ed.draft.runTouched = true; ed.draft.dirty = true;
            updateReadout(ed.draft.t0, 'старт', clamped0 ? '(начало записи)' : '');
            if (++ed.moveCount === 1 || ed.moveCount % 12 === 0) dbg(`move#${ed.moveCount} px=${px.toFixed(1)} s=${s} -> t0=${ed.draft.t0}`);
          } else if (t.type === 't1') {
            ed.draft.t1 = clampSec(s, ed.draft.t0 + 10, Math.max(ed.draft.t0 + 10, dur));
            ed.draft.t1Moved = true; ed.draft.runTouched = true; ed.draft.dirty = true;
            updateReadout(ed.draft.t1, 'финиш');
          } else if (t.type === 'pauseStart') {
            const p = ed.draft.pauses[t.idx];
            if (p) {
              p[0] = clampSec(s, Math.ceil(ed.draft.t0), p[1] - 1);
              ed.draft.pausesTouched = true; ed.draft.dirty = true;
              updateReadout(p[0], 'пауза нач.');
            }
          } else if (t.type === 'pauseEnd') {
            const p = ed.draft.pauses[t.idx];
            if (p) {
              p[1] = clampSec(s, p[0] + 1, Math.floor(ed.draft.t1));
              ed.draft.pausesTouched = true; ed.draft.dirty = true;
              updateReadout(p[1], 'пауза кон.');
            }
          }
          paintChart(); return;
        }
      }
      // hover
      const hit = hitTest(px, py);
      const prevH = ed.hover;
      ed.hover = hit;
      if (ca && px >= ca.left && px <= ca.right && py >= ca.top && py <= ca.bottom) {
        const s = secAtPx(px); ed.hoverSec = s;
        updateReadout(s, '');
      } else { ed.hoverSec = null; updateReadout(null); }
      canvas.style.cursor = hit ? (hit.type === 'pauseDel' ? 'pointer' : 'ew-resize') : (ed.mode === 'addPause' || ed.mode === 'zoomBox' ? 'crosshair' : 'grab');
      if (JSON.stringify(prevH) !== JSON.stringify(hit)) chart.update('none');
    };
    canvas.addEventListener('pointermove', onPtrMove, sig);

    const endPtr = (e) => {
      if (e.pointerId != null) ed.pts.delete(e.pointerId);
      if (ed.pts.size < 2) ed.pinch = null;
      const d = ed.drag;
      if (!d) return;
      const beforeDbg = `t0=${ed.draft.t0},t1=${ed.draft.t1},p=${JSON.stringify(ed.draft.pauses)}`;
      ed.drag = null;
      suspendChartEvents(false);
      if (d.kind === 'pan' && !d.moved && ed.canEdit) {
        const idx = ed.draft.pauses.findIndex(([a, b]) => d.downSec >= a && d.downSec <= b);
        ed.selectedPause = idx >= 0 ? (ed.selectedPause === idx ? null : idx) : null;
        dbg(`up pan-click downSec=${d.downSec}`);
        syncVisuals(); return;
      }
      if (d.kind === 'zoomBox') {
        ed.mode = 'pan';
        if (Math.abs(d.x1 - d.x0) >= 12) {
          const xs = chart.scales.x;
          const v0 = xs.getValueForPixel(Math.min(d.x0, d.x1)), v1 = xs.getValueForPixel(Math.max(d.x0, d.x1));
          setView(v0, v1);
        } else { chart.update('none'); syncButtons(); }
        return;
      }
      if (d.kind === 'addPause') {
        ed.mode = 'pan';
        const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
        if (b - a >= 2) {
          ed.draft.pauses = A.applyPauseOverride(ed.draft.pauses.concat([[a, b]]), ed.draft.t0, ed.draft.t1);
          ed.draft.pausesTouched = true; ed.draft.dirty = true;
          ed.selectedPause = ed.draft.pauses.findIndex(([x, y]) => x <= a && y >= b);
          dbg(`up addPause ${a}-${b}`);
          syncVisuals();
        } else { chart.update('none'); syncButtons(); }
        return;
      }
      if (d.kind === 'marker' || (d.kind === 'pan' && d.moved)) {
        ed.suppressDblClick = true;
        clearTimeout(ed.suppressT);
        ed.suppressT = setTimeout(() => { ed.suppressDblClick = false; }, 450);
      }
      if (d.kind === 'marker') {
        // Freeze the pause list as manual and only clip/drop against [t0, t1]; never re-run auto pause detection on drag
        ed.draft.pausesTouched = true;
        ed.draft.pauses = A.applyPauseOverride(ed.draft.pauses, ed.draft.t0, ed.draft.t1);
        dbg(`up marker(${d.target.type}) before=[${beforeDbg}] after=[t0=${ed.draft.t0},t1=${ed.draft.t1},p=${JSON.stringify(ed.draft.pauses)}]`);
        syncVisuals();
      }
    };
    canvas.addEventListener('pointerup', endPtr, sig);
    // Keep drag alive across pointercancel / lostpointercapture and fall back to window mouse events if browser cancels the pointer stream
    canvas.addEventListener('pointercancel', (e) => {
      dbg(`pointercancel drag=${ed.drag ? ed.drag.kind : 'none'}`);
      if (ed.drag) { ed.drag.mouseFallback = true; try { canvas.setPointerCapture(e.pointerId); } catch (_) {} return; }
      endPtr(e);
    }, sig);
    canvas.addEventListener('lostpointercapture', (e) => {
      dbg(`lostpointercapture drag=${ed.drag ? ed.drag.kind : 'none'}`);
      if (ed.drag) { ed.drag.mouseFallback = true; try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
    }, sig);
    canvas.addEventListener('pointerleave', () => {
      if (!ed.drag) { ed.hover = null; ed.hoverSec = null; updateReadout(null); chart.update('none'); }
    }, sig);
    window.addEventListener('pointermove', (e) => { if (ed.drag) onPtrMove(e); }, sig);
    window.addEventListener('pointerup', (e) => { if (ed.drag) endPtr(e); }, sig);
    window.addEventListener('mousemove', (e) => { if (ed.drag && ed.drag.mouseFallback) onPtrMove(e); }, sig);
    window.addEventListener('mouseup', (e) => { if (ed.drag && ed.drag.mouseFallback) endPtr(e); }, sig);

    canvas.addEventListener('dblclick', (e) => {
      dbg(`dblclick suppressed=${!!ed.suppressDblClick} mode=${ed.mode} shift=${!!e.shiftKey}`);
      if (!ed.canEdit) return;
      if (ed.suppressDblClick) { ed.suppressDblClick = false; return; }
      // Plain dblclick was stealing start-marker drags (a second click after a failed grab).
      // Only add a 10 s pause with Shift or while «+ Пауза» is armed.
      if (ed.mode !== 'addPause' && !e.shiftKey) return;
      const rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top, ca = chart.chartArea;
      if (!ca || px < ca.left || px > ca.right || py < ca.top || py > ca.bottom) return;
      if (hitTest(px, py)) return;
      const s = secAtPx(px);
      if (s < ed.draft.t0 || s > ed.draft.t1) return;
      if (ed.draft.pauses.some(([a, b]) => s >= a && s <= b)) return;
      const lo = Math.ceil(ed.draft.t0), hi = Math.floor(ed.draft.t1);
      if (hi - lo < 2) return;
      const a = Math.max(lo, Math.min(hi - 2, s - 5)), b = Math.min(hi, a + 10);
      if (b - a < 2) return;
      ed.draft.pauses = A.applyPauseOverride(ed.draft.pauses.concat([[a, b]]), ed.draft.t0, ed.draft.t1);
      ed.draft.pausesTouched = true; ed.draft.dirty = true;
      ed.selectedPause = ed.draft.pauses.findIndex(([x, y]) => x <= a && y >= b);
      syncVisuals();
    }, sig);

    document.addEventListener('keydown', (e) => {
      if ($('wkDetail').classList.contains('hidden')) return;
      if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ed.selectedPause != null && ed.draft.pauses[ed.selectedPause]) {
        e.preventDefault();
        ed.draft.pauses.splice(ed.selectedPause, 1);
        ed.draft.pausesTouched = true; ed.draft.dirty = true; ed.selectedPause = null;
        syncVisuals();
      } else if (e.key === 'Escape' && ed.mode !== 'pan') {
        ed.mode = 'pan'; syncButtons();
      }
    }, sig);

    syncVisuals();
  }

  async function commitEditorDraft(ed) {
    if (!ed || ed.saving) return;
    ed.saving = true;
    const stEl = $('wkSegStatus'); if (stEl) stEl.textContent = 'Сохраняю…';
    ed.syncButtons();
    const w = ed.w, nw = Object.assign({}, w);
    if (ed.draft.runTouched) {
      const curOv = Array.isArray(w.run_override) ? w.run_override : [null, null];
      nw.run_override = [ed.draft.t0Moved ? ed.draft.t0 : curOv[0], ed.draft.t1Moved ? ed.draft.t1 : curOv[1]];
    }
    if (ed.draft.pausesTouched) {
      const r0 = nw.run_override && nw.run_override[0] != null ? nw.run_override[0] : ed.draft.t0;
      const r1 = nw.run_override && nw.run_override[1] != null ? nw.run_override[1] : ed.draft.t1;
      nw.pause_override = A.applyPauseOverride(ed.draft.pauses, r0, r1);
    }
    Object.assign(nw, derived(nw));
    Store.putWorkout(nw);
    const syncRes = await Sync.run();
    renderList();
    await openDetail(w.id, { keepScroll: true });
    const st2 = $('wkSegStatus');
    if (st2) st2.textContent = syncRes === 'ok' ? 'Сохранено на сервер' : 'Сохранено локально (отправится при связи)';
  }

  async function resetEditorToAuto(ed) {
    if (!ed || ed.saving) return;
    ed.saving = true;
    const stEl = $('wkSegStatus'); if (stEl) stEl.textContent = 'Возвращаю авто…';
    ed.syncButtons();
    await applyOverride(ed.w, null, { resetPauses: true, keepScroll: true });
    const st2 = $('wkSegStatus');
    if (st2) st2.textContent = 'Возвращено автоопределение';
  }

  // manual correction: on native, ± buttons save immediately; on web, they nudge the editor draft (or save if no HR chart)
  function renderSegControls(w, seg) {
    const el = $('wkSegCtl'); if (!el) return;
    if (!seg || seg.src === 'whole' || w.type !== 'run') { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const ed = !isNative && wkEditor && wkEditor.w.id === w.id ? wkEditor : null;
    const btn = (k, d) => `<button class="btn seg-adj" data-k="${k}" data-d="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)} с</button>`;
    const hasOv = !!(w.run_override || Array.isArray(w.pause_override));
    const stopSum = (seg.pauses || []).reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
    const webActions = ed && ed.draft.dirty
      ? '<div class="seg-row"><button class="btn primary seg-save-top">Сохранить</button><button class="btn seg-cancel-top">Отменить</button>' + (hasOv ? '<button class="btn seg-reset">Вернуть автоопределение</button>' : '') + '</div>'
      : (hasOv ? '<div class="seg-row"><button class="btn seg-reset">Вернуть автоопределение</button></div>' : '');
    el.innerHTML = `<div class="small"><b>Границы бега</b> — ${ed ? 'перетащи маркеры на графике пульса или поправь кнопками (после нажатия «Сохранить» всё пересчитается):' : 'если найдены неточно, подвинь (всё пересчитается: темп, дистанция, каденс, пульс, восстановление):'}</div>` +
      `<div class="seg-row">Старт бега: <b>${fmtDur(seg.t0)}</b> ${[-30, -5, 5, 30].map((d) => btn(0, d)).join('')}</div>` +
      `<div class="seg-row">Финиш бега: <b>${fmtDur(seg.t1)}</b> ${[-30, -5, 5, 30].map((d) => btn(1, d)).join('')}</div>` +
      (ed ? `<div class="seg-row small muted">В движении ≈ <b>${fmtDur(Math.max(0, seg.t1 - seg.t0 - stopSum))}</b> · пауз: <b>${(seg.pauses || []).length}</b> (${fmtDur(stopSum)})</div>` : '') +
      webActions;
    el.querySelectorAll('.seg-adj').forEach((b) => b.addEventListener('click', () => adjustRun(w, +b.dataset.k, +b.dataset.d)));
    const sv = el.querySelector('.seg-save-top'); if (sv && ed) sv.addEventListener('click', () => commitEditorDraft(ed));
    const cn = el.querySelector('.seg-cancel-top'); if (cn && ed) cn.addEventListener('click', () => openDetail(w.id, { keepScroll: true }));
    const r = el.querySelector('.seg-reset'); if (r) r.addEventListener('click', () => ed ? resetEditorToAuto(ed) : applyOverride(w, null, { resetPauses: true }));
  }
  function adjustRun(w, k, d) {
    const ed = !isNative && wkEditor && wkEditor.w.id === w.id ? wkEditor : null;
    if (ed) {
      const dur = Math.floor(w.duration_s || ed.fullMax * 60);
      if (k === 0) {
        const v = Math.max(0, Math.min(ed.draft.t1 - 10, Math.round(ed.draft.t0 + d)));
        ed.draft.t0 = v; ed.draft.t0Moved = true;
      } else {
        const v = Math.min(dur, Math.max(ed.draft.t0 + 10, Math.round(ed.draft.t1 + d)));
        ed.draft.t1 = v; ed.draft.t1Moved = true;
      }
      ed.draft.runTouched = true; ed.draft.pausesTouched = true; ed.draft.dirty = true;
      ed.draft.pauses = A.applyPauseOverride(ed.draft.pauses, ed.draft.t0, ed.draft.t1);
      ed.syncVisuals();
      return;
    }
    const cur = (w.seg && [w.seg.t0, w.seg.t1]) || [0, w.duration_s];
    const ov = (w.run_override || [null, null]).slice();
    ov[k] = Math.max(0, Math.min(w.duration_s, Math.round((cur[k] + d) * 10) / 10));
    if (ov[1] != null && ov[0] != null && ov[1] < ov[0] + 10) return;
    applyOverride(w, [ov[0] != null ? ov[0] : cur[0], ov[1] != null ? ov[1] : cur[1]]);
  }
  async function applyOverride(w, ov, opts) {
    const nw = Object.assign({}, w, { run_override: ov });
    if (!ov) delete nw.run_override;
    if (opts && opts.resetPauses) delete nw.pause_override;
    Object.assign(nw, derived(nw));
    if (!ov) nw.run_override = null;
    if (opts && opts.resetPauses) nw.pause_override = null;
    Store.putWorkout(nw);
    if (!isNative) await Sync.run();
    renderList();
    await openDetail(w.id, { keepScroll: !!(opts && opts.keepScroll) });
  }

  // ---------------- pace / cadence profiles, map ----------------
  let speedChart = null, cadChart = null, map = null, leafletP = null;
  function drawProfiles(w, an) {
    if (!window.Chart) return;
    const segs = an.segments && an.segments.length ? an.segments : (w.segments || []);
    let cum = 0; const byStep = [], byGps = [];
    for (const sg of segs) {
      const [t0, t1, n, dm, gm, mv] = sg;
      cum += dm;
      const x = cum / 1000;
      const ps = A.paceSec(dm, mv);
      if (ps != null) byStep.push({ x, y: ps });
      if (gm != null) { const pg = A.paceSec(gm, mv); if (pg != null) byGps.push({ x, y: pg }); }
    }
    const axis = A.paceAxisRange(byStep.concat(byGps).map((p) => p.y));
    if (speedChart) speedChart.destroy();
    speedChart = new Chart($('wkSpeedChart'), {
      type: 'line',
      data: { datasets: [
        { label: 'по шагам', data: byStep, borderColor: '#3fa7ff', backgroundColor: '#3fa7ff', pointRadius: 2, borderWidth: 2, stepped: 'before' },
        { label: 'по GPS', data: byGps, borderColor: '#39d353', backgroundColor: '#39d353', pointRadius: 2, borderWidth: 2, stepped: 'before' },
      ] },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtDur(c.parsed.y)} /км` } } },
        scales: { x: { type: 'linear', min: 0, title: { display: true, text: 'км' } },
          y: { reverse: true, min: axis.min, max: axis.max, title: { display: true, text: 'м:сс /км' },
            ticks: { callback: (v) => fmtDur(v) } } } },
    });
    if (cadChart) cadChart.destroy();
    cadChart = new Chart($('wkCadChart'), {
      type: 'line',
      data: { datasets: [{ label: 'каденс', data: an.cadence.map(([t, c]) => ({ x: t / 60, y: c })), borderColor: '#ffb020', backgroundColor: 'rgba(255,176,32,.15)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.2 }] },
      options: { maintainAspectRatio: false, animation: false, parsing: false, plugins: { legend: { display: false } },
        scales: { x: { type: 'linear', title: { display: true, text: 'минуты' } }, y: { title: { display: true, text: 'шаг/мин' }, suggestedMin: 0 } } },
    });
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise((res, rej) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css'; document.head.appendChild(css);
      const sc = document.createElement('script'); sc.src = 'vendor/leaflet/leaflet.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc);
    });
    return leafletP;
  }
  async function drawMap(track) {
    const pts = track.filter((p) => p[3] <= 30).map((p) => [p[1], p[2]]);
    $('wkMapWrap').classList.toggle('hidden', pts.length < 2);
    if (pts.length < 2) return;
    try { await loadLeaflet(); } catch (e) { $('wkMapWrap').classList.add('hidden'); return; }
    if (map) { map.remove(); map = null; }
    map = L.map('wkMap', { attributionControl: true, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    const line = L.polyline(pts, { color: '#ff4d4d', weight: 4 }).addTo(map);
    L.circleMarker(pts[0], { radius: 6, color: '#39d353', fillOpacity: 1 }).addTo(map);
    L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#ff4d4d', fillOpacity: 1 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [16, 16] });
    window.__wkMap = map;
  }

  // ---------------- GPS stride calibration ----------------
  let calibAt = 0;
  async function refreshCalibration(force) {
    if (!force && Date.now() - calibAt < 30 * 60 * 1000) { renderCalib(); return; }
    try {
      const c = await api('api/stats/calibration');
      calibAt = Date.now();
      Store.setConfig({ calib: { run: c.run, walk: c.walk, at: Date.now() } });
    } catch (e) { /* offline: keep cached */ }
    renderCalib(); renderRec();
  }
  function renderCalib() {
    const el = $('calibPanel'); if (!el) return;
    const c = cfg(), cal = c.calib || {}, mode = c.strideMode || 'auto';
    if ($('strideMode')) $('strideMode').value = mode;
    const row = (t, name) => {
      const x = cal[t];
      if (!x || !x.stride_m) return `<div>${name}: калибровки пока нет — нужна пробежка с хорошим GPS (от 0,8 км и 500 шагов).</div>`;
      return `<div>${name}: шаг по GPS <b>${x.stride_m.toFixed(2)} м</b> по ${x.n} ${x.n === 1 ? 'тренировке' : 'тренировкам'}` +
        (x.spread_m ? ` (разброс ±${x.spread_m.toFixed(2)})` : '') + (mode === 'manual' ? ` <button class="btn calib-apply" data-v="${x.stride_m}">Применить вручную</button>` : '') + '</div>';
    };
    const used = strideFor(wkType);
    let html = row('run', 'Бег') + row('walk', 'Ходьба') + `<div class="muted">Сейчас для «${TYPES[wkType]}» используется ${used.v.toFixed(2)} м (${used.src === 'auto' ? 'калибровка' : 'вручную'}).</div>`;
    const runs = [].concat((cal.run && cal.run.runs) || [], (cal.walk && cal.walk.runs) || []).sort((a, b) => b.started_at - a.started_at).slice(0, 12);
    if (runs.length) {
      html += '<table class="calib-table"><tr><th>Дата</th><th>GPS, км</th><th>Шаги</th><th>Шаг, м</th><th></th></tr>' + runs.map((r) =>
        `<tr class="${r.used ? '' : 'bad'}"><td>${r.date}</td><td>${(r.gps_distance_m / 1000).toFixed(2)}</td><td>${r.steps}</td><td>${r.stride_m ? r.stride_m.toFixed(2) : '—'}</td><td>${r.used ? '✔ в расчёте' : (r.reason || '')}</td></tr>`).join('') + '</table>';
    }
    el.innerHTML = html;
    el.querySelectorAll('.calib-apply').forEach((b) => b.addEventListener('click', () => { Store.setConfig({ stride: parseFloat(b.dataset.v) }); if ($('strideInput')) $('strideInput').value = b.dataset.v; renderCalib(); renderRec(); }));
  }

  // ---------------- wiring ----------------
  function onShow() {
    renderHr(); renderRec(); renderList();
    const saved = cfg().hrDevice;
    if (isNative && saved && !hr.connected && !hr.connecting && BLE && !(active && active.native) && !(svc && svc.running)) { hr.name = saved.name; connect(saved.id, saved.name); }
    renderBattery();
  }

  if ($('hrMonStart')) {
    $('hrMonStart').addEventListener('click', async () => {
      const d = cfg().hrDevice; if (!d) return msg('hrMsg', 'Сначала найди пульсометр');
      hr.id = d.id; hr.name = d.name; startMonitor();
    });
    $('hrMonStop').addEventListener('click', () => { if (confirm('Завершить мониторинг пульса? Записанное восстановление сохранится.')) endMonitor(); });
    const am = $('hrAutoMon'); am.checked = cfg().autoMonitor !== false; am.addEventListener('change', () => Store.setConfig({ autoMonitor: am.checked }));
    const pm = $('hrPostMin'); pm.value = String(postMin()); pm.addEventListener('change', () => Store.setConfig({ postMin: parseInt(pm.value, 10) }));
    setInterval(() => { if (svc && svc.running && !document.hidden) renderSession(); }, 5000);
  }
  if ($('hrPick')) {
    $('hrPick').addEventListener('click', () => pick(false));
    $('hrPickAll').addEventListener('click', () => pick(true));
    $('hrDisconnect').addEventListener('click', disconnect);
    $('wkStart').addEventListener('click', start);
    $('wkStop').addEventListener('click', stop);
    document.querySelectorAll('#wkTypeSeg button').forEach((b) => b.addEventListener('click', () => { if (!active) { wkType = b.dataset.type; syncAddLabel(); renderRec(); } }));
    $('wkDetailClose').addEventListener('click', () => { destroyChartEditor(); $('wkDetail').classList.add('hidden'); });
    $('wkDelete').addEventListener('click', () => { if (detailId && confirm('Удалить тренировку?')) { Store.deleteWorkout(detailId); $('wkDetail').classList.add('hidden'); renderList(); } });
    const si = $('strideInput');
    if (si) { si.value = manualStride(); si.addEventListener('change', () => { const v = parseFloat(String(si.value).replace(',', '.')); if (v >= 0.3 && v <= 2) Store.setConfig({ stride: v }); renderRec(); }); }
  }
  // v1.5.2: recompute derived analytics of workouts saved by older versions (raw data stays as recorded)
  let upgrading = false, upgradeDone = false;
  async function upgradeWorkouts() {
    if (upgrading || upgradeDone) return; upgrading = true;
    try {
      const todo = Object.values(Store.workouts()).filter((w) => !w.deleted && (w.analysis_v || 0) < A.ANALYSIS_V).sort((a, b) => a.started_at - b.started_at);
      for (const w0 of todo) {
        let w = w0;
        const need = w.samples_trimmed || !(w.samples && w.samples.length) || (w.session_samples && w.session_samples.length && !(w.session_rr && w.session_rr.length));
        if (need) { try { const full = await api('api/workouts/' + w.id); if (full && full.id) w = Object.assign({}, w0, full); } catch (e) { return; } }
        if (!(w.samples && w.samples.length) && !(w.step_series && w.step_series.length)) continue;
        const cur = Store.workouts()[w.id]; if (!cur || cur.updated_at !== w0.updated_at) continue;   // edited meanwhile
        Store.putWorkout(Object.assign({}, w, derived(w)));
      }
      upgradeDone = true;
    } finally { upgrading = false; }
  }
  Sync.on((s) => { if (s.state === 'ok') { renderList(); refreshCalibration(false); if (!upgradeDone) setTimeout(upgradeWorkouts, 300); } });
  if ($('strideMode')) $('strideMode').addEventListener('change', () => { Store.setConfig({ strideMode: $('strideMode').value }); renderCalib(); renderRec(); });
  if ($('wkGps')) $('wkGps').checked = cfg().wkGps !== false;
  renderCalib();

  // resume: background service (native) or a JS-only recording interrupted by the app being closed
  if (isNative && WR) { adoptNative(); }
  // HR session ended on its own (strap taken off, no data for ~3 min): save + sync recovery right away, even in background
  if (isNative && WR && WR.addListener) {
    WR.addListener('sessionFinished', async () => {
      try {
        await collectFinished();
        if (!(active && active.native)) { svc = null; stopPolling(); hr.connected = false; hr.bpm = null; renderHr(); renderLive(); }
        renderSession();
        Sync.run();
      } catch (e) { /* next launch picks it up */ }
    });
  }
  else if (active && isNative) { afterStart(); }
  // ---------- v1.8: voice announcements (settings; the service does the talking) ----------
  async function initVoicePanel() {
    if (!$('voicePanel') || !WR || !WR.voiceInfo) return;
    const ids = { enabled: 'voiceOn', events: 'voiceEvents', hr: 'voiceHr', summary: 'voiceSummary', distance: 'voiceDistance' };
    const show = (i) => {
      for (const k of Object.keys(ids)) $(ids[k]).checked = i[k] !== false;
      $('voiceCats').classList.toggle('disabled', i.enabled === false);
      const ok = i.status === 'ok', err = i.status && i.status.startsWith('error');
      $('voiceInfo').textContent = err ? 'Голос недоступен: ' + i.status.slice(6)
        : ok ? `Движок: ${i.engine || '—'} · голос: ${i.voice || '—'}${i.gender === 'female' ? ' (женский)' : ''}` : 'Голос загружается…';
    };
    const save = async () => {
      const o = {}; for (const k of Object.keys(ids)) o[k] = $(ids[k]).checked;
      try { show(await WR.setVoice(o)); } catch (e) { /* ignore */ }
    };
    Object.values(ids).forEach((id) => $(id).addEventListener('change', save));
    $('voiceTest').addEventListener('click', async () => {
      $('voiceInfo').textContent = 'Говорю…';
      try { show(await WR.voiceTest()); } catch (e) { $('voiceInfo').textContent = 'Не получилось: ' + (e && e.message || e); return; }
      setTimeout(async () => { try { show(await WR.voiceInfo()); } catch (e) { /* ignore */ } }, 2500);
    });
    try { show(await WR.voiceInfo()); setTimeout(async () => { try { show(await WR.voiceInfo()); } catch (e) { /* ignore */ } }, 2500); } catch (e) { $('voicePanel').classList.add('hidden'); }
  }
  initVoicePanel();

  if ($('batOpt') && WR) {
    $('batOpt').addEventListener('click', async () => { await WR.requestIgnoreBatteryOptimizations().catch(() => {}); setTimeout(renderBattery, 1500); });
    $('batMiui').addEventListener('click', () => WR.openAutostartSettings().catch(() => {}));
    $('batApp').addEventListener('click', () => WR.openAppDetails().catch(() => {}));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderBattery(); if (active && active.native) poll(); } });

  // beltless run: the phone-accelerometer profile (server) joins the workout record; run start / pauses are re-derived with it
  const motionTried = new Set();
  async function attachMotion(wid, motion) {
    if (motionTried.has(wid)) return; motionTried.add(wid);
    try {
      let w = Store.workouts()[wid]; if (!w) return;
      if (!motion) { const a = await api('api/workouts/' + wid + '/dynamics'); motion = a && a.result && a.result.motion; }
      if (!motion || !motion.length) return;
      const full = await api('api/workouts/' + wid);
      w = Object.assign({}, w, full && full.id ? full : {}, { motion });
      Store.putWorkout(Object.assign({}, w, derived(w)));
      renderList(); if (detailId === wid && !$('wkDetail').classList.contains('hidden')) openDetail(wid);
    } catch (e) { /* next time */ }
  }
  window.FTWorkout = { onShow, markSeg, attachMotion, isRecording: () => !!active, refreshCalibration, startMonitor, _svc: () => svc, _onHr: onHr, _hr: hr };
})();
