/* HR recovery module: per-run recovery curve, comparison of curves, trends, interpretation. Web & app. */
(function () {
  'use strict';
  const { api, Store } = window.FT;
  const A = window.FTAnalysis;
  const $ = (id) => document.getElementById(id);
  const charts = {};
  let items = [], pickId = null, mode = 'abs';
  const TYPES = { run: 'Бег', walk: 'Ходьба', workout: 'Тренировка' };
  const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const round = (v) => (v == null ? '—' : Math.round(v));
  const when = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function chart(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart($(id), cfg); return charts[id]; }

  // shaded phases for the full-session chart
  const zonesPlugin = {
    id: 'ftZones',
    beforeDatasetsDraw(c, _a, opts) {
      const { ctx, chartArea: ca, scales: { x } } = c; if (!opts || !opts.zones) return;
      ctx.save();
      for (const z of opts.zones) {
        const x0 = Math.max(ca.left, x.getPixelForValue(z.from)), x1 = Math.min(ca.right, x.getPixelForValue(z.to));
        if (x1 <= x0) continue;
        ctx.fillStyle = z.color; ctx.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top);
        if (z.label) { ctx.fillStyle = z.labelColor || '#999'; ctx.font = '11px Arial'; ctx.fillText(z.label, x0 + 4, ca.top + (z.labelY || 12)); }
      }
      ctx.restore();
    },
  };

  /** Full HR session of a workout: before / run / recovery, x = minutes from the start. */
  function sessionChart(canvas, w) {
    const [RS, D] = A.runBounds(w), cut = w.tail_cut != null ? w.tail_cut : Infinity;
    const pauses = (w.seg && w.seg.pauses) || [];
    const ss = (w.session_samples || []).filter((p) => p[0] < cut);
    const mask = (w.quality && w.quality.mask) || [];
    const isM = (t) => mask.some((m) => t >= m[0] && t <= m[1]);
    const data = ss.map((p) => ({ x: p[0] / 60, y: isM(p[0]) ? null : p[1] }));
    const noisy = mask.length ? ss.map((p) => ({ x: p[0] / 60, y: isM(p[0]) ? p[1] : null })) : [];
    const xmin = data.length ? data[0].x : 0, xmax = data.length ? data[data.length - 1].x : D / 60;
    const r = A.recovery(w);
    const ds = [{ label: 'Пульс', data, borderColor: '#ff4d4d', backgroundColor: 'rgba(255,77,77,.12)', fill: true, pointRadius: 0, borderWidth: 1.6, tension: 0.15, spanGaps: false }];
    if (noisy.length) ds.push({ label: 'помехи', data: noisy, borderColor: 'rgba(255,170,170,.55)', borderDash: [3, 3], pointRadius: 0, borderWidth: 1.2, spanGaps: false });
    if (r && r.baseline) ds.push({ label: r.repeat ? 'исходный (из первой пробежки)' : 'исходный', data: [{ x: xmin, y: r.baseline }, { x: xmax, y: r.baseline }], borderColor: '#888', borderDash: [4, 4], pointRadius: 0, borderWidth: 1 });
    return new Chart(canvas, {
      type: 'line', data: { datasets: ds }, plugins: [zonesPlugin],
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { legend: { display: false }, ftZones: { zones: [
          { from: xmin, to: 0, color: 'rgba(150,150,150,.10)', label: 'до старта' },
          ...(RS > 3 ? [{ from: 0, to: RS / 60, color: 'rgba(200,200,120,.12)', label: 'подход' }] : []),
          { from: RS / 60, to: D / 60, color: 'rgba(57,211,83,.08)', label: 'бег' },
          { from: D / 60, to: xmax, color: 'rgba(63,167,255,.12)', label: 'отход и восстановление' }]
          .concat(pauses.map((m, i) => ({ from: m[0] / 60, to: m[1] / 60, color: 'rgba(255,170,40,.28)', label: i === 0 ? 'пауза' : '', labelY: 40, labelColor: '#ffb020' })))
          .concat(mask.map((m, i) => ({ from: m[0] / 60, to: m[1] / 60, color: 'rgba(255,60,60,.18)', label: i === 0 ? 'помехи' : '', labelY: 26, labelColor: '#ff8080' }))) } },
        scales: { x: { type: 'linear', min: xmin, max: xmax, title: { display: true, text: 'минуты от старта' } }, y: { suggestedMin: 50, suggestedMax: 180 } } },
    });
  }

  function metricsHtml(r) {
    const c = (v, k) => `<div><b>${v}</b>${k}</div>`;
    return '<h4 class="sub">Восстановление пульса</h4><div class="rec-metrics">' +
      c(round(r.hr_end), 'ЧСС на финише') + c(r.hrr[1] != null ? '−' + round(r.hrr[1]) : '—', 'за 1 мин') + c(r.hrr[2] != null ? '−' + round(r.hrr[2]) : '—', 'за 2 мин') +
      c(r.hrr[5] != null ? '−' + round(r.hrr[5]) : '—', 'за 5 мин') + c(r.tau ? r.tau + ' с' : '—', 'τ спада') + c(round(r.baseline), r.repeat ? 'исходный (из 1-й пробежки)' : 'исходный (до старта)') +
      c(r.t_below_100 != null ? fmtDur(r.t_below_100) : '—', 'до < 100') + c(r.final_post != null ? round(r.final_post) : '—', `через ${Math.round(r.post_s / 60)} мин`) +
      '</div>' + (r.repeat ? '<div class="small muted">Повторная пробежка: исходный пульс взят из записи перед первой пробежкой сессии.</div>' : '') + (r.gaps ? `<div class="small muted">В записи после финиша были пропуски (до ${r.max_gap_s} с) — значения рядом с ними приблизительные.</div>` : '');
  }

  // ---------- interpretation (careful, non-medical) ----------
  function avg(list, f) { const xs = list.map(f).filter((v) => v != null && isFinite(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
  function hints(r, hist) {
    const out = [];
    if (r.post_s < 90) out.push(['info', 'После финиша записано меньше 1,5 мин — для оценки восстановления держи пояс хотя бы 5–10 минут.']);
    const h1 = r.hrr[1], h2 = r.hrr[2];
    if (r.hr_end != null && r.hr_peak != null && r.hr_end < 130) out.push(['info', `Финиш был спокойным (пульс ${round(r.hr_end)}) — после лёгкой нагрузки падение всегда меньше, сравнивать стоит с похожими тренировками.`]);
    if (h1 != null) {
      if (h1 >= 25) out.push(['good', `За первую минуту пульс упал на ${round(h1)} уд/мин — это хорошее быстрое восстановление.`]);
      else if (h1 >= 12) out.push(['mid', `Падение за 1 мин — ${round(h1)} уд/мин: в обычных пределах (больше 12).`]);
      else out.push(['low', `Падение за 1 мин всего ${round(h1)} уд/мин. После интенсивной нагрузки это немного; если так будет повторяться без видимых причин (жара, усталость, недосып, болезнь), стоит обратить внимание и при сомнениях обсудить с врачом.`]);
    }
    if (h2 != null && h2 < 22 && (h1 == null || h1 >= 12)) out.push(['mid', `За 2 мин −${round(h2)} уд/мин (обычно больше 22) — восстановление чуть медленнее типичного.`]);
    if (hist.length >= 3) {
      const a1 = avg(hist, (x) => x.r.hrr[1]), at = avg(hist, (x) => x.r.tau);
      if (h1 != null && a1 != null) {
        const d = h1 - a1;
        if (d >= 5) out.push(['good', `HRR1 на ${round(d)} лучше твоего среднего (${round(a1)}).`]);
        else if (d <= -5) out.push(['mid', `HRR1 на ${round(-d)} хуже твоего среднего (${round(a1)}) — частые причины: накопленная усталость, жара, недосып, кофеин, начало простуды.`]);
        else out.push(['info', `HRR1 на уровне твоего среднего (${round(a1)}).`]);
      }
      if (r.tau && at) {
        if (r.tau < at * 0.85) out.push(['good', `Пульс спадал быстрее обычного (τ ${r.tau} с против среднего ${round(at)} с).`]);
        else if (r.tau > at * 1.15) out.push(['mid', `Пульс спадал медленнее обычного (τ ${r.tau} с против среднего ${round(at)} с).`]);
      }
    } else out.push(['info', 'Сравнение с твоими средними появится после 3–4 записей.']);
    if (r.gaps) out.push(['info', `Были пропуски сигнала (до ${r.max_gap_s} с) — проверь, что пояс плотно прилегает и электроды влажные.`]);
    return out;
  }

  // ---------- data ----------
  async function load() {
    try {
      const list = await api('api/stats/recovery?limit=60&bin_s=3');
      $('recOffline').classList.add('hidden');
      return list;
    } catch (e) {
      const local = Store.workoutList().filter((w) => w.session_samples && w.session_samples.length)
        .map((w) => Object.assign({}, w, { curve: w.session_samples }));
      $('recOffline').textContent = 'Нет связи с сервером — показываю записи, сохранённые на устройстве.';
      $('recOffline').classList.toggle('hidden', false);
      return local;
    }
  }

  async function refresh() {
    const list = await load();
    items = list.map((x) => ({ x, r: A.recovery({ duration_s: x.duration_s, seg: x.seg, session_samples: x.curve, quality: x.quality, tail_cut: x.tail_cut, inherit: x.inherit }) }))
      .filter((it) => it.r && it.r.hr_end != null && it.r.post_s >= 30)
      .sort((a, b) => b.x.started_at - a.x.started_at);
    $('recEmpty').classList.toggle('hidden', items.length > 0);
    $('recMain').classList.toggle('hidden', items.length === 0);
    if (!items.length) return;
    if (!pickId || !items.find((it) => it.x.id === pickId)) pickId = items[0].x.id;
    $('recPick').innerHTML = items.map((it) => `<option value="${it.x.id}">${when(it.x.started_at)} · ${TYPES[it.x.type] || ''} ${(it.x.distance_m / 1000 || 0).toFixed(1)} км</option>`).join('');
    $('recPick').value = pickId;
    renderLatest(); renderOverlay(); renderTrend(); renderTable(); renderHrvTrend();
  }

  // ---------- HRV ----------
  const rrCache = {};
  async function rrOf(x) {
    if (rrCache[x.id]) return rrCache[x.id];
    const local = (Store.workouts()[x.id] || {}).session_rr;
    if (local && local.length) return (rrCache[x.id] = local);
    if (!x.rr_count) return [];
    try { const full = await api('api/workouts/' + x.id); return (rrCache[x.id] = (full && full.session_rr) || []); } catch (e) { return []; }
  }
  // a back-to-back run carries the first run's pre-run HRV — don't count it twice in averages/trends
  const hrvOf = (x) => (x.recovery && x.recovery.repeat ? Object.assign({}, x.recovery, { rmssd_pre: null, sdnn_pre: null }) : x.recovery || {});
  function hrvHints(h, hist) {
    const out = [];
    if (h.artifacts_pct > 5) out.push(['info', `Отброшено ${h.artifacts_pct}% интервалов как артефакты — смочи электроды и подтяни пояс, иначе HRV менее точна.`]);
    if (!h.pre) out.push(['info', 'Для HRV до старта нужно ≥2 мин спокойной записи перед «Старт» (последние 30 с перед стартом не учитываются).']);
    const av = avg(hist, (o) => hrvOf(o.x).rmssd_pre);
    if (h.pre && av != null && hist.filter((o) => hrvOf(o.x).rmssd_pre != null).length >= 3) {
      const d = (h.pre.rmssd - av) / av;
      if (d <= -0.25) out.push(['mid', `RMSSD до старта ${round(h.pre.rmssd)} мс — заметно ниже твоего обычного (${round(av)}). Так часто бывает при накопленной усталости, недосыпе, стрессе, после алкоголя или в начале простуды — можно сделать тренировку полегче. Это ориентир, не диагноз.`]);
      else if (d >= 0.15) out.push(['good', `RMSSD до старта ${round(h.pre.rmssd)} мс — выше твоего обычного (${round(av)}): организм, похоже, хорошо отдохнул.`]);
      else out.push(['info', `RMSSD до старта на твоём обычном уровне (${round(av)} мс).`]);
    } else if (h.pre) out.push(['info', 'Сравнение HRV с твоим обычным уровнем появится после 3 записей с поясом до старта.']);
    if (h.pre && h.post5_10) out.push(['info', `Через 5–10 мин после финиша RMSSD ${round(h.post5_10.rmssd)} мс против ${round(h.pre.rmssd)} до старта — снижение после нагрузки нормально; чем быстрее HRV возвращается, тем легче далась тренировка.`]);
    return out;
  }
  let hrvSeq = 0;
  async function renderHrv(x, r) {
    const seq = ++hrvSeq;
    const rr = await rrOf(x);
    if (seq !== hrvSeq) return;
    const h = rr.length ? A.hrv({ duration_s: x.duration_s, seg: x.seg, session_rr: rr, quality: x.quality, tail_cut: x.tail_cut, inherit: x.inherit }) : null;
    $('recHrvNone').classList.toggle('hidden', !!h);
    $('recHrvBody').classList.toggle('hidden', !h);
    $('recHrvNote').textContent = h ? `${h.beats} ударов` : '';
    if (!h) return;
    const idx = items.findIndex((it) => it.x.id === x.id), hist = items.filter((o, i) => i !== idx).slice(0, 10);
    const AV = avg(hist, (o) => hrvOf(o.x).rmssd_pre);
    const card = (v, k, cur, av) => {
      let d = '';
      if (cur != null && av != null) { const diff = cur - av; d = Math.abs(diff) >= 1 ? `<div class="d ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff))} к среднему</div>` : '<div class="d">как обычно</div>'; }
      return `<div class="card"><div class="v">${v}</div><div class="k">${k}</div>${d}</div>`;
    };
    const g = (o, k, u) => (o && o[k] != null ? round(o[k]) + (u || '') : '—');
    $('recHrvCards').innerHTML = [
      card(g(h.pre, 'rmssd'), 'RMSSD до старта, мс', h.pre ? h.pre.rmssd : null, AV),
      card(g(h.pre, 'sdnn'), 'SDNN до старта, мс'),
      card(g(h.pre, 'pnn50', '%'), 'pNN50 до старта'),
      card(g(h.pre, 'hr'), 'пульс по RR до старта'),
      card(g(h.post5_10, 'rmssd'), 'RMSSD 5–10 мин после'),
      card(g(h.post_end, 'rmssd'), 'RMSSD в конце записи'),
      card(h.artifacts_pct + '%', 'артефактов отброшено'),
    ].join('');
    $('recHrvHints').innerHTML = hrvHints(h, hist).map(([c, t]) => `<div class="${c}">${t}</div>`).join('');
    const D = A.runBounds(x)[1], ser = h.series.map((p) => ({ x: p[0] / 60, y: p[1] }));
    const hrPts = (x.curve || []).map((p) => ({ x: p[0] / 60, y: p[1] }));
    const xmin = Math.floor(ser.length ? ser[0].x : 0), xmax = Math.ceil(ser.length ? ser[ser.length - 1].x : D / 60);
    chart('recHrvChart', {
      type: 'line', plugins: [zonesPlugin],
      data: { datasets: [
        { label: 'RMSSD (окно 60 с), мс', data: ser, borderColor: '#b07cff', backgroundColor: 'rgba(176,124,255,.15)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.2, yAxisID: 'y' },
        { label: 'пульс', data: hrPts, borderColor: 'rgba(255,77,77,.55)', pointRadius: 0, borderWidth: 1, tension: 0.15, yAxisID: 'y1' }] },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { ftZones: { zones: [
          { from: xmin, to: 0, color: 'rgba(150,150,150,.10)', label: 'до старта' },
          { from: 0, to: D / 60, color: 'rgba(57,211,83,.08)', label: 'тренировка' },
          { from: D / 60, to: xmax, color: 'rgba(63,167,255,.12)', label: 'восстановление' }] } },
        scales: { x: { type: 'linear', min: xmin, max: xmax, title: { display: true, text: 'минуты от старта' } },
          y: { beginAtZero: true, title: { display: true, text: 'RMSSD, мс' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'уд/мин' } } } },
    });
  }
  function renderHrvTrend() {
    const asc = items.slice().reverse().filter((it) => hrvOf(it.x).rmssd_pre != null || hrvOf(it.x).rmssd_post != null);
    $('recHrvTrend').parentElement.classList.toggle('hidden', asc.length < 2);
    if (asc.length < 2) return;
    const labels = asc.map((it) => { const d = new Date(it.x.started_at); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; });
    const ln = (label, k, color) => ({ label, data: asc.map((it) => hrvOf(it.x)[k]), borderColor: color, backgroundColor: color, tension: 0.25, spanGaps: true, pointRadius: 3 });
    chart('recHrvTrend', { type: 'line', data: { labels, datasets: [ln('RMSSD до старта', 'rmssd_pre', '#b07cff'), ln('RMSSD 5–10 мин после', 'rmssd_post', '#3fa7ff')] },
      options: { maintainAspectRatio: false, animation: false, plugins: { title: { display: true, text: 'HRV по тренировкам, мс (до старта: выше — лучше отдохнул)' } }, scales: { y: { beginAtZero: true } } } });
  }

  function renderLatest() {
    const idx = items.findIndex((it) => it.x.id === pickId), it = items[idx], r = it.r, x = it.x;
    const hist = items.filter((o, i) => i !== idx).slice(0, 10);
    $('recLatestTitle').textContent = (idx === 0 ? 'Последняя: ' : '') + `${TYPES[x.type] || 'Тренировка'}, ${when(x.started_at)}`;
    const card = (v, k, cur, av, better) => {
      let d = '';
      if (cur != null && av != null) { const diff = cur - av, good = better === 'up' ? diff > 0 : diff < 0; if (Math.abs(diff) >= 1) d = `<div class="d ${good ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff))} к среднему</div>`; else d = '<div class="d">как обычно</div>'; }
      return `<div class="card"><div class="v">${v}</div><div class="k">${k}</div>${d}</div>`;
    };
    const A1 = avg(hist, (o) => o.r.hrr[1]), A2 = avg(hist, (o) => o.r.hrr[2]), A5 = avg(hist, (o) => o.r.hrr[5]), AT = avg(hist, (o) => o.r.tau);
    $('recCards').innerHTML = [
      card(r.hrr[1] != null ? '−' + round(r.hrr[1]) : '—', 'за 1 мин, уд/мин', r.hrr[1], A1, 'up'),
      card(r.hrr[2] != null ? '−' + round(r.hrr[2]) : '—', 'за 2 мин', r.hrr[2], A2, 'up'),
      card(r.hrr[5] != null ? '−' + round(r.hrr[5]) : '—', 'за 5 мин', r.hrr[5], A5, 'up'),
      card(r.tau ? r.tau + ' с' : '—', 'τ — скорость спада', r.tau, AT, 'down'),
      card(round(r.hr_end), 'пульс на финише' + (r.hr_peak ? ` (макс ${round(r.hr_peak)})` : '')),
      card(round(r.baseline), 'исходный до старта'),
      card(r.t_below_100 != null ? fmtDur(r.t_below_100) : '—', 'до пульса < 100'),
      card(r.final_post != null ? round(r.final_post) : '—', `в конце записи (${Math.round(r.post_s / 60)} мин)`),
    ].join('');
    $('recHints').innerHTML = hints(r, hist).map(([c, t]) => `<div class="${c}">${t}</div>`).join('');
    renderHrv(x, r);
    // recovery curve with markers and exponential fit
    const D = A.runBounds(x)[1], pts = x.curve.filter((p) => p[0] >= D - 180).map((p) => ({ x: (p[0] - D) / 60, y: p[1] }));
    const xmax = r.post_s / 60;
    const ds = [{ label: 'пульс', data: pts, borderColor: '#ff4d4d', backgroundColor: 'rgba(255,77,77,.10)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15, order: 3 }];
    if (r.tau) { const fit = []; for (let t = 0; t <= Math.min(r.post_s, 900); t += 10) fit.push({ x: t / 60, y: r.hr_ss + r.fit_A * Math.exp(-t / r.tau) }); ds.push({ label: `экспонента, τ=${r.tau} с`, data: fit, borderColor: '#3fa7ff', borderDash: [6, 4], pointRadius: 0, borderWidth: 2, order: 2 }); }
    const marks = A.HRR_MIN.filter((k) => r.hr_at[k] != null).map((k) => ({ x: k, y: r.hr_at[k], k }));
    ds.push({ label: 'отметки 1/2/3/5/10 мин', data: marks, type: 'scatter', pointRadius: 6, pointBackgroundColor: '#ffb020', borderColor: '#ffb020', order: 1 });
    ds.push({ label: 'финиш', data: [{ x: 0, y: r.hr_end }], type: 'scatter', pointRadius: 7, pointStyle: 'triangle', pointBackgroundColor: '#fff', order: 0 });
    if (r.baseline) ds.push({ label: 'исходный', data: [{ x: pts.length ? pts[0].x : -3, y: r.baseline }, { x: xmax, y: r.baseline }], borderColor: '#888', borderDash: [3, 4], pointRadius: 0, borderWidth: 1 });
    chart('recCurve', {
      type: 'line', data: { datasets: ds },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        plugins: { tooltip: { callbacks: { label: (c) => c.dataset.label === 'отметки 1/2/3/5/10 мин' ? `${c.raw.k} мин: ${round(c.raw.y)} (−${round(r.hrr[c.raw.k])})` : `${c.dataset.label}: ${round(c.parsed.y)}` } } },
        scales: { x: { type: 'linear', min: pts.length ? Math.floor(pts[0].x) : -3, max: Math.ceil(xmax), title: { display: true, text: 'минуты после финиша' } }, y: { title: { display: true, text: 'уд/мин' } } } },
    });
  }

  function renderOverlay() {
    const recent = items.slice(0, 6), maxPost = Math.min(30, Math.max(...recent.map((it) => it.r.post_s / 60)));
    const ds = recent.map((it, i) => {
      const D = A.runBounds(it.x)[1], a = 1 - i * 0.14;
      const data = it.x.curve.filter((p) => p[0] >= D && p[0] <= D + maxPost * 60).map((p) => ({ x: (p[0] - D) / 60, y: mode === 'abs' ? p[1] : it.r.hr_end - p[1] }));
      return { label: when(it.x.started_at), data, borderColor: `rgba(${i ? '63,167,255' : '255,77,77'},${a})`, pointRadius: 0, borderWidth: i ? 1.5 : 2.5, tension: 0.2 };
    });
    chart('recOverlay', {
      type: 'line', data: { datasets: ds },
      options: { maintainAspectRatio: false, animation: false, parsing: false,
        scales: { x: { type: 'linear', min: 0, max: Math.ceil(maxPost), title: { display: true, text: 'минуты после финиша' } }, y: { title: { display: true, text: mode === 'abs' ? 'уд/мин' : 'падение от финиша, уд/мин' } } } },
    });
  }

  function renderTrend() {
    const asc = items.slice().reverse(), labels = asc.map((it) => { const d = new Date(it.x.started_at); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; });
    const ln = (label, f, color) => ({ label, data: asc.map(f), borderColor: color, backgroundColor: color, tension: 0.25, spanGaps: true, pointRadius: 3 });
    chart('recTrend', { type: 'line', data: { labels, datasets: [
      ln('за 1 мин', (it) => it.r.hrr[1], '#ff4d4d'), ln('за 2 мин', (it) => it.r.hrr[2], '#ffb020'), ln('за 5 мин', (it) => it.r.hrr[5], '#39d353')] },
      options: { maintainAspectRatio: false, animation: false, plugins: { title: { display: true, text: 'Падение пульса после финиша, уд/мин (выше — лучше)' } }, scales: { y: { beginAtZero: true } } } });
    chart('recTauTrend', { type: 'line', data: { labels, datasets: [ln('τ, с', (it) => it.r.tau, '#3fa7ff')] },
      options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, title: { display: true, text: 'τ — постоянная времени спада, с (ниже — быстрее)' } }, scales: { y: { beginAtZero: true } } } });
  }

  function renderTable() {
    $('recTable').innerHTML = '<tr><th>Когда</th><th>км</th><th>Финиш</th><th>1 мин</th><th>2 мин</th><th>5 мин</th><th>τ, с</th><th>Исх.</th><th>RMSSD до</th><th>После</th></tr>' +
      items.map((it) => { const r = it.r; return `<tr data-id="${it.x.id}"><td>${when(it.x.started_at)}</td><td>${((it.x.distance_m || 0) / 1000).toFixed(1)}</td><td>${round(r.hr_end)}</td>` +
        `<td>${r.hrr[1] != null ? '−' + round(r.hrr[1]) : '—'}</td><td>${r.hrr[2] != null ? '−' + round(r.hrr[2]) : '—'}</td><td>${r.hrr[5] != null ? '−' + round(r.hrr[5]) : '—'}</td>` +
        `<td>${r.tau || '—'}</td><td>${round(r.baseline)}</td><td>${round(hrvOf(it.x).rmssd_pre)}</td><td>${Math.round(r.post_s / 60)} мин</td></tr>`; }).join('');
    $('recTable').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { pickId = tr.dataset.id; $('recPick').value = pickId; renderLatest(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  if ($('recPick')) {
    $('recPick').addEventListener('change', () => { pickId = $('recPick').value; renderLatest(); });
    document.querySelectorAll('#recModeSeg button').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode; document.querySelectorAll('#recModeSeg button').forEach((x) => x.classList.toggle('active', x === b)); renderOverlay();
    }));
  }
  window.FTRecoveryUI = { sessionChart, metricsHtml, hints, zonesPlugin };
  window.FTRecovery = { refresh };
})();
