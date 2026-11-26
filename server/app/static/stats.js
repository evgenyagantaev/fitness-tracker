/* Statistics tab: streaks, heatmap, Chart.js charts. Needs the server. */
(function () {
  'use strict';
  const { api, Store, localDate } = window.FT;
  const COLORS = ['#39d353', '#3fa7ff', '#ffb020', '#ff5ad1', '#a07cff', '#ff6b6b', '#2ee6d6'];
  const charts = {};
  let period = 'week', runType = 'run';
  function fmtDur(s) { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }

  if (window.Chart) {
    Chart.defaults.color = '#bbb';
    Chart.defaults.borderColor = '#2c2c2c';
    Chart.defaults.font.family = 'Arial, sans-serif';
  }

  function exName(id) { const e = Store.exercises().find((x) => x.id === id); return e ? e.name : id; }
  function setExercises() { return Store.exercises().filter((e) => e.kind === 'sets'); }
  function dayWord(n) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'день' : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 'дня' : 'дней'; }

  const KM_COLORS = ['#ffb020', '#39d353', '#3fa7ff', '#b07cff'];
  function distExercises() {
    const ex = window.FT.Store.exercises().filter((e) => e.kind === 'distance');
    return ex.length ? ex : [{ id: 'run', name: 'Бег' }];
  }
  function chart(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }

  // one chart per exercise (pull-ups and push-ups have incomparable scales): canvases are created on demand
  function perExercise(boxId, prefix, exercises, cfgFor) {
    const box = document.getElementById(boxId); if (!box) return;
    const want = exercises.map((e) => prefix + e.id).join(',');
    if (box.dataset.ids !== want) {
      Object.keys(charts).filter((k) => k.startsWith(prefix)).forEach((k) => { charts[k].destroy(); delete charts[k]; });
      box.innerHTML = exercises.map((e) => `<h4 class="sub">${e.name}</h4><div class="chart-box ex-chart"><canvas id="${prefix}${e.id}"></canvas></div>`).join('');
      box.dataset.ids = want;
    }
    exercises.forEach((e, i) => chart(prefix + e.id, cfgFor(e, COLORS[i % COLORS.length])));
  }

  function renderCards(s, t) {
    const items = [
      [s.current, 'серия сейчас, ' + dayWord(s.current)],
      [s.longest, 'лучшая серия, ' + dayWord(s.longest)],
      [s.active_days, 'активных дней всего'],
      [(t.reps.pullups || 0).toLocaleString('ru-RU'), 'подтягиваний всего'],
      [(t.reps.pushups || 0).toLocaleString('ru-RU'), 'отжиманий всего'],
      [((t.km_by ? t.km_by.run : t.km) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), 'км пробежано'],
      [((t.km_by && t.km_by.walk) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 }), 'км пройдено пешком'],
    ];
    document.getElementById('streakCards').innerHTML = items.map(([v, k]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
  }

  function renderHeatmap(daily) {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - 7 * 25 - ((today.getDay() + 6) % 7)); // Monday, 26 weeks
    const cells = [];
    for (let d = new Date(start); d <= today || cells.length % 7; d.setDate(d.getDate() + 1)) {
      const key = localDate(d);
      if (d > today) { cells.push('<i class="future"></i>'); continue; }
      const m = byDate.get(key);
      const c = m ? m.completion : 0;
      const lvl = !m || !m.active ? 0 : c >= 1 ? 4 : c >= 0.66 ? 3 : c >= 0.33 ? 2 : 1;
      const tip = `${key}: ${m ? Math.round(c * 100) : 0}%` + (m && m.km_total ? `, ${m.km_total} км` : '');
      cells.push(`<i class="l${lvl}" title="${tip}"></i>`);
    }
    document.getElementById('heatmap').innerHTML = cells.join('');
  }

  function renderSummary(buckets) {
    const labels = buckets.map((b) => b.label);
    perExercise('repsCharts', 'repsChart-', setExercises(), (e, color) => ({
      type: 'bar',
      data: { labels, datasets: [{ label: e.name, data: buckets.map((b) => b.reps[e.id] || 0), backgroundColor: color }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: e.unit || 'раз' } } } },
    }));
    chart('kmChart', {
      type: 'line',
      data: { labels, datasets: distExercises().map((e, i) => ({ label: e.name, data: buckets.map((b) => (b.km_by ? b.km_by[e.id] || 0 : (i === 0 ? b.km : 0))),
        borderColor: KM_COLORS[i % KM_COLORS.length], backgroundColor: KM_COLORS[i % KM_COLORS.length] + '33', fill: true, tension: 0.3 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: distExercises().length > 1 } }, scales: { y: { beginAtZero: true } } },
    });
  }

  function renderDaily(daily) {
    const end = new Date(); const labels = [], keys = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); keys.push(localDate(d)); labels.push(`${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`); }
    const byDate = new Map(daily.map((d) => [d.date, d]));
    perExercise('dailyCharts', 'dailyChart-', setExercises(), (e, color) => ({
      type: 'line',
      data: { labels, datasets: [{ label: e.name, data: keys.map((k) => (byDate.get(k) ? byDate.get(k).reps[e.id] || 0 : 0)), borderColor: color, backgroundColor: color, tension: 0.25 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: e.unit || 'раз' } } } },
    }));
    if (document.getElementById('dailyKmChart')) chart('dailyKmChart', {
      type: 'bar',
      data: { labels, datasets: distExercises().map((e, i) => ({ label: e.name, data: keys.map((k) => (byDate.get(k) && byDate.get(k).km ? byDate.get(k).km[e.id] || 0 : 0)),
        backgroundColor: KM_COLORS[i % KM_COLORS.length], stack: 'km' })) },
      options: { maintainAspectRatio: false, animation: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'км' } } } },
    });
  }

  function renderTotals(t, weeks) {
    const cur = weeks[weeks.length - 1] || { reps: {}, km: 0 };
    const rows = Object.keys(t.reps).map((id) => `<div>${exName(id)}: <b>${(cur.reps[id] || 0)}</b> за неделю · ${t.reps[id].toLocaleString('ru-RU')} всего</div>`);
    for (const e of distExercises()) {
      const wk = cur.km_by ? cur.km_by[e.id] || 0 : cur.km, all = t.km_by ? t.km_by[e.id] || 0 : t.km, best = t.best_km_day_by ? t.best_km_day_by[e.id] || 0 : t.best_km_day;
      rows.push(`<div>${e.name}: <b>${Math.round(wk * 100) / 100}</b> км за неделю · ${all.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км всего · лучший день ${best} км</div>`);
    }
    document.getElementById('totalsPanel').innerHTML = '<h3>Итоги</h3><div class="totals">' + rows.join('') + '</div>';
  }

  function renderRuns(runs) {
    const el = document.getElementById('runCards'); if (!el) return;
    const withPace = runs.filter((r) => r.pace_s_km);
    const recent = withPace.filter((r) => r.started_at >= Date.now() - 28 * 86400000);
    const totalD = recent.reduce((x, r) => x + r.distance_m, 0), totalT = recent.reduce((x, r) => x + r.moving_s, 0);
    const best = withPace.filter((r) => r.distance_m >= 1000).sort((a, b) => a.pace_s_km - b.pace_s_km)[0];
    const longest = runs.slice().sort((a, b) => b.distance_m - a.distance_m)[0];
    const last = runs[runs.length - 1];
    const items = [
      [runs.length, 'тренировок записано'],
      [totalD > 0 ? fmtDur(totalT / (totalD / 1000)) : '—', 'средний темп за 4 недели, мин/км'],
      [best ? fmtDur(best.pace_s_km) : '—', 'лучший темп (от 1 км)'],
      [longest ? (longest.distance_m / 1000).toFixed(2) : '—', 'самая длинная, км'],
      [last && last.cadence_avg ? last.cadence_avg : '—', 'каденс последней, шаг/мин'],
    ];
    el.innerHTML = items.map(([v, k]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
    const labels = runs.map((r) => { const d = new Date(r.started_at); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; });
    const pv = runs.filter((r) => r.pace_s_km).map((r) => r.pace_s_km / 60);
    const pMin = pv.length ? Math.max(0, Math.floor(Math.min(...pv) - 0.5)) : 0, pMax = pv.length ? Math.ceil(Math.max(...pv) + 0.5) : 10;
    chart('runsChart', {
      type: 'bar',
      data: { labels, datasets: [
        { type: 'bar', label: 'км', data: runs.map((r) => Math.round(r.distance_m / 10) / 100), backgroundColor: 'rgba(255,176,32,.6)', yAxisID: 'y', order: 2 },
        { type: 'line', label: 'темп, мин/км', data: runs.map((r) => (r.pace_s_km ? Math.round(r.pace_s_km / 6) / 10 : null)), borderColor: '#3fa7ff', backgroundColor: '#3fa7ff', yAxisID: 'p', spanGaps: true, tension: 0.2, order: 1 },
      ] },
      options: { maintainAspectRatio: false, animation: false,
        plugins: { tooltip: { callbacks: { label: (c) => c.dataset.yAxisID === 'p' ? `темп ${fmtDur(c.parsed.y * 60)}/км` : `${c.parsed.y} км` } } },
        scales: { y: { beginAtZero: true, position: 'left', title: { display: true, text: 'км' } },
          p: { position: 'right', reverse: true, min: pMin, max: pMax, grid: { drawOnChartArea: false }, title: { display: true, text: 'мин/км' }, ticks: { callback: (v) => fmtDur(v * 60) } } } },
    });
  }
  function renderDynTrend(runs, labelsAll) {
    const box = document.getElementById('dynTrend'); if (!box) return;
    const rs = runs.filter((r) => r.dyn && r.dyn.vo_cm != null);
    box.classList.toggle('hidden', rs.length < 1);
    if (!rs.length) return;
    const labels = rs.map((r) => { const d = new Date(r.started_at); return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`; });
    const dots = rs.length <= 4 ? 3 : 2;
    if (!window.FTDynChart) return;
    if (charts.dynChart) { charts.dynChart.destroy(); delete charts.dynChart; }
    if (charts.dynCadChart) { charts.dynCadChart.destroy(); delete charts.dynCadChart; }
    charts.dynChart = window.FTDynChart.draw('dynChart', {
      labels,
      series: {
        vo: rs.map((r) => r.dyn.vo_cm),
        impact: rs.map((r) => r.dyn.impact_g),
        gct: rs.map((r) => r.dyn.gct_ms),
        cad: rs.map((r) => r.dyn.cadence),
      },
      pointRadius: dots,
    });
  }
  async function refreshRuns() {
    try { const rr = await api('api/stats/runs?type=' + runType + '&limit=60'); renderRuns(rr); renderDynTrend(rr); } catch (e) { /* handled by main refresh */ }
  }

  async function refresh() {
    const off = document.getElementById('statsOffline');
    const today = localDate();
    const from = new Date(); from.setDate(from.getDate() - 7 * 27);
    try {
      const [s, t, daily, buckets, weeks] = await Promise.all([
        api('api/stats/streaks?today=' + today),
        api('api/stats/totals'),
        api('api/stats/daily?from=' + localDate(from)),
        api(`api/stats/summary?period=${period}&count=${period === 'week' ? 12 : 12}&today=${today}`),
        api('api/stats/summary?period=week&count=1&today=' + today),
      ]);
      off.classList.add('hidden');
      renderCards(s, t); renderHeatmap(daily); renderSummary(buckets); renderDaily(daily); renderTotals(t, weeks);
      refreshRuns();
    } catch (e) {
      off.textContent = 'Статистика недоступна: ' + e.message + '. Отметки сохраняются на устройстве и уйдут на сервер при появлении связи.';
      off.classList.remove('hidden');
    }
  }

  document.querySelectorAll('#periodSeg button').forEach((b) => b.addEventListener('click', () => {
    period = b.dataset.period;
    document.querySelectorAll('#periodSeg button').forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  }));

  document.querySelectorAll('#runTypeSeg button').forEach((b) => b.addEventListener('click', () => {
    runType = b.dataset.type;
    document.querySelectorAll('#runTypeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    refreshRuns();
  }));

  window.FTStats = { refresh };
})();
