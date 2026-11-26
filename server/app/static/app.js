/* UI wiring: today checklist, login, settings, reminders, midnight rollover. */
(function () {
  'use strict';
  const { Store, Sync, api, localDate, isNative } = window.FT;
  const $ = (id) => document.getElementById(id);
  const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  let currentDate = localDate();
  let activeTab = 'today';

  if (isNative) document.body.classList.add('native');

  // ---------- today checklist ----------
  function renderToday() {
    currentDate = localDate();
    const d = new Date();
    $('todayLabel').textContent = `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`;
    const rec = Store.view(currentDate);
    const box = $('checklist');
    box.innerHTML = '';
    for (const e of Store.exercises()) {
      const g = document.createElement('div');
      g.className = 'ex-group';
      if (e.kind === 'sets') {
        rec.sets[e.id].done.forEach((checked, i) => {
          const id = `${e.id}${i + 1}`;
          g.insertAdjacentHTML('beforeend', `<div class="checkbox-container"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><label for="${id}">${esc(e.name)} ${rec.sets[e.id].reps}</label></div>`);
          g.lastElementChild.querySelector('input').addEventListener('change', (ev) => {
            const r = Store.view(currentDate); r.sets[e.id].done[i] = ev.target.checked; commit(r);
          });
        });
      } else {
        const r = rec.distance[e.id];
        const id = `${e.id}Check`;
        g.insertAdjacentHTML('beforeend', `<div class="checkbox-container"><input type="checkbox" id="${id}" ${r.done ? 'checked' : ''}><label for="${id}">${esc(e.name)}</label><input type="number" id="${e.id}Km" min="0" step="0.1" inputmode="decimal" placeholder="${esc(e.unit || 'км')}" value="${r.km ? r.km : ''}"></div>`);
        const cb = g.querySelector('input[type=checkbox]'), num = g.querySelector('input[type=number]');
        cb.addEventListener('change', () => { const x = Store.view(currentDate); x.distance[e.id].done = cb.checked; commit(x); });
        num.addEventListener('change', () => {
          const x = Store.view(currentDate);
          const km = Math.max(0, parseFloat(String(num.value).replace(',', '.')) || 0);
          x.distance[e.id].km = Math.round(km * 100) / 100;
          if (km > 0) { x.distance[e.id].done = true; cb.checked = true; }
          commit(x);
        });
      }
      box.appendChild(g);
    }
    renderProgress();
  }

  function commit(rec) { Store.put(rec); renderProgress(); Reminders.reschedule(); }

  function renderProgress() {
    const p = Store.progress(currentDate);
    $('progressBar').style.width = (p.total ? (100 * p.done / p.total) : 0) + '%';
    $('progressLabel').textContent = p.complete ? 'всё выполнено 💪' : `${p.done} / ${p.total}`;
  }

  $('resetButton').addEventListener('click', () => {
    if (!confirm('Сбросить сегодняшние отметки?')) return;
    const r = Store.blank(currentDate); commit(r); renderToday();
  });

  // ---------- sync status ----------
  function fmtTime(ts) { if (!ts) return 'никогда'; const d = new Date(ts); return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  Sync.on((s) => {
    const pending = Store.dirty().length + Store.wdirty().length;
    let txt;
    if (s.state === 'syncing') txt = 'Синхронизация…';
    else if (s.state === 'error') txt = (s.error && s.error.code === 'noserver' ? 'Работает без сервера' : 'Нет синхронизации: ' + s.error.message) + (pending ? ` · не отправлено: ${pending}` : '');
    else txt = 'Синхронизировано ' + fmtTime(Store.lastSync()) + (pending ? ` · не отправлено: ${pending}` : '');
    $('syncStatus').textContent = txt;
    $('syncInfo').textContent = txt + ` · ревизия ${Store.rev()}`;
    if (s.state === 'ok') { if (activeTab === 'today' && !document.activeElement.matches('input[type=number]')) renderToday(); }
    if (s.state === 'error' && s.error && s.error.code === 'auth' && !isNative) showLogin('Токен больше не действует, войди заново.');
  });

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(t) {
    activeTab = t;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('hidden', x.id !== 'tab-' + t));
    if (t === 'today') renderToday();
    if (t === 'stats') window.FTStats.refresh();
    if (t === 'recovery' && window.FTRecovery) window.FTRecovery.refresh();
    if (t === 'recovery' && window.FTEcg) window.FTEcg.refresh();
    if (t === 'settings' && window.FTWorkout) window.FTWorkout.refreshCalibration(true);
    if (t === 'workout') { window.FTWorkout.onShow(); Sync.schedule(0); }
    if (t === 'settings') renderSettings();
    if (t === 'weight' && window.FTScale) window.FTScale.onShow();
    if (t === 'settings' && window.FTScale) window.FTScale.loadProfile();
  }

  // ---------- login (web) ----------
  function showLogin(msg) {
    $('app').classList.add('hidden'); $('login').classList.remove('hidden');
    $('loginError').textContent = msg || '';
    $('loginToken').focus();
  }
  async function tryLogin() {
    const token = $('loginToken').value.trim();
    if (!token) { $('loginError').textContent = 'Введи токен'; return; }
    Store.setConfig({ token });
    try { await api('api/auth/check'); }
    catch (e) { $('loginError').textContent = e.code === 'auth' ? 'Неверный токен' : e.message; return; }
    $('login').classList.add('hidden'); startApp();
  }
  $('loginBtn').addEventListener('click', tryLogin);
  $('loginToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
  $('logout').addEventListener('click', () => { Store.setConfig({ token: '' }); location.reload(); });

  // ---------- settings ----------
  function renderSettings() {
    const c = Store.config();
    $('setUrl').value = c.serverUrl; $('setToken').value = c.token;
    $('notifEnabled').checked = c.notif.enabled; $('notifStart').value = c.notif.start; $('notifEnd').value = c.notif.end; $('notifEvery').value = c.notif.every;
    renderExEditor(Store.exercises());
    Sync.emit();
  }
  $('saveServer').addEventListener('click', async () => {
    Store.setConfig({ serverUrl: $('setUrl').value.trim(), token: $('setToken').value.trim() });
    $('serverMsg').textContent = 'Проверяю…';
    try { await api('api/auth/check'); $('serverMsg').textContent = 'Подключено ✔'; await Sync.run(); }
    catch (e) { $('serverMsg').textContent = 'Ошибка: ' + e.message; }
  });
  $('syncNow').addEventListener('click', () => Sync.run());

  function renderExEditor(list) {
    $('exEditor').innerHTML = '<div class="ex-head"><span>Название</span><span>Подходы</span><span>Повторы</span><span></span></div>' + list.map((e) => `
      <div class="ex-row" data-id="${esc(e.id)}" data-kind="${e.kind}">
        <input type="text" class="n" value="${esc(e.name)}">
        <input type="number" class="s" min="1" max="50" value="${e.sets}" ${e.kind === 'distance' ? 'disabled' : ''}>
        <input type="number" class="r" min="0" value="${e.kind === 'distance' ? '' : e.reps}" placeholder="${e.kind === 'distance' ? 'км' : ''}" ${e.kind === 'distance' ? 'disabled' : ''}>
        <button class="del" title="Удалить">✕</button>
      </div>`).join('');
    $('exEditor').querySelectorAll('.del').forEach((b) => b.addEventListener('click', () => b.parentElement.remove()));
  }
  function readExEditor() {
    return [...$('exEditor').querySelectorAll('.ex-row')].map((row, i) => {
      const kind = row.dataset.kind;
      return { id: row.dataset.id, name: row.querySelector('.n').value.trim() || 'Упражнение', kind,
        sets: kind === 'sets' ? Math.max(1, parseInt(row.querySelector('.s').value, 10) || 1) : 1,
        reps: kind === 'sets' ? Math.max(0, parseInt(row.querySelector('.r').value, 10) || 0) : 0,
        unit: kind === 'sets' ? 'раз' : 'км', position: i };
    });
  }
  function addEx(kind) {
    const list = readExEditor();
    list.push({ id: (kind === 'sets' ? 'ex' : 'dist') + Date.now().toString(36), name: kind === 'sets' ? 'Новое упражнение' : 'Дистанция', kind, sets: kind === 'sets' ? 3 : 1, reps: kind === 'sets' ? 10 : 0, unit: kind === 'sets' ? 'раз' : 'км' });
    renderExEditor(list);
  }
  $('exAddSets').addEventListener('click', () => addEx('sets'));
  $('exAddDist').addEventListener('click', () => addEx('distance'));
  $('exSave').addEventListener('click', async () => {
    const list = readExEditor();
    if (!list.length) { $('exMsg').textContent = 'Нужно хотя бы одно упражнение'; return; }
    try { const saved = await api('api/exercises', { method: 'PUT', body: list }); Store.setExercises(saved); $('exMsg').textContent = 'Сохранено ✔'; Reminders.reschedule(); }
    catch (e) {
      if (e.code === 'noserver' || e.code === 'notoken') { Store.setExercises(list); $('exMsg').textContent = 'Сохранено на устройстве (сервер не настроен)'; }
      else $('exMsg').textContent = 'Ошибка: ' + e.message;
    }
  });

  // ---------- reminders ----------
  const Reminders = {
    plugin() { return isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications; },
    timer: null,
    reschedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this._reschedule().catch((e) => console.warn('reminders', e)), 500); },
    async _reschedule() {
      const LN = this.plugin(); if (!LN) return;
      const c = Store.config().notif;
      const pending = await LN.getPending();
      if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
      if (!c.enabled) return;
      const perm = await LN.checkPermissions();
      if (perm.display !== 'granted') { const r = await LN.requestPermissions(); if (r.display !== 'granted') return; }
      const now = new Date(), list = [];
      const todayDone = Store.progress(localDate()).complete;
      for (let day = 0; day < 14; day++) {
        if (day === 0 && todayDone) continue;
        for (let h = c.start; h <= c.end; h += Math.max(1, c.every)) {
          const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, 0, 0);
          if (at <= now) continue;
          list.push({ id: day * 100 + h + 1, title: 'Фитнес-трекер', body: 'Помни о фитнесе', channelId: 'reminders', smallIcon: 'ic_stat_notify', schedule: { at, allowWhileIdle: true }, isExactNotification: false });
        }
      }
      if (list.length) await LN.schedule({ notifications: list });
    },
    async init() {
      const LN = this.plugin(); if (!LN) return;
      try { await LN.createChannel({ id: 'reminders', name: 'Напоминания', description: 'Помни о фитнесе', importance: 4, vibration: true }); } catch (e) { /* older Android */ }
      this.reschedule();
    },
  };
  $('saveNotif').addEventListener('click', () => {
    const clamp = (v, a, b, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.min(b, Math.max(a, v)); };
    const start = clamp($('notifStart').value, 0, 23, 9), end = clamp($('notifEnd').value, start, 23, 21);
    Store.setConfig({ notif: { enabled: $('notifEnabled').checked, start, end, every: clamp($('notifEvery').value, 1, 12, 1) } });
    Reminders.reschedule(); renderSettings();
    $('notifMsg').textContent = 'Сохранено ✔';
  });
  $('testNotif').addEventListener('click', async () => {
    const LN = Reminders.plugin(); if (!LN) return;
    const r = await LN.requestPermissions();
    if (r.display !== 'granted') { $('notifMsg').textContent = 'Нет разрешения на уведомления'; return; }
    await LN.schedule({ notifications: [{ id: 99999, title: 'Фитнес-трекер', body: 'Помни о фитнесе', channelId: 'reminders', smallIcon: 'ic_stat_notify', schedule: { at: new Date(Date.now() + 5000) }, isExactNotification: false }] });
    $('notifMsg').textContent = 'Уведомление придёт через 5 секунд';
  });

  // ---------- web: in-page reminder after inactivity (like the desktop app) ----------
  if (!isNative) {
    let t; const INACTIVITY = 60 * 60 * 1000;
    const reset = () => { clearTimeout(t); t = setTimeout(() => { if (!Store.progress(localDate()).complete) $('notification').style.display = 'block'; }, INACTIVITY); };
    ['mousemove', 'keypress', 'click', 'touchstart'].forEach((ev) => document.addEventListener(ev, reset));
    document.querySelector('#notification .close').addEventListener('click', () => { $('notification').style.display = 'none'; });
    reset();
  }

  // ---------- midnight rollover & background sync ----------
  function tick() {
    if (localDate() !== currentDate) { renderToday(); Reminders.reschedule(); Sync.schedule(0); }
  }
  setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); Sync.schedule(0); Reminders.reschedule(); } });
  window.addEventListener('online', () => Sync.schedule(0));
  setInterval(() => Sync.schedule(0), 5 * 60 * 1000);

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function startApp() {
    $('app').classList.remove('hidden');
    showTab('today');
    Sync.run();
    Reminders.init();
  }

  if (!isNative && !Store.config().token) showLogin();
  else startApp();
})();
