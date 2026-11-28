// A visible tracker page picks up a board change from the server without a reload,
// via polling /api/health?rev and then /api/sync.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_DIR, shot } from './paths.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const PORT = 8097, SERVER = `http://127.0.0.1:${PORT}/`, TOKEN = 'live-sync-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const tmp = mkdtempSync(join(tmpdir(), 'live-sync-e2e-'));
const py = process.env.PYTHON || join(SERVER_DIR, '..', '.venv-server', 'bin', 'python');
const srv = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--port', String(PORT)], {
  cwd: SERVER_DIR, env: { ...process.env, FITNESS_DB: join(tmp, 'f.db'), FITNESS_API_TOKEN: TOKEN }, stdio: 'ignore' });
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const req = (m, u, b) => fetch(SERVER + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
try {
  for (let i = 0; i < 50; i++) { try { await req('GET', 'api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  await ctx.addInitScript(() => { window.FT_REV_POLL_MS = 400; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  await page.goto(SERVER);
  await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent.startsWith('Синхронизировано'));
  await page.evaluate(() => { window.__stay = 1; });
  const rev0 = (await req('GET', 'api/health')).rev;
  const t0 = Date.now();
  await req('POST', 'api/sync', { since: rev0, records: [{
    date: today, updated_at: Date.now(),
    sets: { pullups: { cells: [{ reps: 42, src: 'manual' }] } },
    distance: {},
  }] });
  await page.waitForFunction(() => {
    const s = FT.Store.view(FT.localDate());
    return !!(s.sets.pullups && s.sets.pullups.cells && s.sets.pullups.cells.some((c) => c.reps === 42));
  }, null, { timeout: 8000 });
  const dt = Date.now() - t0;
  const stay = await page.evaluate(() => window.__stay);
  const text = (await page.textContent('#daySummary')) || '';
  ok(stay === 1, 'page was not reloaded');
  ok(/подтягивания 42/.test(text.replace(/\s+/g, ' ')), 'today board updated in place: ' + text.replace(/\s+/g, ' '));
  ok(dt < 8000, 'appeared in ' + dt + ' ms');
  console.log('latency_ms', dt);
  await page.screenshot({ path: shot('live-sync-today.png') });
  await browser.close();
} finally { srv.kill(); }
