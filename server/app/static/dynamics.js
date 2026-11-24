/* v1.6.1: raw Polar H10 accelerometer → server (chunked) → running dynamics in the workout card; strap battery log. */
(function () {
  'use strict';
  const { api, Sync } = window.FT;
  const $ = (id) => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const WR = P.WorkoutRecorder && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? P.WorkoutRecorder : null;
  const CHUNK = 512 * 1024;
  const K_BATT = 'ft.battPending';
  let busy = false;

  // v1.6.1: every chunk carries CRC32 + length of the raw slice (server rejects a mismatch, and we check that the phone
  // really returned the slice at the requested offset); finish carries SHA-256 of both whole files and the phone copy
  // is released (kept 7 days in acc-uploaded/) only after the server confirmed the same hash.
  async function sendFile(r, file, size, from) {
    let off = from;
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const c = await WR.readAccChunk({ id: r.id, file, offset: off, length: len });
      if (c.offset != null && Number(c.offset) !== off) throw new Error(`phone returned offset ${c.offset} instead of ${off}`);
      if (c.len != null && Number(c.len) !== len) throw new Error(`phone returned ${c.len} bytes instead of ${len}`);
      await api(`api/acc/${r.id}/chunk?file=${file}&offset=${off}`, { method: 'PUT', body: { b64: c.b64, crc32: c.crc32, len: c.len } });
      off += len;
    }
  }

  async function uploadOne(r) {
    const hash = WR.accHash ? await WR.accHash({ id: r.id }) : {};
    if (hash.bytes != null) { r.bytes = Number(hash.bytes); r.frames_bytes = Number(hash.frames_bytes); }
    const meta = Object.assign({}, r); delete meta.bytes; delete meta.frames_bytes; delete meta.active;
    if (hash.sha256_data) { meta.sha256_data = hash.sha256_data; meta.sha256_frames = hash.sha256_frames; }
    let rec = null;
    for (let attempt = 0; attempt < 2 && !rec; attempt++) {
      const st = attempt ? { sizes: {} } : await api('api/acc/' + r.id);   // retry: everything again from 0
      for (const [file, size] of [['data', r.bytes], ['frames', r.frames_bytes]]) {
        let off = (st.sizes && st.sizes[file]) || 0;
        if (off > size) off = 0;
        if (attempt && size === 0) continue;
        await sendFile(r, file, size, attempt ? 0 : off);
      }
      try { rec = await api(`api/acc/${r.id}/finish`, { method: 'POST', body: meta }); }
      catch (e) { if (attempt || !/sha256|size/.test(String(e && e.message))) throw e; console.warn('acc finish mismatch, re-uploading', r.id, e); }
    }
    if (!rec) throw new Error('acc upload not verified');
    if (meta.sha256_data && rec.sha256_data !== meta.sha256_data) throw new Error('server hash differs — keeping the phone copy');
    await WR.deleteAcc({ id: r.id });
    return rec;
  }

  async function upload() {
    if (!WR || !WR.listAcc || busy) return;
    busy = true;
    try {
      const recs = ((await WR.listAcc()).records || []).filter((r) => r.complete && !r.active);
      for (const r of recs) {
        if (r.test) { await WR.deleteAcc({ id: r.id }).catch(() => {}); continue; }
        try { const rec = await uploadOne(r); if (cur && rec && rec.workout_id === cur) show({ id: cur }); } catch (e) { console.warn('acc upload', r.id, e); break; }
      }
    } finally { busy = false; }
    await uploadBattery().catch(() => {});
  }

  async function uploadBattery() {
    if (!WR || !WR.takeStrapBattery) return;
    let pend = [];
    try { pend = JSON.parse(localStorage.getItem(K_BATT) || '[]'); } catch (e) { pend = []; }
    const got = (await WR.takeStrapBattery()).readings || [];
    pend = pend.concat(got);
    localStorage.setItem(K_BATT, JSON.stringify(pend.slice(-5000)));
    if (!pend.length) return;
    await api('api/strap-battery', { method: 'POST', body: { readings: pend } });
    localStorage.setItem(K_BATT, '[]');
  }

  // ---------- workout card ----------
  let cur = null, chart = null;
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const fmt = (v, d) => (v == null ? '—' : (typeof v === 'object' ? v.med : v).toFixed(d == null ? 0 : d));
  async function show(w) {
    const box = $('wkDynamics'); if (!box) return;
    cur = w.id;
    let a = null;
    try { a = await api('api/workouts/' + w.id + '/dynamics'); } catch (e) { a = null; }
    if (cur !== w.id) return;
    const r = a && a.result;
    if (!r) { box.classList.add('hidden'); box.innerHTML = ''; if (chart) { chart.destroy(); chart = null; } return; }
    box.classList.remove('hidden');
    if (!r.ok) { box.innerHTML = `<h4 class="sub">Беговая динамика (H10)</h4><p class="small muted">Не посчитана: ${r.reason || '—'} (записано ${Math.round((r.samples || 0) / 200)} с акселерометра).</p>`; return; }
    const run = r.type === 'run';
    const partial = (a.meta && a.meta.partial) || r.partial;
    const confRu = { high: 'высокая', medium: 'средняя', low: 'низкая' };
    const items = [
      [fmt(r.cadence), 'Каденс по поясу, шаг/мин'],
      [fmt(r.vo_cm, 1), 'Вертикальные колебания, см'],
      [r.vratio_pct != null ? r.vratio_pct.toFixed(1) : '—', 'Вертикальное соотношение, %'],
      [fmt(r.sway_cm, 1), 'Поперечное раскачивание, см'],
      [fmt(r.impact_g, 2), 'Удар при приземлении, g'],
    ];
    if (run) items.push([fmt(r.gct_ms), 'Время опоры, мс' + (r.gct_conf ? ` (точность: ${confRu[r.gct_conf] || r.gct_conf})` : '')], [fmt(r.flight_ms), 'Время полёта, мс'], [fmt(r.duty_pct, 0), 'Доля опоры, %'],
      [r.balance_l_pct != null ? `${r.balance_l_pct.toFixed(1)} / ${(100 - r.balance_l_pct).toFixed(1)}` : '—', 'Баланс Л/П (оценка), %']);
    items.push([r.step_len_m != null ? r.step_len_m.toFixed(2) : '—', 'Длина шага, м' + (r.step_len_src === 'gps' ? ' (GPS ÷ шаги на беговых отрезках)' : r.step_len_src === 'avg' ? ' (средняя по тренировке)' : '')], [r.steps_h10, 'Шагов по поясу']);
    box.innerHTML = `<h4 class="sub">Беговая динамика (акселерометр H10)</h4>` +
      (partial ? `<p class="small warn">⚠ ${esc(partial)} — показатели только за этот отрезок.</p>` : '') + `<div class="rec-metrics">` +
      items.map(([v, k]) => `<div><b>${v}</b>${k}</div>`).join('') + `</div>` +
      (r.series && r.series.length > 1 ? '<div class="chart-box"><canvas id="wkDynChart"></canvas></div>' : '') +
      `<p class="small muted">Медиана по беговым шагам (${r.steps_used}). ` + (r.gct_clear_pct != null
        ? `Время опоры и полёта — по форме сигнала (приземление/отталкивание), чёткий контур у ${r.gct_clear_pct}% шагов; модель «пружины» дала бы ${fmt(r.gct_model_ms)} мс.`
        : 'Время опоры и полёта оценены по модели «пружины» из пика вертикальной перегрузки (±10–20 мс).') +
      ` Баланс Л/П — по направлению раскачивания, самая грубая метрика.` +
      (r.start_steps_h10 != null ? ` До первого события шагомера телефона (${r.phone_first_event[0]} с) пояс насчитал ${r.start_steps_h10} шаг., телефон потерял ≈${r.start_missed_h10}.` : '') +
      (r.acc_start_s != null && r.acc_start_s > 3 ? ` Акселерометр включился через ${r.acc_start_s} с после старта.` : '') + `</p>`;
    if (chart) { chart.destroy(); chart = null; }
    if (window.Chart && r.series && r.series.length > 1) {
      const X = (i) => r.series.map((p) => ({ x: p[0] / 60, y: p[i] }));
      const ds = [{ label: 'вертикальные колебания, см', data: X(2), borderColor: '#3fa7ff', backgroundColor: '#3fa7ff', yAxisID: 'y', pointRadius: 2, borderWidth: 2, tension: 0.2 }];
      if (run) ds.push({ label: 'время опоры, мс', data: X(3), borderColor: '#39d353', backgroundColor: '#39d353', yAxisID: 'y3', pointRadius: 2, borderWidth: 2, tension: 0.2 });
      chart = new Chart($('wkDynChart'), { type: 'line', data: { datasets: ds },
        options: { maintainAspectRatio: false, animation: false, parsing: false,
          scales: { x: { type: 'linear', title: { display: true, text: 'мин' } },
            y: { position: 'left', grace: '30%', title: { display: true, text: 'см' } },
            y3: { display: run, position: 'right', grace: '30%', grid: { display: false }, title: { display: true, text: 'мс' } } } } });
    }
  }

  // ---------- strap battery ----------
  async function renderBattery() {
    const el = $('strapBattInfo'); if (!el) return;
    let b = null;
    try { b = await api('api/stats/strap-battery'); } catch (e) { return; }
    const c = b && b.current;
    if (!c) { el.textContent = ''; return; }
    const since = new Date(c.installed_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    el.innerHTML = `Батарейка пояса: <b>${c.last_level}%</b> · стоит с ${since}, в работе ${c.use_h} ч` +
      (c.rate_pct_h ? ` · расход ${c.rate_pct_h}%/ч, хватит ещё ≈${c.left_h} ч` : ' · расход посчитаю, когда наберётся ≥2 ч работы и упадёт хотя бы на 2%') +
      (c.vs_prev ? ` · ${c.vs_prev > 1.15 ? 'садится быстрее' : c.vs_prev < 0.87 ? 'держит дольше' : 'как'} прошлой (×${c.vs_prev})` : '');
  }

  if (WR) {
    setTimeout(() => upload().then(renderBattery).catch(() => {}), 4000);
    Sync.on((s) => { if (s.state === 'ok') upload().then(renderBattery).catch(() => {}); });
  }
  window.FTDyn = { show, upload, uploadBattery, renderBattery, _uploadOne: uploadOne };
})();
