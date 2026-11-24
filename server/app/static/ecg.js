/* ECG (Polar H10 raw ECG via the PMD service): on-demand recording, storage/sync, zoomable viewer with R peaks. */
(function () {
  'use strict';
  const { api, Store, isNative } = window.FT;
  const A = window.FTAnalysis;
  const $ = (id) => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const WR = isNative && P.WorkoutRecorder && typeof P.WorkoutRecorder.getEcg === 'function' ? P.WorkoutRecorder : null;
  const K_PEND = 'ft.ecg.pending', K_LIST = 'ft.ecg.list';
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } };
  const when = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtS = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const PHASE = { pre: 'до тренировки', workout: 'во время', post: 'после', null: '' };

  // ---------- encoding ----------
  function decode(b64) {
    const bin = atob(b64), n = bin.length >> 1, out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); out[i] = v > 32767 ? v - 65536 : v; }
    return out;
  }
  function enrich(rec) {   // R peaks + stats (computed once on the device that recorded it)
    const x = decode(rec.samples_b64), fs = rec.fs || 130;
    const peaks = A.rPeaks(x, fs), st = A.ecgStats(peaks, fs);
    return Object.assign(rec, { n: x.length, r_peaks: peaks, hr_avg: st.hr_avg, rmssd: st.rmssd, sdnn: st.sdnn, updated_at: Date.now() });
  }

  // ---------- storage / sync ----------
  async function upload() {
    const pend = load(K_PEND, []); if (!pend.length) return;
    const left = [];
    for (const r of pend) {
      try { await api('api/ecg/' + r.id, { method: 'PUT', body: r }); }
      catch (e) { left.push(r); if (!e.status) { left.push(...pend.slice(pend.indexOf(r) + 1)); break; } }
    }
    save(K_PEND, left.filter((r, i, a) => a.findIndex((o) => o.id === r.id) === i));
  }
  async function list() {
    const pend = load(K_PEND, []);
    let remote = null;
    try { remote = await api('api/ecg?limit=200'); save(K_LIST, remote); } catch (e) { remote = load(K_LIST, []); }
    const byId = new Map(remote.map((r) => [r.id, r]));
    for (const r of pend) { const m = Object.assign({}, r); delete m.samples_b64; m.pending = true; byId.set(r.id, m); }
    return [...byId.values()].filter((r) => !r.deleted).sort((a, b) => b.started_at - a.started_at);
  }
  const cache = {};
  async function full(id) {
    if (cache[id]) return cache[id];
    const p = load(K_PEND, []).find((r) => r.id === id);
    const r = p || await api('api/ecg/' + id);
    cache[id] = Object.assign({}, r, { x: decode(r.samples_b64) });
    if (!cache[id].r_peaks || !cache[id].r_peaks.length) cache[id].r_peaks = A.rPeaks(cache[id].x, r.fs || 130);
    return cache[id];
  }

  // ---------- recording ----------
  let poll = null, live = [], liveSince = 0, recState = null;
  async function startRec() {
    if (!WR) return;
    const sec = parseInt($('ecgDur').value, 10) || 60;
    state('Подключаюсь…');
    try {
      let st = await WR.getState({ since: 1e9, sinceSteps: 1e9, sinceTrack: 1e9, sinceSess: 1e9, sinceRr: 1e9 });
      if (!st.running && window.FTWorkout && window.FTWorkout.startMonitor) {
        await window.FTWorkout.startMonitor();
        for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); st = await WR.getState({ since: 1e9, sinceSteps: 1e9, sinceTrack: 1e9, sinceSess: 1e9, sinceRr: 1e9 }); if (st.running && st.hrStatus === 'connected' && st.ecgCapable) break; }
      }
      if (!st.running) { state('Сначала подключи пояс на вкладке «Тренировка».'); return; }
      await new Promise((r) => setTimeout(r, 300));
      await WR.startEcg({ seconds: sec });
    } catch (e) { state('Не удалось начать: ' + (e.message || e)); return; }
    live = []; liveSince = 0; recState = { target: sec };
    $('ecgStart').classList.add('hidden'); $('ecgStop').classList.remove('hidden'); $('ecgLiveBox').classList.remove('hidden');
    clearInterval(poll); poll = setInterval(tick, 1000); tick();
  }
  async function stopRec() { if (WR) await WR.stopEcg({ save: true }).catch(() => {}); setTimeout(tick, 400); }
  function state(t) { $('ecgState').textContent = t || ''; }
  async function tick() {
    let r;
    try { r = await WR.getEcg({ since: liveSince }); } catch (e) { return; }
    if (Array.isArray(r.samples) && r.since === liveSince) { live.push(...r.samples); liveSince += r.samples.length; if (live.length > 130 * 6) live = live.slice(-130 * 6); }
    if (r.status === 'starting') state('Жду сигнал от пояса…');
    else if (r.status === 'recording') { state(`Запись ${fmtS(r.count / 130)} из ${fmtS(r.target / 130)}`); drawLive(); }
    else {
      clearInterval(poll); poll = null;
      $('ecgStart').classList.remove('hidden'); $('ecgStop').classList.add('hidden'); $('ecgLiveBox').classList.add('hidden');
      const err = r.status && r.status.startsWith('error:') ? r.status.slice(6) : '';
      const got = await collect();
      state(got ? `Сохранено: ${got.duration_s} с${got.hr_avg ? `, пульс ${Math.round(got.hr_avg)}` : ''}${got.rmssd ? `, RMSSD ${Math.round(got.rmssd)} мс` : ''}.` + (err ? ' ' + err : '') : (err || 'Запись остановлена.'));
      recState = null;
      if (got) { await refresh(); show(got.id); }
    }
  }
  async function collect() {
    if (!WR || !WR.takeEcgRecords) return null;
    let recs = [];
    try { recs = (await WR.takeEcgRecords()).records || []; } catch (e) { return null; }
    if (!recs.length) return null;
    const pend = load(K_PEND, []);
    for (const r of recs) pend.push(enrich(r));
    save(K_PEND, pend);
    upload().then(refresh).catch(() => {});
    return recs[recs.length - 1];
  }
  function drawLive() {
    const c = $('ecgLive'), { ctx, w, h } = fit(c);
    ctx.clearRect(0, 0, w, h); grid(ctx, w, h, 5, 0, 4000);
    const n = Math.min(live.length, 130 * 5); if (n < 2) return;
    const xs = live.slice(-n), med = xs.slice().sort((a, b) => a - b)[n >> 1];
    let amp = 0; for (const v of xs) amp = Math.max(amp, Math.abs(v - med)); amp = Math.max(amp * 1.15, 500);
    ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 1.4; ctx.beginPath();
    xs.forEach((v, i) => { const X = i / (130 * 5) * w, Y = h / 2 - (v - med) / amp * (h / 2); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.stroke();
  }

  // ---------- viewer ----------
  function fit(c) {
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  // ECG-paper style grid: 0.2 s / 0.5 mV major, 0.04 s / 0.1 mV minor (minor lines only when they are ≥ 4 px apart)
  function grid(ctx, w, h, winS, t0, spanUv) {
    const pxS = w / winS, pxUv = h / spanUv;
    const lines = (step, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      for (let t = Math.ceil(t0 / step) * step; t <= t0 + winS; t += step) { const X = Math.round((t - t0) * pxS) + 0.5; ctx.moveTo(X, 0); ctx.lineTo(X, h); }
      ctx.stroke();
    };
    const hl = (stepUv, color) => { ctx.strokeStyle = color; ctx.beginPath(); for (let u = 0; u <= spanUv / 2; u += stepUv) for (const s of [1, -1]) { const Y = Math.round(h / 2 - s * u * pxUv) + 0.5; ctx.moveTo(0, Y); ctx.lineTo(w, Y); } ctx.stroke(); };
    if (0.04 * pxS >= 4) lines(0.04, 'rgba(255,120,120,.10)');
    if (100 * pxUv >= 4) hl(100, 'rgba(255,120,120,.10)');
    lines(0.2 * pxS >= 6 ? 0.2 : 1, 'rgba(255,120,120,.25)'); hl(500, 'rgba(255,120,120,.25)');
  }
  let cur = null, view = { t0: 0, win: 10 };
  function draw() {
    if (!cur) return;
    const fs = cur.fs || 130, x = cur.x, T = x.length / fs, c = $('ecgCanvas'), { ctx, w, h } = fit(c);
    view.win = Math.min(view.win, T); view.t0 = Math.max(0, Math.min(view.t0, T - view.win));
    const i0 = Math.floor(view.t0 * fs), i1 = Math.min(x.length, Math.ceil((view.t0 + view.win) * fs) + 1);
    ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, w, h);
    const span = cur.span;   // µV across the height, fixed per record so zooming keeps the scale
    grid(ctx, w, h, view.win, view.t0, span);
    const X = (i) => (i / fs - view.t0) / view.win * w, Y = (v) => h / 2 - (v - cur.base[Math.min(cur.base.length - 1, Math.floor(i0 / fs))]) / span * h;
    ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = view.win <= 10 ? 1.5 : 1; ctx.beginPath();
    const step = Math.max(1, Math.floor((i1 - i0) / (w * 2)));
    for (let i = i0; i < i1; i += step) {
      const b = cur.base[Math.min(cur.base.length - 1, Math.floor(i / fs))];
      const yy = h / 2 - (x[i] - b) / span * h; i === i0 ? ctx.moveTo(X(i), yy) : ctx.lineTo(X(i), yy);
    }
    ctx.stroke();
    // R peaks and RR labels
    const pk = cur.r_peaks || [];
    ctx.font = '11px Arial'; ctx.textAlign = 'center';
    for (let k = 0; k < pk.length; k++) {
      const p = pk[k]; if (p < i0 || p >= i1) continue;
      const b = cur.base[Math.min(cur.base.length - 1, Math.floor(p / fs))], px = X(p), py = h / 2 - (x[p] - b) / span * h;
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(px, Math.max(6, Math.min(h - 6, py)), 3, 0, 6.3); ctx.fill();
      if (k > 0 && view.win <= 30) {
        const rr = Math.round((p - pk[k - 1]) * 1000 / fs), mx = (px + X(pk[k - 1])) / 2;
        ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(rr + ' мс', mx, 14);
      }
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#aaa';
    ctx.fillText(`${view.t0.toFixed(1)}–${(view.t0 + view.win).toFixed(1)} с  ·  сетка 0,2 с × 0,5 мВ`, 6, h - 6);
    drawOverview();
  }
  function drawOverview() {
    const c = $('ecgOverview'), { ctx, w, h } = fit(c), x = cur.x, fs = cur.fs || 130, T = x.length / fs;
    ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,107,107,.7)'; ctx.beginPath();
    const per = x.length / w;
    for (let px = 0; px < w; px++) {
      let lo = Infinity, hi = -Infinity; const a = Math.floor(px * per), bnd = Math.min(x.length, Math.floor((px + 1) * per) + 1);
      const b = cur.base[Math.min(cur.base.length - 1, Math.floor(a / fs))];
      for (let i = a; i < bnd; i++) { const v = x[i] - b; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) continue;
      ctx.moveTo(px + 0.5, h / 2 - hi / cur.span * h * 0.9); ctx.lineTo(px + 0.5, h / 2 - lo / cur.span * h * 0.9);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(63,167,255,.25)'; ctx.strokeStyle = '#3fa7ff';
    const x0 = view.t0 / T * w, ww = Math.max(3, view.win / T * w);
    ctx.fillRect(x0, 0, ww, h); ctx.strokeRect(x0 + 0.5, 0.5, ww - 1, h - 1);
  }
  async function show(id) {
    let r;
    try { r = await full(id); } catch (e) { $('ecgViewBox').classList.add('hidden'); return; }
    cur = r;
    const fs = r.fs || 130, x = r.x;
    // per-second baseline (median of a 2-s window) so baseline wander does not push the trace off-screen
    const nS = Math.ceil(x.length / fs), base = new Float64Array(nS);
    for (let s = 0; s < nS; s++) { const a = Math.max(0, (s - 1) * fs), b = Math.min(x.length, (s + 2) * fs); const xs = Array.from(x.subarray(a, b)).sort((p, q) => p - q); base[s] = xs[xs.length >> 1] || 0; }
    for (let s = 1; s < nS - 1; s++) base[s] = (base[s - 1] + 2 * base[s] + base[s + 1]) / 4;
    r.base = base;
    const amps = (r.r_peaks || []).map((p) => Math.abs(x[p] - base[Math.min(nS - 1, Math.floor(p / fs))])).sort((a, b) => a - b);
    const typ = amps.length ? amps[amps.length >> 1] : 1500;
    r.span = Math.max(1500, Math.ceil(typ * 2.6 / 500) * 500);
    view = { t0: 0, win: view.win || 10 };
    const st = A.ecgStats(r.r_peaks || [], fs);
    $('ecgViewTitle').textContent = `${when(r.started_at)} · ${Math.round(r.duration_s || x.length / fs)} с${r.device ? ' · ' + r.device : ''}${r.phase ? ' · ' + (PHASE[r.phase] || '') : ''}`;
    const m = (v, k) => `<div><b>${v == null ? '—' : v}</b>${k}</div>`;
    $('ecgStats').innerHTML = m(st.hr_avg != null ? Math.round(st.hr_avg) : null, 'средний пульс') + m(st.beats, 'R-зубцов') +
      m(st.rmssd != null ? Math.round(st.rmssd) + ' мс' : null, 'RMSSD') + m(st.sdnn != null ? Math.round(st.sdnn) + ' мс' : null, 'SDNN') +
      m(st.artifacts_pct != null ? st.artifacts_pct + '%' : null, 'неровных RR');
    $('ecgViewBox').classList.remove('hidden');
    $('ecgDelete').dataset.id = id;
    document.querySelectorAll('#ecgList tr[data-id]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === id));
    draw();
  }
  function zoom(f, atFrac) {
    if (!cur) return;
    const T = cur.x.length / (cur.fs || 130), c = view.t0 + view.win * (atFrac == null ? 0.5 : atFrac);
    view.win = Math.max(2.5, Math.min(Math.min(60, T), view.win * f));
    view.t0 = c - view.win * (atFrac == null ? 0.5 : atFrac);
    document.querySelectorAll('#ecgZoom button').forEach((b) => b.classList.toggle('active', +b.dataset.w === view.win));
    draw();
  }
  function bindViewer() {
    const c = $('ecgCanvas'), pts = new Map();
    let drag = null, pinch = null;
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, e.clientX); if (pts.size === 1) drag = { x: e.clientX, t0: view.t0 }; else { const xs = [...pts.values()]; pinch = { d: Math.abs(xs[0] - xs[1]) || 1, win: view.win }; drag = null; } });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !cur) return; pts.set(e.pointerId, e.clientX);
      if (pinch && pts.size >= 2) { const xs = [...pts.values()], d = Math.abs(xs[0] - xs[1]) || 1; const want = pinch.win * pinch.d / d; zoom(want / view.win, ((xs[0] + xs[1]) / 2 - c.getBoundingClientRect().left) / c.clientWidth); }
      else if (drag) { view.t0 = drag.t0 - (e.clientX - drag.x) / c.clientWidth * view.win; draw(); }
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) drag = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (!cur) return; e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoom(e.deltaY > 0 ? 1.25 : 0.8, (e.clientX - c.getBoundingClientRect().left) / c.clientWidth);
      else { view.t0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / c.clientWidth * view.win; draw(); }
    }, { passive: false });
    $('ecgOverview').addEventListener('click', (e) => { if (!cur) return; const o = $('ecgOverview'), T = cur.x.length / (cur.fs || 130); view.t0 = (e.clientX - o.getBoundingClientRect().left) / o.clientWidth * T - view.win / 2; draw(); });
    document.querySelectorAll('#ecgZoom button').forEach((b) => b.addEventListener('click', () => { view.win = +b.dataset.w; zoom(1); }));
    window.addEventListener('resize', () => { if (cur && !$('ecgViewBox').classList.contains('hidden')) draw(); });
    $('ecgDelete').addEventListener('click', async () => {
      const id = $('ecgDelete').dataset.id; if (!id || !confirm('Удалить эту запись ЭКГ?')) return;
      save(K_PEND, load(K_PEND, []).filter((r) => r.id !== id));
      try { await api('api/ecg/' + id, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) { state('Не удалось удалить: нет связи с сервером.'); return; } }
      delete cache[id]; cur = null; $('ecgViewBox').classList.add('hidden'); refresh();
    });
  }

  async function refresh() {
    if (!$('ecgPanel')) return;
    await upload().catch(() => {});
    const ls = await list();
    $('ecgEmpty').classList.toggle('hidden', ls.length > 0);
    $('ecgListBox').classList.toggle('hidden', !ls.length);
    $('ecgList').innerHTML = '<tr><th>Когда</th><th>Длит.</th><th>Пульс</th><th>RMSSD</th><th>Когда по отношению к бегу</th><th></th></tr>' +
      ls.slice(0, 50).map((r) => `<tr data-id="${r.id}" class="${cur && cur.id === r.id ? 'sel' : ''}"><td>${when(r.started_at)}</td><td>${Math.round(r.duration_s)} с</td><td>${r.hr_avg ? Math.round(r.hr_avg) : '—'}</td>` +
        `<td>${r.rmssd ? Math.round(r.rmssd) + ' мс' : '—'}</td><td>${PHASE[r.phase] || ''}</td><td class="muted">${r.pending ? 'не отправлено' : ''}</td></tr>`).join('');
    $('ecgList').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => show(tr.dataset.id)));
    if (!cur && ls.length && !$('ecgViewBox').dataset.auto) { $('ecgViewBox').dataset.auto = '1'; show(ls[0].id); }
  }

  if ($('ecgPanel')) {
    bindViewer();
    if (WR) {
      $('ecgStart').addEventListener('click', startRec);
      $('ecgStop').addEventListener('click', stopRec);
      // the app may have been closed while a record was saved by the service
      setTimeout(() => collect().then((r) => r && refresh()), 1500);
      WR.getEcg({ since: 0 }).then((r) => { if (r && (r.status === 'recording' || r.status === 'starting')) { $('ecgStart').classList.add('hidden'); $('ecgStop').classList.remove('hidden'); $('ecgLiveBox').classList.remove('hidden'); liveSince = r.count; poll = setInterval(tick, 1000); } }).catch(() => {});
    }
    if (window.FT.Sync && window.FT.Sync.on) window.FT.Sync.on((s) => { if (s.state === 'ok' && load(K_PEND, []).length) upload().catch(() => {}); });
  }
  window.FTEcg = { refresh, show, _decode: decode, _enrich: enrich };
})();
