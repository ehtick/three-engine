import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:1420';
const out = process.argv[3] ?? 'C:/Users/KHUDII~1/AppData/Local/Temp/claude/C--Users-Khudiiash-Documents-JS-engine/1aa7d815-bb78-437c-85f5-3ad5bb036c8b/scratchpad/grass-angles.png';
fs.mkdirSync(path.dirname(out), { recursive: true });

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engine-grass-angles-')), headless: 'new',
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
  console.error('GRASS ANGLES: Chrome would not start after 3 attempts (GPU likely held by the editor):', lastError?.message ?? lastError);
  process.exit(1);
}
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 1920, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.stack ?? e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/scripts/grass-angles.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__GRASS_ANGLES_READY__ || globalThis.__GRASS_ANGLES_ERROR__, { timeout: 120000 });
  const failure = await page.evaluate(() => globalThis.__GRASS_ANGLES_ERROR__);
  if (failure) throw new Error(failure);
  const result = await page.evaluate(() => {
    const { straightDown, threeQuarter, threeQuarterRowProfile } = globalThis.__GRASS_ANGLES__;
    return { straightDown, threeQuarter, threeQuarterRowProfile };
  });
  const dataUrl = await page.evaluate(() => globalThis.__GRASS_ANGLES__.png);
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log('GRASS ANGLES PASS', JSON.stringify(result, null, 2));
} catch (error) {
  console.error('GRASS ANGLES FAIL', error.message ?? error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
