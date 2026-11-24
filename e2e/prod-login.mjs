// Smoke-test login against a running server (local or remote).
// Env: SERVER (default http://127.0.0.1:8010/), FITNESS_API_TOKEN (required).
import { chromium } from 'playwright-core';
import { shot } from './paths.mjs';

const TOKEN = process.env.FITNESS_API_TOKEN || '';
const SERVER = process.env.SERVER || 'http://127.0.0.1:8010/';
if (!TOKEN) {
  console.error('Set FITNESS_API_TOKEN');
  process.exit(1);
}

const executable = process.env.CHROME_PATH || undefined;
const b = await chromium.launch({ executablePath: executable, args: ['--no-sandbox'] });
const p = await (await b.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 1100, height: 900 } })).newPage();
await p.goto(SERVER);
await p.fill('#loginToken', 'wrong'); await p.click('#loginBtn');
await p.waitForFunction(() => document.querySelector('#loginError').textContent.length > 0);
console.log('wrong token:', await p.textContent('#loginError'));
await p.fill('#loginToken', TOKEN); await p.click('#loginBtn');
await p.waitForSelector('#app:not(.hidden)');
await p.waitForFunction(() => /Синхронизировано|Нет синхр/.test(document.querySelector('#syncStatus').textContent), null, { timeout: 15000 });
console.log('status:', await p.textContent('#syncStatus'), '| boxes:', (await p.$$('#checklist input[type=checkbox]')).length);
await p.click('.tabs button[data-tab=stats]'); await p.waitForTimeout(2500);
console.log('stats offline banner hidden:', await p.$eval('#statsOffline', (e) => e.classList.contains('hidden')));
await p.screenshot({ path: shot('prod-login.png') });
await b.close();
