import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { SERVER_DIR } from './paths.mjs';
const SERVER = 'http://127.0.0.1:8090/fitness/', TOKEN = 'localtest-token';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
// seed (fresh DB): two synthetic runs with GPS track + verified ACC upload
execSync(`cd ${SERVER_DIR} && python3 - <<'PY'
import sys, json, zlib, base64, hashlib, urllib.request, datetime
sys.path.insert(0, 'tests'); sys.path.insert(0, '.')
from test_acc import synth
S = '${SERVER}'; H = {'Authorization': 'Bearer ${TOKEN}', 'Content-Type': 'application/json'}
def req(m, u, b=None):
    r = urllib.request.Request(S + u, method=m, headers=H, data=json.dumps(b).encode() if b is not None else None)
    return json.loads(urllib.request.urlopen(r).read() or 'null')
for k, (wid, days, tc) in enumerate([('wdyn000', 3, 0.27), ('wdyn001', 0, 0.25)]):
    d, f, n = synth(dur=300, tc=tc, seed=k + 1); d = d[:n * 6]
    t0 = 1795515945678 - days * 86400000; st = t0 - 2000
    f = chr(10).join(l.split(',')[0] + ',' + l.split(',')[1] + ',' + str(int(l.split(',')[2]) - days * 86400000) for l in f.splitlines() if int(l.split(',')[0]) <= n) + chr(10)
    v = 170 / 60 * 1.0
    track = [[s, 55.0 + max(0, s - 12) * v / 111320.0, 37.0, 4] for s in range(0, 301)]
    date = datetime.datetime.fromtimestamp(st / 1000).date().isoformat()
    req('PUT', 'api/workouts/' + wid, {'id': wid, 'updated_at': st + 300000, 'type': 'run', 'date': date, 'started_at': st, 'ended_at': st + 300000, 'duration_s': 300, 'moving_s': 288,
        'distance_m': round(288 * v), 'gps_distance_m': round(288 * v), 'gps_ok': True, 'steps': 816, 'track': track, 'hr': {'avg': 150, 'max': 165, 'min': 90}, 'samples': []})
    aid = 'a' + wid
    for off in range(0, len(d), 524288):
        c = d[off:off + 524288]
        req('PUT', f'api/acc/{aid}/chunk?file=data&offset={off}', {'b64': base64.b64encode(zlib.compress(c)).decode(), 'crc32': zlib.crc32(c), 'len': len(c)})
    req('PUT', f'api/acc/{aid}/chunk?file=frames&offset=0', {'b64': base64.b64encode(zlib.compress(f.encode())).decode()})
    req('POST', f'api/acc/{aid}/finish', {'samples': n, 'fs': 200, 'workout_id': wid, 'started_at': st, 'sha256_data': hashlib.sha256(d).hexdigest()})
PY`);
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
await page.goto(SERVER);
await page.waitForSelector('#loginToken', { state: 'visible' }); await page.fill('#loginToken', TOKEN); await page.click('#loginBtn');
await page.waitForSelector('#app:not(.hidden)');
await page.click('.tabs button[data-tab=workout]');
await page.waitForSelector('.wk-item[data-id=wdyn001]', { timeout: 15000 });
await page.click('.wk-item[data-id=wdyn001]');
await page.waitForSelector('#wkDynamics:not(.hidden) .rec-metrics', { timeout: 10000 });
const txt = await page.textContent('#wkDynamics');
ok(/Время опоры/.test(txt) && /2[45][0-9]/.test(txt) && /точность: высокая/.test(txt) && /GPS ÷ шаги/.test(txt), 'dynamics block in workout detail: ' + txt.slice(0, 600).replace(/\s+/g, ' '));
await page.waitForTimeout(500);
await (await page.$('#wkDynamics')).screenshot({ path: '../screenshot-dynamics-detail.png' });
await page.click('.tabs button[data-tab=stats]');
await page.waitForSelector('#dynTrend:not(.hidden)', { timeout: 15000 });
await page.waitForFunction(() => window.Chart && Chart.getChart('dynChart') && !document.getElementById('dynCadChart'), null, { timeout: 10000 });
const trend = await page.evaluate(() => {
  const d = Chart.getChart('dynChart');
  if (!d) return null;
  const by = (id) => d.data.datasets.find((x) => x.yAxisID === id);
  const sc = d.options.scales;
  const tickColor = (id) => sc[id] && sc[id].ticks && sc[id].ticks.color;
  return {
    labels: d.data.datasets.map((x) => x.label),
    ids: d.data.datasets.map((x) => x.yAxisID),
    axes: Object.keys(sc).filter((k) => k !== 'x'),
    colors: {
      vo: [by('yVo') && by('yVo').borderColor, tickColor('yVo')],
      impact: [by('yImp') && by('yImp').borderColor, tickColor('yImp')],
      gct: [by('yGct') && by('yGct').borderColor, tickColor('yGct')],
      cad: [by('yCad') && by('yCad').borderColor, tickColor('yCad')],
    },
    cad: { min: sc.yCad && sc.yCad.min, max: sc.yCad && sc.yCad.max, data: (by('yCad') || {}).data, title: sc.yCad && sc.yCad.title && sc.yCad.title.text },
    gct: { min: sc.yGct && sc.yGct.min, max: sc.yGct && sc.yGct.max, data: (by('yGct') || {}).data },
    impact: { data: ((by('yImp') || {}).data || []).filter((v) => v != null) },
    noCadChart: !document.getElementById('dynCadChart') && !document.getElementById('dynCadTitle'),
  };
});
ok(trend && trend.noCadChart, 'separate cadence chart is gone');
ok(trend && !trend.labels.some((s) => /соотношен/.test(s)) && trend.labels.includes('удар, g') && trend.labels.includes('каденс, шаг/мин') && trend.labels.includes('колебания, см') && trend.labels.includes('время опоры, мс'),
  'four series, no vertical ratio: ' + JSON.stringify(trend && trend.labels));
ok(trend && ['yVo', 'yImp', 'yGct', 'yCad'].every((id) => trend.ids.includes(id)), 'four independent axes: ' + JSON.stringify(trend && trend.ids));
ok(trend && trend.colors.vo[0] === trend.colors.vo[1] && trend.colors.impact[0] === trend.colors.impact[1] && trend.colors.gct[0] === trend.colors.gct[1] && trend.colors.cad[0] === trend.colors.cad[1],
  'axis tick colors match the lines: ' + JSON.stringify(trend && trend.colors));
ok(trend && trend.cad.title === 'шаг/мин' && trend.cad.data.length >= 2 && (trend.cad.max - trend.cad.min) >= 25,
  `cadence axis is readable: data ${trend && trend.cad.data}, axis ${trend && trend.cad.min}–${trend && trend.cad.max}`);
ok(trend && trend.gct.data.length >= 1 && (trend.gct.max - trend.gct.min) >= 60,
  `GCT axis has a sensible span: data ${trend && trend.gct.data}, axis ${trend && trend.gct.min}–${trend && trend.gct.max}`);
ok(trend && trend.impact.data.length >= 1, 'landing impact series is present: ' + JSON.stringify(trend && trend.impact.data));
await page.waitForTimeout(400);
await (await page.$('#dynTrend')).screenshot({ path: '../screenshot-dynamics-trend.png' });
await browser.close();
console.log(process.exitCode ? 'DYN FAILED' : 'DYN PASSED');
