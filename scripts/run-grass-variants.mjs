import puppeteer from 'puppeteer-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const base = 'http://localhost:1420';
const outDir = 'C:/Users/KHUDII~1/AppData/Local/Temp/claude/C--Users-Khudiiash-Documents-JS-engine/1aa7d815-bb78-437c-85f5-3ad5bb036c8b/scratchpad';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-grass-var-')), headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox'] });
for (const variant of (process.argv[2] ?? ',flat,normal,both').split(',')) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 1920, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/scripts/grass-angles.html?variant=${variant}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__GRASS_ANGLES_READY__ || globalThis.__GRASS_ANGLES_ERROR__, { timeout: 120000 });
  const err = await page.evaluate(() => globalThis.__GRASS_ANGLES_ERROR__);
  if (err) { console.log(variant || 'shipped', 'ERROR', err.split('\n')[0]); await page.close(); continue; }
  const means = await page.evaluate(() => globalThis.__GRASS_ANGLES__.means);
  const png = await page.evaluate(() => globalThis.__GRASS_ANGLES__.png);
  fs.writeFileSync(path.join(outDir, `grass-variant-${variant || 'shipped'}.png`), Buffer.from(png.split(',')[1], 'base64'));
  console.log((variant || 'shipped').padEnd(8), 'eye', means.eye.toFixed(3), 'down', means.down.toFixed(3), 'ratio', (means.down / means.eye).toFixed(2), 'grassFrac', means.eyeFraction.toFixed(2), means.downFraction.toFixed(2), errors.length ? errors[0] : '');
  await page.close();
}
await browser.close();
