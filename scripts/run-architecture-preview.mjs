// Headless contact sheets of Architecture models: one PNG per style (or per scenario), one tile per render.
// node scripts/run-architecture-preview.mjs [base] [outDir] [--styles=a,b|none] [--scenarios=x,y] [--views=json] [--sheet=style|scenario]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const positional = process.argv.slice(2).filter(v => !v.startsWith('--'));
const flag = name => process.argv.find(v => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const base = positional[0] ?? 'http://127.0.0.1:5351';
const out = positional[1] ?? 'artifacts/architecture/preview';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-arch-preview-')), headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const errors = [], report = { results: [], errors };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.stack ?? e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warn' && process.env.ARCH_VERBOSE) console.log('warn', m.text()); });
  await page.goto(`${base}/scripts/architecture-preview.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => globalThis.__ARCH_PREVIEW_READY__ || globalThis.__ARCH_PREVIEW_ERROR__, { timeout: 180000 });
  const failure = await page.evaluate(() => globalThis.__ARCH_PREVIEW_ERROR__);
  if (failure) throw new Error(failure);
  const info = await page.evaluate(() => ({ styles: globalThis.__ARCH_PREVIEW__.STYLE_IDS, scenarios: globalThis.__ARCH_PREVIEW__.scenarios, W: globalThis.__ARCH_PREVIEW__.W, H: globalThis.__ARCH_PREVIEW__.H }));
  await page.setViewport({ width: info.W, height: info.H, deviceScaleFactor: 1 });
  const styles = flag('styles') ? flag('styles').split(',').map(s => s === 'none' ? '' : s) : ['', ...info.styles];
  const scenarios = flag('scenarios') ? flag('scenarios').split(',') : info.scenarios;
  const views = flag('views') ? JSON.parse(flag('views')) : [{}];
  const sheet = flag('sheet') ?? 'style';
  const tiles = new Map();
  for (const style of styles) for (const scenario of scenarios) for (const [vi, view] of views.entries()) {
    const result = await page.evaluate(options => globalThis.__ARCH_PREVIEW__.render(options), { scenario, style, ...view });
    report.results.push(result);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: info.W, height: info.H } });
    const key = sheet === 'scenario' ? scenario : (style || 'none');
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push({ label: `${style || 'unstyled'} · ${scenario}${views.length > 1 ? ` · v${vi}` : ''} · ${result.triangles} tris · ${result.buildMs} ms`, data: Buffer.from(png).toString('base64') });
    console.log('ARCH', JSON.stringify(result));
  }
  const compose = await browser.newPage();
  for (const [key, list] of tiles) {
    const columns = Math.min(4, list.length), tw = 560, th = Math.round(tw * info.H / info.W);
    await compose.setViewport({ width: columns * tw, height: Math.ceil(list.length / columns) * (th + 20), deviceScaleFactor: 1 });
    await compose.setContent(`<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(${columns},${tw}px);font:12px system-ui;color:#eee">${list.map(t => `<div><div style="height:20px;line-height:20px;padding-left:6px">${t.label}</div><img width="${tw}" height="${th}" src="data:image/png;base64,${t.data}" style="display:block"></div>`).join('')}</body>`, { waitUntil: 'load' });
    await compose.screenshot({ path: `${out}/${key}.png`, fullPage: true });
  }
  if (errors.length) console.log('PAGE ERRORS', JSON.stringify(errors.slice(0, 10), null, 1));
} finally {
  fs.writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
