// v1.5.1: pull-ups and push-ups each get their own chart (own Y scale) in Статистика
import { chromium } from 'playwright-core';
import { shot } from './paths.mjs';
const SERVER = 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto(SERVER);
await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
await page.waitForSelector('#app:not(.hidden)'); await page.waitForTimeout(1500);
// three weeks of realistic data: ~18 pull-ups, ~90 push-ups a day
await page.evaluate(() => {
  for (let i = 20; i >= 1; i--) {
    if (i % 4 === 0) continue;
    const d = new Date(); d.setDate(d.getDate() - i); const k = FT.localDate(d); const r = FT.Store.view(k);
    const n = 4 + (i % 4);
    if (r.sets.pullups) { r.sets.pullups.reps = 3; r.sets.pullups.done = r.sets.pullups.done.map((_, j) => j < n); }
    if (r.sets.pushups) { r.sets.pushups.reps = 15; r.sets.pushups.done = r.sets.pushups.done.map((_, j) => j < n); }
    FT.Store.put(r);
  }
  FT.Sync.schedule(10);
});
await page.waitForTimeout(3000);
await page.click('.tabs button[data-tab=stats]'); await page.waitForTimeout(2500);
const info = await page.evaluate(() => ['repsChart-pullups', 'repsChart-pushups', 'dailyChart-pullups', 'dailyChart-pushups'].map((id) => {
  const c = Chart.getChart(id); return c ? { id, ds: c.data.datasets.length, max: c.scales.y.max } : { id, missing: true };
}));
ok(info.every((x) => !x.missing && x.ds === 1), 'separate charts: ' + JSON.stringify(info));
ok(info[1].max > info[0].max * 2 && info[3].max > info[2].max * 2, 'each has its own Y scale');
ok(!(await page.$('#repsChart')) && !(await page.$('#dailyChart')), 'old combined canvases gone');
await page.click('#periodSeg button[data-period=month]'); await page.waitForTimeout(1200);
ok(await page.evaluate(() => !!Chart.getChart('repsChart-pullups') && document.querySelectorAll('#repsCharts canvas').length === 2), 'period switch re-renders the two charts');
await page.click('#periodSeg button[data-period=week]'); await page.waitForTimeout(1200);
const panel = page.locator('#repsCharts').locator('xpath=..');
await panel.scrollIntoViewIfNeeded();
await page.screenshot({ path: shot('screenshot-stats-split.png'), fullPage: true });
await panel.screenshot({ path: shot('screenshot-stats-split-reps.png') });
await page.locator('#dailyCharts').locator('xpath=..').screenshot({ path: shot('screenshot-stats-split-daily.png') });
await browser.close();
console.log(process.exitCode ? 'STATS SPLIT FAILED' : 'STATS SPLIT PASSED');
