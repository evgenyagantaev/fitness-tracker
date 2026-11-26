/* v1.9: smart scale (Xiaomi Mi Body Composition Scale 2) — weigh screen in the app, weight & body composition
   charts and table, profile (height / birth / sex) for the composition formulas. Composition is computed on the server. */
(function () {
  'use strict';
  const { api, Store, isNative } = window.FT;
  const $ = (id) => document.getElementById(id);
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const WR = isNative && P.WorkoutRecorder ? P.WorkoutRecorder : null;
  const BLE = isNative && window.capacitorCommunityBluetoothLe ? window.capacitorCommunityBluetoothLe.BleClient : null;
  const K_PEND = 'ft.scalePending', K_CACHE = 'ft.weighings';
  let charts = {}, scanning = false, listeners = [], data = null, sending = null;

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const fmt = (v, nd = 1) => (v == null ? '—' : Number(v).toFixed(nd).replace('.', ','));
  const when = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- phone → server ----------
  function queue(items) {
    const pend = load(K_PEND, []);
    for (const w of items || []) {
      const i = pend.findIndex((x) => x.id === w.id);
      if (i < 0) pend.push(w); else if (!pend[i].impedance && w.impedance) pend[i].impedance = w.impedance;
    }
    save(K_PEND, pend.slice(-300));
    return pend.length;
  }
  async function collect() {
    if (!WR || !WR.takeScaleReadings) return 0;
    try { const r = await WR.takeScaleReadings(); return queue(r.readings || []); } catch (e) { return load(K_PEND, []).length; }
  }
  async function flush() {
    if (sending) return sending;
    sending = (async () => {
      await collect();
      const pend = load(K_PEND, []);
      if (!pend.length) return false;
      try {
        await api('api/weighings', { method: 'POST', body: { items: pend } });
        const sent = new Set(pend.map((x) => x.id));
        save(K_PEND, load(K_PEND, []).filter((x) => !sent.has(x.id) || pend.find((p) => p.id === x.id && !p.impedance && x.impedance)));
        return true;
      } catch (e) { return false; }
    })();
    try { return await sending; } finally { sending = null; }
  }

  // ---------- weigh screen (app) ----------
  async function startWeigh() {
    if (!WR || !WR.scaleStart || scanning) return;
    const st = $('scaleLive'), msg = $('scaleMsg');
    msg.textContent = '';
    if (window.FTWorkout && window.FTWorkout.isRecording && window.FTWorkout.isRecording()) { msg.textContent = 'Идёт запись тренировки — взвешивание после финиша.'; return; }
    try { if (BLE) await BLE.initialize({ androidNeverForLocation: false }); } catch (e) { /* the scan below reports the reason */ }
    try {
      for (const l of listeners) { try { await l.remove(); } catch (e) { /* ignore */ } }
      listeners = [await WR.addListener('scale', onFrame), await WR.addListener('scaleStopped', () => stopUi('Поиск весов остановлен (3 мин).'))];
      await WR.scaleStart();
      scanning = true;
      $('scaleWeigh').textContent = 'Остановить';
      st.innerHTML = '<div class="scale-num muted">…</div><div class="small muted">Встань на весы босиком. Стой спокойно, пока цифры не замрут и не появится состав тела.</div>';
    } catch (e) {
      const R = { 'no-permission': 'Нет разрешения на Bluetooth / геолокацию — открой настройки приложения.', 'bluetooth-off': 'Включи Bluetooth.', 'no-bluetooth': 'На телефоне нет Bluetooth LE.', recording: 'Идёт запись тренировки.' };
      msg.textContent = R[e.code] || R[e.message] || ('Не получилось начать поиск: ' + (e.message || e));
    }
  }
  function stopUi(text) {
    scanning = false;
    if ($('scaleWeigh')) $('scaleWeigh').textContent = 'Взвеситься';
    if (text && $('scaleMsg')) $('scaleMsg').textContent = text;
  }
  async function stopWeigh() { try { await WR.scaleStop(); } catch (e) { /* ignore */ } stopUi(''); }
  function onFrame(f) {
    const st = $('scaleLive'); if (!st) return;
    const cls = f.final ? 'scale-num final' : 'scale-num';
    const sub = f.removed ? 'Взвешивание закончено.'
      : f.final ? (f.impedance ? `Готово: сопротивление ${f.impedance} Ом. Можно сходить с весов.` : 'Вес есть, ждём состав тела (стой босиком)…')
        : 'Взвешиваю…';
    st.innerHTML = `<div class="${cls}">${fmt(f.weight_kg, 2)} <span class="small">кг</span></div><div class="small muted">${sub}</div>`;
    if (f.final && f.saved) {
      queue([{ id: f.id, t: Date.now(), weight_kg: f.weight_kg, impedance: f.impedance || undefined, scale_time: f.scale_time, unit: f.unit, source: 'mi-scale-2' }]);
      clearTimeout(onFrame.t); onFrame.t = setTimeout(async () => { await flush(); refresh(); }, 1500);
    }
    if (f.final && f.impedance) setTimeout(() => { if (scanning) stopWeigh(); }, 4000);
  }

  // ---------- profile ----------
  function fillProfile(p) {
    if (!$('profHeight')) return;
    $('profHeight').value = p && p.height_cm ? p.height_cm : '';
    $('profBirth').value = p && p.birth ? p.birth : '';
    $('profSex').value = p && p.sex ? p.sex : '';
  }
  async function loadProfile() {
    try { const p = await api('api/profile'); fillProfile(p); return p; } catch (e) { return null; }
  }
  async function saveProfile() {
    const h = parseFloat(String($('profHeight').value).replace(',', '.'));
    const body = { height_cm: h > 0 ? h : null, birth: $('profBirth').value.trim() || null, sex: $('profSex').value || null };
    try {
      const p = await api('api/profile', { method: 'PUT', body });
      $('profMsg').textContent = p.complete ? 'Сохранено. Состав тела пересчитан для всех взвешиваний.' : 'Сохранено. Для состава тела нужны рост, год рождения и пол.';
      refresh();
    } catch (e) { $('profMsg').textContent = e.status === 422 ? 'Проверь поля: рост 100–230 см, год рождения ГГГГ или дата ГГГГ-ММ-ДД.' : 'Не сохранилось: ' + e.message; }
  }

  // ---------- page ----------
  function cards(items, prof) {
    const last = items[items.length - 1], c = (last && last.comp) || {};
    const prev = items.length > 1 ? items[items.length - 2] : null;
    const d = prev ? last.weight_kg - prev.weight_kg : null;
    const delta = d == null ? '' : Math.abs(d) < 0.05 ? '<div class="d">как в прошлый раз</div>'
      : `<div class="d">${d > 0 ? '+' : '−'}${fmt(Math.abs(d), 1)} кг к прошлому</div>`;
    const it = [
      [fmt(last.weight_kg, 2), 'вес, кг', delta], [fmt(c.bmi, 1), 'ИМТ'], [fmt(c.fat_pct, 1), 'жир, %'], [fmt(c.muscle_kg, 1), 'мышцы, кг'],
      [fmt(c.water_pct, 1), 'вода, %'], [fmt(c.bone_kg, 1), 'кости, кг'], [fmt(c.visceral, 0), 'висцеральный жир'], [c.bmr_kcal || '—', 'обмен веществ, ккал/сут'],
    ];
    $('scaleCards').innerHTML = `<div class="small muted">Последнее взвешивание: ${when(last.t)}${last.impedance ? ` · ${last.impedance} Ом` : ' · без сопротивления (жир/мышцы не считаются)'}</div>` +
      '<div class="cards">' + it.map(([v, k, x]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div>${x || ''}</div>`).join('') + '</div>';
    $('scaleProfileHint').classList.toggle('hidden', !!(prof && prof.complete));
  }
  function chart(items) {
    if (!window.Chart) return;
    const el = $('scaleChart'); if (!el) return;
    if (charts.w) charts.w.destroy();
    const pts = (k, f) => items.filter((w) => f(w) != null).map((w) => ({ x: w.t, y: f(w) }));
    const ds = [
      { label: 'вес, кг', data: pts('w', (w) => w.weight_kg), borderColor: '#3fa7ff', backgroundColor: '#3fa7ff', yAxisID: 'yW', tension: 0.2, pointRadius: 3 },
      { label: 'жир, %', data: pts('f', (w) => w.comp && w.comp.fat_pct), borderColor: '#ff6b6b', backgroundColor: '#ff6b6b', yAxisID: 'yP', tension: 0.2, pointRadius: 3 },
      { label: 'мышцы, кг', data: pts('m', (w) => w.comp && w.comp.muscle_kg), borderColor: '#39d353', backgroundColor: '#39d353', yAxisID: 'yW', tension: 0.2, pointRadius: 3, hidden: false },
    ];
    const t0 = items[0].t, t1 = items[items.length - 1].t, pad = Math.max(12 * 3600e3, (t1 - t0) * 0.03);
    const allW = [...ds[0].data, ...ds[2].data].map((p) => p.y);
    const wMin = Math.min(...allW), wMax = Math.max(...allW);
    charts.w = new Chart(el, {
      type: 'line', data: { datasets: ds },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { tooltip: { callbacks: { title: (it) => it.length ? when(it[0].parsed.x) : '', label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, 1)}` } } },
        scales: {
          x: { type: 'linear', min: t0 - pad, max: t1 + pad, ticks: { maxTicksLimit: 8, callback: (v) => new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) } },
          yW: { position: 'left', title: { display: true, text: 'кг', color: '#3fa7ff' }, ticks: { color: '#3fa7ff' }, suggestedMin: wMin - 1, suggestedMax: wMax + 1 },
          yP: { position: 'right', title: { display: true, text: 'жир, %', color: '#ff6b6b' }, ticks: { color: '#ff6b6b' }, grid: { drawOnChartArea: false }, grace: '20%' },
        } },
    });
  }
  function table(items) {
    const rows = items.slice().reverse().map((w) => {
      const c = w.comp || {};
      return `<tr><td>${when(w.t)}</td><td><b>${fmt(w.weight_kg, 2)}</b></td><td>${w.impedance || '—'}</td><td>${fmt(c.fat_pct)}</td><td>${fmt(c.muscle_kg)}</td><td>${fmt(c.water_pct)}</td><td>${fmt(c.bmi)}</td>` +
        `<td><button class="btn small-btn scale-del" data-id="${esc(w.id)}" title="Удалить ошибочное взвешивание">✕</button></td></tr>`;
    }).join('');
    $('scaleTable').innerHTML = '<div class="table-wrap"><table class="calib-table"><tr><th>Когда</th><th>Вес, кг</th><th>Ом</th><th>Жир, %</th><th>Мышцы, кг</th><th>Вода, %</th><th>ИМТ</th><th></th></tr>' + rows + '</table></div>';
    $('scaleTable').querySelectorAll('.scale-del').forEach((b) => b.addEventListener('click', async () => {
      const w = items.find((x) => x.id === b.dataset.id);
      if (!w || !confirm(`Удалить взвешивание ${when(w.t)} (${fmt(w.weight_kg, 2)} кг)?`)) return;
      try { await api('api/weighings/' + encodeURIComponent(w.id), { method: 'DELETE' }); refresh(); } catch (e) { alert('Не удалилось: ' + e.message); }
    }));
  }
  function render(r) {
    const items = (r && r.items) || [];
    $('scaleEmpty').classList.toggle('hidden', items.length > 0);
    $('scaleData').classList.toggle('hidden', !items.length);
    if (!items.length) { $('scaleProfileHint').classList.toggle('hidden', !!(r && r.profile && r.profile.complete)); return; }
    cards(items, r.profile); chart(items); table(items);
  }
  async function refresh() {
    await flush();
    try { data = await api('api/weighings'); save(K_CACHE, data); $('scaleOffline').classList.add('hidden'); }
    catch (e) { data = load(K_CACHE, null); $('scaleOffline').classList.remove('hidden'); }
    render(data);
    const pend = load(K_PEND, []).length;
    if ($('scalePending')) $('scalePending').textContent = pend ? `Не отправлено на сервер: ${pend}` : '';
  }

  async function passiveToggle() {
    if (!WR || !WR.scaleConfig) return;
    try { const r = await WR.scaleConfig({ passive: $('scalePassive').checked }); $('scalePassive').checked = !!r.passive; } catch (e) { /* ignore */ }
  }

  function init() {
    if ($('scaleWeigh')) $('scaleWeigh').addEventListener('click', () => (scanning ? stopWeigh() : startWeigh()));
    if ($('profSave')) $('profSave').addEventListener('click', saveProfile);
    if ($('scalePassive')) {
      $('scalePassive').addEventListener('change', passiveToggle);
      if (WR && WR.scaleConfig) WR.scaleConfig({}).then((r) => { $('scalePassive').checked = !!r.passive; }).catch(() => {});
    }
    // weighings caught in the background (monitor running) go to the server whenever the app wakes up
    document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });
    setTimeout(flush, 4000);
  }
  init();
  window.FTScale = { refresh, onShow: () => { refresh(); }, loadProfile, flush, _queue: queue };
})();
