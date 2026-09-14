import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5335';
const out = process.argv[3] ?? 'C:/Users/KHUDII~1/AppData/Local/Temp/claude/C--Users-Khudiiash-Documents-JS-engine/1aa7d815-bb78-437c-85f5-3ad5bb036c8b/scratchpad/grass-contrast.png';
fs.mkdirSync(path.dirname(out), { recursive: true });

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-grass-preview-')), headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--no-sandbox', ...extraArgs],
  });
}

let browser;
const attempts = [[], ['--use-angle=swiftshader'], ['--use-angle=swiftshader', '--use-gl=swiftshader']];
let lastError;
for (const args of attempts) {
  try { browser = await launch(args); lastError = null; break; }
  catch (error) { lastError = error; }
}
if (!browser) {
  console.error('GRASS PREVIEW: Chrome would not start after 3 attempts (GPU likely held by the editor):', lastError?.message ?? lastError);
  process.exit(1);
}
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 400, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.stack ?? e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/scripts/grass-preview.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__GRASS_PREVIEW_READY__ || globalThis.__GRASS_PREVIEW_ERROR__, { timeout: 120000 });
  const failure = await page.evaluate(() => globalThis.__GRASS_PREVIEW_ERROR__);
  if (failure) throw new Error(failure);
  const result = await page.evaluate(() => {
    const { stats, rings, debugMaxStep, debugBlockStep, isotropyRatio, contrastReceipt, orbitReceipt } = globalThis.__GRASS_PREVIEW__;
    return { stats, rings, debugMaxStep, debugBlockStep, isotropyRatio, contrastReceipt, orbitReceipt };
  });
  // The 09-13 "blobs, not rectangles" receipt (4 m above, 30° sun, orthographic
  // so the 1 m box filter is exact) is what gets saved to `out` — this is the
  // frame an owner's screenshot verdict was taken against, not the multi-panel
  // debug strip.
  const dataUrl = await page.evaluate(() => globalThis.__GRASS_PREVIEW__.contrastPng);
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log('GRASS PREVIEW PASS', JSON.stringify(result));
} catch (error) {
  console.error('GRASS PREVIEW FAIL', error.message ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
